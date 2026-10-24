'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { AppError } = require('../lib/errors');
const { hashFile } = require('../lib/hash');
const { getPlatform, PLATFORMS, REGIONS, normalizeRegion } = require('../../../config/platforms');

const MAX_BIOS_BYTES = 512 * 1024 * 1024;

const CUSTOM_SIZE_RULES = Object.freeze({
  ps1: { bios: [524288] },
  ps2: { bios: [4194304] },
  xbox: { bootrom: [512], flash: [262144, 1048576] },
  ps3: { firmware: null },
  gb: { bootrom: [256, 2304] },
});

function publicBios(row) {
  return {
    id: row.id,
    platformId: row.platform_id,
    platformName: PLATFORMS[row.platform_id]?.shortName ?? row.platform_id,
    region: row.region,
    regionLabel: REGIONS[row.region]?.label ?? row.region,
    kind: row.kind,
    label: row.label,
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
    md5: row.md5,
    sha1: row.sha1,
    status: row.file_exists === 0 ? 'missing' : row.status,
    isCustom: Boolean(row.is_custom),
    verificationMethod: row.verification_method ?? 'catalog-md5',
    verifiedAt: row.verified_at,
  };
}

class BiosService {
  constructor({ db, paths, catalog, logger }) {
    this.db = db;
    this.paths = paths;
    this.catalog = catalog;
    this.logger = logger;
  }

  list() {
    const rows = this.db.all(
      `SELECT b.*
       FROM bios_files b
       ORDER BY b.platform_id, b.region, b.kind, b.label`,
    );
    return rows.map((row) => publicBios({ ...row, file_exists: fs.existsSync(row.file_path) ? 1 : 0 }));
  }

  async importFromFile(sourcePath, { platformHint = null } = {}) {
    if (!sourcePath || typeof sourcePath !== 'string') {
      throw new AppError('BIOS_FILE_REQUIRED', 'Selecione um arquivo de BIOS.');
    }
    let stat;
    try {
      stat = await fs.promises.stat(sourcePath);
    } catch {
      throw new AppError('BIOS_FILE_NOT_FOUND', 'Arquivo de BIOS não encontrado.');
    }
    if (!stat.isFile()) throw new AppError('BIOS_NOT_FILE', 'A BIOS deve ser um arquivo regular.');
    if (stat.size <= 0 || stat.size > MAX_BIOS_BYTES) {
      throw new AppError('BIOS_INVALID_SIZE', 'Tamanho de BIOS inválido ou acima do limite.');
    }

    const hashes = await hashFile(sourcePath, { algorithms: ['md5', 'sha1'] });
    const entry = this.catalog.match(hashes.md5, platformHint);
    if (!entry) {
      throw new AppError(
        'BIOS_HASH_NOT_RECOGNIZED',
        'O hash não corresponde a uma BIOS conhecida para esta plataforma. Nenhum arquivo foi importado.',
        { md5: hashes.md5, sha1: hashes.sha1 },
      );
    }
    if (stat.size !== entry.size) {
      throw new AppError(
        'BIOS_SIZE_MISMATCH',
        `A BIOS "${entry.label}" deveria ter ${entry.size} bytes; o arquivo tem ${stat.size}.`,
        { expected: entry.size, actual: stat.size },
      );
    }
    if (entry.sha1 && hashes.sha1 !== entry.sha1) {
      throw new AppError('BIOS_HASH_MISMATCH', 'SHA-1 não confere com o catálogo.');
    }

    const existing = this.db.get('SELECT * FROM bios_files WHERE platform_id = ? AND md5 = ? AND kind = ?', [
      entry.platform,
      entry.md5,
      entry.kind,
    ]);
    if (existing) return publicBios({ ...existing, file_exists: 1 });

    const destination = this.paths.biosPath(entry.platform, entry.label, entry.md5);
    this.paths.assertBiosPath(destination.filePath);
    fs.mkdirSync(destination.directory, { recursive: true });
    await fs.promises
      .copyFile(sourcePath, destination.filePath, fs.constants.COPYFILE_EXCL)
      .catch(async (error) => {
        if (error.code !== 'EEXIST') throw error;
        const existingHash = await hashFile(destination.filePath, { algorithms: ['md5'] });
        if (existingHash.md5 !== entry.md5) {
          throw new AppError('BIOS_DEST_CONFLICT', 'Já existe um arquivo diferente no destino da BIOS.');
        }
      });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO bios_files (
        id, platform_id, region, kind, label, file_name, file_path, size_bytes,
        md5, sha1, status, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?)`,
      [
        id,
        entry.platform,
        entry.region,
        entry.kind,
        entry.label,
        destination.filePath.split(/[\\/]/).pop(),
        destination.filePath,
        stat.size,
        hashes.md5,
        hashes.sha1,
        now,
      ],
    );
    this.logger?.info('bios', 'BIOS importada e validada por hash.', {
      platform: entry.platform,
      kind: entry.kind,
      md5: hashes.md5,
    });
    return this.getById(id);
  }

  /**
   * Importa um dump legítimo do próprio usuário que não está no catálogo.
   * O usuário atesta plataforma/região/tipo; o sistema continua exigindo
   * tamanho plausível, calcula os hashes e os revalida em cada boot.
   */
  async importCustomFromFile(
    sourcePath,
    { platformId, region, kind, label = '', acknowledged = false } = {},
  ) {
    if (acknowledged !== true) {
      throw new AppError(
        'BIOS_CUSTOM_ACK_REQUIRED',
        'Confirme que o arquivo foi extraído do seu próprio hardware ou de uma fonte licenciada.',
      );
    }
    const platform = getPlatform(platformId);
    const normalizedRegion = normalizeRegion(region);
    if (normalizedRegion === 'unknown') {
      throw new AppError('BIOS_CUSTOM_REGION_REQUIRED', 'Selecione a região da BIOS personalizada.');
    }
    if (!platform.bios.kinds.includes(kind)) {
      throw new AppError(
        'BIOS_CUSTOM_KIND_INVALID',
        `O tipo "${kind}" não se aplica a ${platform.shortName}. Tipos aceitos: ${platform.bios.kinds.join(', ')}.`,
      );
    }
    if (!platform.bios.regions.includes(normalizedRegion) && normalizedRegion !== 'global') {
      throw new AppError(
        'BIOS_CUSTOM_REGION_INVALID',
        `Região inválida para ${platform.shortName}. Use ${platform.bios.regions.join(', ')}.`,
      );
    }

    if (!sourcePath || typeof sourcePath !== 'string') {
      throw new AppError('BIOS_FILE_REQUIRED', 'Selecione o arquivo da BIOS personalizada.');
    }
    let stat;
    try {
      stat = await fs.promises.stat(sourcePath);
    } catch {
      throw new AppError('BIOS_FILE_NOT_FOUND', 'Arquivo de BIOS não encontrado.');
    }
    if (!stat.isFile()) throw new AppError('BIOS_NOT_FILE', 'A BIOS deve ser um arquivo regular.');
    if (stat.size <= 0 || stat.size > MAX_BIOS_BYTES) {
      throw new AppError('BIOS_INVALID_SIZE', 'Tamanho de BIOS inválido ou acima do limite de 512 MB.');
    }

    const rules = CUSTOM_SIZE_RULES[platform.id]?.[kind];
    if (Array.isArray(rules) && !rules.includes(stat.size)) {
      throw new AppError(
        'BIOS_CUSTOM_SIZE_INVALID',
        `Tamanho incompatível para ${platform.shortName} ${kind.toUpperCase()}. Esperado: ${rules
          .map((size) => `${size} bytes`)
          .join(' ou ')}; recebido: ${stat.size}.`,
        { expected: rules, actual: stat.size },
      );
    }

    const hashes = await hashFile(sourcePath, { algorithms: ['md5', 'sha1'] });
    const known = this.catalog.match(hashes.md5, platform.id);
    const knownRegionCompatible =
      known &&
      (known.region === normalizedRegion || known.region === 'global' || normalizedRegion === 'global');
    if (known && (known.kind !== kind || !knownRegionCompatible)) {
      throw new AppError(
        'BIOS_CATALOG_MISMATCH',
        `O hash corresponde à BIOS conhecida "${known.label}" (${known.kind}/${known.region}). Use a importação automática para preservar esses metadados.`,
      );
    }

    const effective = known ?? {
      platform: platform.id,
      region: normalizedRegion,
      kind,
      label:
        String(label ?? '')
          .replace(/[\u0000-\u001f]/g, '')
          .trim()
          .slice(0, 120) || `${platform.shortName} ${kind.toUpperCase()} personalizada`,
    };

    const existing = this.db.get('SELECT * FROM bios_files WHERE platform_id = ? AND md5 = ? AND kind = ?', [
      effective.platform,
      hashes.md5,
      effective.kind,
    ]);
    if (existing) return this.getById(existing.id);

    const destination = this.paths.biosPath(effective.platform, effective.label, hashes.md5);
    this.paths.assertBiosPath(destination.filePath);
    fs.mkdirSync(destination.directory, { recursive: true });
    await fs.promises
      .copyFile(sourcePath, destination.filePath, fs.constants.COPYFILE_EXCL)
      .catch(async (error) => {
        if (error.code !== 'EEXIST') throw error;
        const existingHash = await hashFile(destination.filePath, { algorithms: ['md5'] });
        if (existingHash.md5 !== hashes.md5) {
          throw new AppError('BIOS_DEST_CONFLICT', 'Já existe um arquivo diferente no destino da BIOS.');
        }
      });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const isCustom = known ? 0 : 1;
    this.db.run(
      `INSERT INTO bios_files (
        id, platform_id, region, kind, label, file_name, file_path, size_bytes,
        md5, sha1, status, verified_at, is_custom, verification_method
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?, ?, ?)`,
      [
        id,
        effective.platform,
        effective.region,
        effective.kind,
        effective.label,
        destination.filePath.split(/[\\/]/).pop(),
        destination.filePath,
        stat.size,
        hashes.md5,
        hashes.sha1,
        now,
        isCustom,
        isCustom ? 'user-attested-hash' : 'catalog-md5',
      ],
    );
    this.logger?.info('bios', isCustom ? 'BIOS personalizada importada.' : 'BIOS conhecida importada.', {
      platform: effective.platform,
      kind: effective.kind,
      region: effective.region,
      md5: hashes.md5,
      custom: Boolean(isCustom),
    });
    return this.getById(id);
  }

  getById(id) {
    const row = this.db.get('SELECT * FROM bios_files WHERE id = ?', [id]);
    if (!row) throw new AppError('BIOS_NOT_FOUND', 'BIOS não encontrada.');
    return publicBios(row);
  }

  remove(id) {
    const row = this.db.get('SELECT * FROM bios_files WHERE id = ?', [id]);
    if (!row) throw new AppError('BIOS_NOT_FOUND', 'BIOS não encontrada.');
    this.paths.assertBiosPath(row.file_path);
    this.db.run('DELETE FROM bios_files WHERE id = ?', [id]);
    fs.promises.unlink(row.file_path).catch(() => {});
    this.logger?.info('bios', 'BIOS removida do gerenciador.', { id, platform: row.platform_id });
  }

  /**
   * Valida novamente os arquivos no momento da execução. Hash divergente
   * invalida o registro e impede o boot.
   */
  async resolveForGame(game) {
    const platform = getPlatform(game.platformId);
    const requiredKinds = platform.bios.kinds ?? [];
    if (requiredKinds.length === 0) return [];

    if (platform.bios.required && (!game.region || game.region === 'unknown')) {
      throw new AppError(
        'BIOS_REGION_REQUIRED',
        'Defina a região do jogo antes de iniciar; a BIOS é validada por região.',
      );
    }

    const resolved = [];
    for (const kind of requiredKinds) {
      const rows = this.db.all(
        `SELECT * FROM bios_files
         WHERE platform_id = ? AND kind = ? AND status = 'valid'
           AND (region = ? OR region = 'global')
         ORDER BY CASE WHEN region = ? THEN 0 ELSE 1 END, verified_at DESC`,
        [platform.id, kind, game.region, game.region],
      );
      if (rows.length === 0) {
        if (!platform.bios.required) continue;
        throw new AppError(
          'BIOS_REQUIRED',
          `Nenhuma BIOS válida do tipo "${kind}" para ${platform.name} (${game.region}). Importe e valide uma BIOS antes de jogar.`,
          { platformId: platform.id, region: game.region, kind },
        );
      }
      resolved.push(await this.#verifyRow(rows[0]));
    }

    // PS3/Game Boy: firmware/boot ROM opcionais, retornados apenas se válidos.
    if (resolved.length === 0 && platform.bios.optional) {
      const rows = this.db.all(
        `SELECT * FROM bios_files
         WHERE platform_id = ? AND status = 'valid' AND (region = ? OR region = 'global')
         ORDER BY verified_at DESC`,
        [platform.id, game.region ?? 'global'],
      );
      if (rows.length > 0) resolved.push(await this.#verifyRow(rows[0]));
    }
    return resolved;
  }

  async #verifyRow(row) {
    this.paths.assertBiosPath(row.file_path);
    let stat;
    try {
      stat = await fs.promises.stat(row.file_path);
    } catch {
      this.db.run("UPDATE bios_files SET status = 'missing' WHERE id = ?", [row.id]);
      throw new AppError('BIOS_FILE_MISSING', `Arquivo da BIOS "${row.label}" não existe mais.`);
    }
    if (stat.size !== row.size_bytes) {
      this.db.run("UPDATE bios_files SET status = 'invalid' WHERE id = ?", [row.id]);
      throw new AppError('BIOS_TAMPERED', `A BIOS "${row.label}" foi alterada no disco.`);
    }
    const hashes = await hashFile(row.file_path, { algorithms: ['md5', 'sha1'] });
    if (hashes.md5 !== row.md5 || hashes.sha1 !== row.sha1) {
      this.db.run("UPDATE bios_files SET status = 'invalid' WHERE id = ?", [row.id]);
      throw new AppError('BIOS_TAMPERED', `A BIOS "${row.label}" não passou na revalidação de hash.`);
    }
    return {
      id: row.id,
      kind: row.kind,
      region: row.region,
      label: row.label,
      path: row.file_path,
      md5: row.md5,
      sha1: row.sha1,
      systemFileName: this.catalog.byMd5.get(row.md5)?.systemFileName ?? row.file_name,
    };
  }

  getMatrix() {
    const installed = this.list().filter((bios) => bios.status === 'valid');
    return Object.values(PLATFORMS)
      .filter((platform) => platform.bios.kinds.length > 0)
      .map((platform) => {
        const regions = platform.bios.regions.map((region) => {
          const files = installed.filter(
            (bios) => bios.platformId === platform.id && (bios.region === region || bios.region === 'global'),
          );
          return {
            region,
            label: REGIONS[region]?.label ?? region,
            installed: files.length,
            kinds: [...new Set(files.map((file) => file.kind))],
          };
        });
        return {
          platformId: platform.id,
          platformName: platform.shortName,
          fullName: platform.name,
          required: platform.bios.required,
          recommended: Boolean(platform.bios.recommended),
          kinds: platform.bios.kinds,
          installedCount: installed.filter((bios) => bios.platformId === platform.id).length,
          ready:
            !platform.bios.required ||
            platform.bios.kinds.every((kind) =>
              installed.some((bios) => bios.platformId === platform.id && bios.kind === kind),
            ),
          regions,
        };
      });
  }
}

module.exports = { BiosService, publicBios };
