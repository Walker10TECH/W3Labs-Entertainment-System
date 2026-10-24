'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../lib/errors');
const { hashFile } = require('../lib/hash');
const { isInside } = require('../lib/paths');
const { detectIsoPlatform, platformFromPath } = require('./iso-detector');
const {
  PLATFORMS,
  REGIONS,
  getPlatform,
  platformForFile,
  normalizeRegion,
} = require('../../../config/platforms');

const MEDIA_EXTENSIONS = new Set(
  Object.values(PLATFORMS).flatMap((platform) => platform.extensions.map((ext) => ext.toLowerCase())),
);

function cleanTitle(fileName) {
  return String(fileName)
    .replace(/\.[^.]+$/, '')
    .replace(/\[[^\]]*]/g, ' ')
    .replace(/\([^)]*(?:usa|us|europe|eu|japan|jp|world|disc|cd|rev|beta|proto)[^)]*\)/gi, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

function detectRegion(fileName) {
  const lower = String(fileName).toLowerCase();
  if (/\b(usa|us|ntsc-u|america|canada)\b|\(u\)|\[u]/.test(lower)) return 'ntsc-u';
  if (/\b(japan|jp|ntsc-j|asia)\b|\(j\)|\[j]/.test(lower)) return 'ntsc-j';
  if (/\b(europe|eu|eur|pal)\b|\(e\)|\[e]/.test(lower)) return 'pal';
  if (/\b(world|global)\b/.test(lower)) return 'global';
  return 'unknown';
}

function detectSerial(fileName) {
  const match = String(fileName).match(/\b([A-Z]{4})[-_ ]?(\d{5})\b/);
  return match ? `${match[1]}-${match[2]}` : null;
}

function detectDiscNumber(fileName) {
  const match = String(fileName).match(/(?:disc|cd|disk)\s*([1-9])/i);
  return match ? Number(match[1]) : 1;
}

function mapGame(row) {
  return {
    id: row.id,
    platformId: row.platform_id,
    platformName: PLATFORMS[row.platform_id]?.shortName ?? row.platform_id,
    title: row.title,
    sortTitle: row.sort_title,
    fileName: row.file_name,
    filePath: row.file_path,
    fileSize: Number(row.file_size),
    romHash: row.rom_hash,
    romMd5: row.rom_md5,
    region: row.region,
    regionLabel: REGIONS[row.region]?.label ?? row.region,
    serial: row.serial,
    discNumber: row.disc_number,
    coverFile: row.cover_file,
    hasCover: Boolean(row.cover_file && fs.existsSync(row.cover_file)),
    coverUrl:
      row.cover_file && fs.existsSync(row.cover_file)
        ? `w3cover://cover/${row.id}?v=${encodeURIComponent(row.updated_at ?? '')}`
        : null,
    synopsis: row.synopsis,
    releaseYear: row.release_year,
    publisher: row.publisher,
    developer: row.developer,
    genre: row.genre,
    favorite: Boolean(row.favorite),
    isMissing: Boolean(row.is_missing),
    scrapeStatus: row.scrape_status,
    playtimeSeconds: Number(row.playtime_seconds ?? 0),
    lastPlayedAt: row.last_played_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function* walkFiles(directory, ignoredDirectories, signal = null) {
  const dir = await fs.promises.opendir(directory);
  try {
    for await (const entry of dir) {
      if (signal?.aborted) throw new AppError('SCAN_ABORTED', 'Escaneamento cancelado.');
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || ignoredDirectories.has(entry.name)) continue;
        yield* walkFiles(fullPath, ignoredDirectories, signal);
      } else if (entry.isFile()) {
        if (entry.name.startsWith('.')) continue;
        yield fullPath;
      }
    }
  } finally {
    await dir.close().catch(() => {});
  }
}

async function mapLimit(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

class LibraryService {
  constructor({ db, paths, logger, config, metadataService = null }) {
    this.db = db;
    this.paths = paths;
    this.logger = logger;
    this.config = config;
    this.metadataService = metadataService;
  }

  listRoots() {
    return this.db
      .all(
        `SELECT r.*, COUNT(g.id) AS game_count
         FROM library_roots r
         LEFT JOIN games g ON g.file_path LIKE r.path || '%' AND g.is_missing = 0
         GROUP BY r.id
         ORDER BY r.created_at`,
      )
      .map((row) => ({
        id: row.id,
        path: row.path,
        platformId: row.platform_id,
        recursive: Boolean(row.recursive),
        enabled: Boolean(row.enabled),
        lastScanAt: row.last_scan_at,
        gameCount: Number(row.game_count),
      }));
  }

  async addRoot(rootPath, platformId = null) {
    if (!rootPath) throw new AppError('LIBRARY_PATH_REQUIRED', 'Selecione uma pasta de jogos.');
    if (platformId) getPlatform(platformId);
    let real;
    try {
      real = await fs.promises.realpath(rootPath);
      const stat = await fs.promises.stat(real);
      if (!stat.isDirectory()) throw new Error('not dir');
    } catch {
      throw new AppError('LIBRARY_PATH_INVALID', 'A pasta selecionada não existe ou não é acessível.');
    }
    if (isInside(this.paths.saves, real) || isInside(this.paths.storage, real)) {
      throw new AppError(
        'LIBRARY_PATH_FORBIDDEN',
        'Não é permitido usar pastas internas do aplicativo como biblioteca.',
      );
    }
    const existing = this.db.get('SELECT id FROM library_roots WHERE path = ?', [real]);
    if (existing) {
      this.db.run('UPDATE library_roots SET enabled = 1, platform_id = ? WHERE id = ?', [
        platformId,
        existing.id,
      ]);
      return this.listRoots().find((root) => root.id === existing.id);
    }
    const id = crypto.randomUUID();
    this.db.run('INSERT INTO library_roots (id, path, platform_id) VALUES (?, ?, ?)', [id, real, platformId]);
    return this.listRoots().find((root) => root.id === id);
  }

  removeRoot(id) {
    this.db.run('DELETE FROM library_roots WHERE id = ?', [id]);
  }

  async scanAll({ onProgress = null, signal = null } = {}) {
    const roots = this.db.all('SELECT * FROM library_roots WHERE enabled = 1');
    const summary = { roots: roots.length, filesSeen: 0, gamesAdded: 0, gamesUpdated: 0, errors: [] };
    const progress = throttle((payload) => onProgress?.(payload), 150);

    for (const root of roots) {
      await this.scanRoot(root, { summary, onProgress: progress, signal });
    }
    progress.flush({
      phase: 'done',
      filesSeen: summary.filesSeen,
      gamesAdded: summary.gamesAdded,
      gamesUpdated: summary.gamesUpdated,
      errors: summary.errors.length,
    });
    this.logger?.info('library', 'Escaneamento concluído.', summary);
    return summary;
  }

  async scanRoot(root, { summary, onProgress, signal = null } = {}) {
    const startedAt = Date.now();
    const seen = new Set();
    const candidates = [];
    let filesSeen = 0;

    for await (const filePath of walkFiles(root.path, this.config.scanning.ignoredDirectories, signal)) {
      filesSeen += 1;
      let platformId = root.platform_id;
      if (!platformId) {
        const extension = path.extname(filePath).toLowerCase();
        if (['.iso', '.img', '.xiso'].includes(extension)) {
          platformId = (await detectIsoPlatform(filePath)) ?? platformForFile(filePath);
        } else if (extension === '.chd') {
          platformId = platformFromPath(filePath) ?? platformForFile(filePath);
        } else {
          platformId = platformForFile(filePath);
        }
      }
      if (!platformId || !MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase())) continue;
      candidates.push({ filePath, platformId });
      if (filesSeen % 25 === 0) {
        onProgress?.({
          phase: 'walking',
          root: root.path,
          filesSeen,
          queued: candidates.length,
        });
      }
    }

    let hashed = 0;
    await mapLimit(candidates, this.config.scanning.maxConcurrency, async ({ filePath, platformId }) => {
      if (signal?.aborted) throw new AppError('SCAN_ABORTED', 'Escaneamento cancelado.');
      seen.add(filePath);
      try {
        const stat = await fs.promises.stat(filePath);
        const existing = this.db.get('SELECT * FROM games WHERE file_path = ?', [filePath]);
        const unchanged =
          existing &&
          Number(existing.file_size) === stat.size &&
          Math.round(Number(existing.file_mtime_ms)) === Math.round(stat.mtimeMs);

        if (unchanged) {
          this.db.run(
            `UPDATE games SET platform_id = ?, is_missing = 0,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?`,
            [platformId, existing.id],
          );
          return;
        }

        hashed += 1;
        onProgress?.({
          phase: 'hashing',
          root: root.path,
          currentFile: path.basename(filePath),
          hashed,
          total: candidates.length,
          largeFile: stat.size > 2 * 1024 * 1024 * 1024,
        });
        const hashes = await hashFile(filePath, {
          algorithms: ['sha1', 'md5'],
          onProgress: ({ bytes, totalBytes }) => {
            onProgress?.({
              phase: 'hashing-media',
              root: root.path,
              currentFile: path.basename(filePath),
              bytes,
              totalBytes,
              percent: totalBytes > 0 ? Math.round((bytes / totalBytes) * 100) : 0,
              largeFile: stat.size > 2 * 1024 * 1024 * 1024,
            });
          },
        });
        const fileName = path.basename(filePath);
        const title = cleanTitle(fileName);
        const region = detectRegion(fileName);
        const id = existing?.id ?? crypto.randomUUID();
        const now = new Date().toISOString();
        this.db.run(
          `INSERT INTO games (
             id, platform_id, title, sort_title, file_path, file_name, file_size,
             file_mtime_ms, rom_hash, rom_md5, region, serial, disc_number,
             is_missing, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(file_path) DO UPDATE SET
             platform_id = excluded.platform_id,
             title = excluded.title,
             sort_title = excluded.sort_title,
             file_size = excluded.file_size,
             file_mtime_ms = excluded.file_mtime_ms,
             rom_hash = excluded.rom_hash,
             rom_md5 = excluded.rom_md5,
             region = CASE
               WHEN games.region = 'unknown' AND excluded.region <> 'unknown' THEN excluded.region
               ELSE games.region
             END,
             serial = COALESCE(excluded.serial, games.serial),
             disc_number = excluded.disc_number,
             is_missing = 0,
             updated_at = excluded.updated_at`,
          [
            id,
            platformId,
            title,
            title.toLocaleLowerCase('pt-BR'),
            filePath,
            fileName,
            stat.size,
            Math.round(stat.mtimeMs),
            hashes.sha1,
            hashes.md5,
            region,
            detectSerial(fileName),
            detectDiscNumber(fileName),
            now,
          ],
        );
        if (existing) {
          summary.gamesUpdated += 1;
        } else {
          summary.gamesAdded += 1;
        }
      } catch (error) {
        summary.errors.push({ file: filePath, message: error.message });
        this.logger?.warn('library', 'Falha ao indexar arquivo.', {
          file: filePath,
          error: error.message,
        });
      }
    });

    summary.filesSeen += filesSeen;
    this.#markMissing(root.path, seen);
    this.db.run(
      "UPDATE library_roots SET last_scan_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      [root.id],
    );
    onProgress?.({
      phase: 'root-done',
      root: root.path,
      filesSeen,
      indexed: seen.size,
      elapsedMs: Date.now() - startedAt,
    });
  }

  #markMissing(rootPath, seen) {
    const rows = this.db.all('SELECT id, file_path FROM games WHERE is_missing = 0');
    for (const row of rows) {
      if (!isInside(rootPath, row.file_path)) continue;
      if (!seen.has(row.file_path)) {
        this.db.run('UPDATE games SET is_missing = 1 WHERE id = ?', [row.id]);
      }
    }
  }

  list({ search = '', platformId = null, favorite = false, limit = 200, offset = 0 } = {}) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const term = `%${String(search).trim()}%`;
    const rows = this.db.all(
      `SELECT g.* FROM games g
       JOIN platforms p ON p.id = g.platform_id
       WHERE g.is_missing = 0
         AND (? = '' OR g.title LIKE ? COLLATE NOCASE
              OR COALESCE(g.genre, '') LIKE ? COLLATE NOCASE
              OR COALESCE(g.publisher, '') LIKE ? COLLATE NOCASE
              OR COALESCE(g.serial, '') LIKE ? COLLATE NOCASE
              OR p.name LIKE ? COLLATE NOCASE
              OR p.short_name LIKE ? COLLATE NOCASE)
         AND (? IS NULL OR g.platform_id = ?)
         AND (? = 0 OR g.favorite = 1)
       ORDER BY g.favorite DESC, g.sort_title COLLATE NOCASE
       LIMIT ? OFFSET ?`,
      [
        String(search).trim(),
        term,
        term,
        term,
        term,
        term,
        term,
        platformId,
        platformId,
        favorite ? 1 : 0,
        safeLimit,
        safeOffset,
      ],
    );
    return rows.map(mapGame);
  }

  get(id) {
    const row = this.db.get('SELECT * FROM games WHERE id = ?', [id]);
    if (!row) throw new AppError('GAME_NOT_FOUND', 'Jogo não encontrado na biblioteca.');
    return mapGame(row);
  }

  setFavorite(id, favorite) {
    this.db.run(
      "UPDATE games SET favorite = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      [favorite ? 1 : 0, id],
    );
    return this.get(id);
  }

  setRegion(id, region) {
    const normalized = normalizeRegion(region);
    if (normalized === 'unknown') {
      throw new AppError('INVALID_REGION', 'Região inválida.');
    }
    this.db.run(
      "UPDATE games SET region = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      [normalized, id],
    );
    return this.get(id);
  }

  setPlatform(id, platformId) {
    const platform = getPlatform(platformId);
    const row = this.db.get('SELECT * FROM games WHERE id = ?', [id]);
    if (!row) throw new AppError('GAME_NOT_FOUND', 'Jogo não encontrado na biblioteca.');
    const extension = path.extname(row.file_path).toLowerCase();
    if (!platform.extensions.includes(extension)) {
      throw new AppError(
        'PLATFORM_EXTENSION_MISMATCH',
        `A extensão ${extension} não é compatível com ${platform.shortName}.`,
      );
    }
    this.db.run(
      "UPDATE games SET platform_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      [platform.id, id],
    );
    this.logger?.info('library', 'Plataforma do jogo alterada manualmente.', {
      id,
      from: row.platform_id,
      to: platform.id,
    });
    return this.get(id);
  }

  removeFromLibrary(id) {
    const game = this.get(id);
    this.db.run('DELETE FROM games WHERE id = ?', [id]);
    this.logger?.info('library', 'Jogo removido da biblioteca; arquivo físico preservado.', {
      id,
      path: game.filePath,
    });
    return { removed: true, fileKept: true, filePath: game.filePath };
  }

  async verifyGameFile(id) {
    const game = this.get(id);
    let stat;
    try {
      stat = await fs.promises.stat(game.filePath);
    } catch {
      this.db.run('UPDATE games SET is_missing = 1 WHERE id = ?', [id]);
      throw new AppError('ROM_MISSING', 'O arquivo do jogo não está mais disponível.');
    }
    if (Number(stat.size) !== game.fileSize) {
      throw new AppError(
        'ROM_CHANGED',
        'O arquivo do jogo mudou depois do escaneamento. Reescaneie a pasta antes de iniciar.',
      );
    }
    return game;
  }

  stats() {
    const total = this.db.get(
      `SELECT COUNT(*) AS games,
              COALESCE(SUM(playtime_seconds), 0) AS playtime,
              COALESCE(SUM(favorite), 0) AS favorites
       FROM games WHERE is_missing = 0`,
    );
    const byPlatform = this.db.all(
      `SELECT platform_id, COUNT(*) AS games, COALESCE(SUM(playtime_seconds), 0) AS playtime
       FROM games WHERE is_missing = 0 GROUP BY platform_id`,
    );
    return {
      games: Number(total.games),
      playtimeSeconds: Number(total.playtime),
      favorites: Number(total.favorites),
      platforms: byPlatform.map((row) => ({
        platformId: row.platform_id,
        games: Number(row.games),
        playtimeSeconds: Number(row.playtime),
      })),
    };
  }

  recent(limit = 12) {
    return this.db
      .all(
        `SELECT * FROM games WHERE is_missing = 0 AND last_played_at IS NOT NULL
         ORDER BY last_played_at DESC LIMIT ?`,
        [Math.min(50, Number(limit) || 12)],
      )
      .map(mapGame);
  }
}

function throttle(fn, waitMs) {
  let last = 0;
  let pending = null;
  let timer = null;
  const run = () => {
    if (!pending) return;
    const payload = pending;
    pending = null;
    last = Date.now();
    fn(payload);
  };
  const wrapped = (payload) => {
    pending = payload;
    const elapsed = Date.now() - last;
    if (elapsed >= waitMs) {
      if (timer) clearTimeout(timer);
      timer = null;
      run();
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        run();
      }, waitMs - elapsed);
    }
  };
  wrapped.flush = (payload) => {
    pending = payload;
    if (timer) clearTimeout(timer);
    timer = null;
    run();
  };
  return wrapped;
}

module.exports = {
  LibraryService,
  cleanTitle,
  detectRegion,
  detectSerial,
  detectDiscNumber,
  mapGame,
  walkFiles,
};
