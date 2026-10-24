'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../lib/errors');
const { RateLimiter } = require('../lib/rate-limiter');

const SCREENSCRAPER_SYSTEMS = Object.freeze({
  ps1: '57',
  ps2: '58',
  ps3: '59',
  nes: '3',
  xbox: '14',
  gb: '9',
});

const IGDB_PLATFORMS = Object.freeze({
  ps1: 7,
  ps2: 8,
  ps3: 9,
  xbox: 11,
  nes: 18,
  gb: 33,
});

const ALLOWED_COVER_HOSTS = [
  'images.igdb.com',
  'screenscraper.fr',
  'www.screenscraper.fr',
  'media.screenscraper.fr',
  'api.screenscraper.fr',
];

function cleanText(value, maxLength = 8_000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : null;
}

function parseYear(value) {
  const year = Number(String(value ?? '').slice(0, 4));
  return Number.isInteger(year) && year >= 1970 && year <= 2100 ? year : null;
}

function preferredLanguage(items, key = 'text') {
  if (!Array.isArray(items)) return null;
  const priorities = ['pt', 'br', 'en', 'us'];
  for (const lang of priorities) {
    const found = items.find((item) =>
      String(item.langue ?? item.language ?? '')
        .toLowerCase()
        .startsWith(lang),
    );
    if (found) return found[key] ?? found.text ?? null;
  }
  return items[0]?.[key] ?? items[0]?.text ?? null;
}

class MetadataService {
  constructor({ db, paths, settings, logger, config, limiter = null, fetchImpl = globalThis.fetch }) {
    this.db = db;
    this.paths = paths;
    this.settings = settings;
    this.logger = logger;
    this.config = config;
    this.fetch = fetchImpl;
    this.limiter =
      limiter ??
      new RateLimiter({
        maxRequests: config.metadata.requestsPerWindow,
        windowMs: config.metadata.windowMs,
      });
    this.igdbToken = null;
    this.igdbTokenExpiresAt = 0;
  }

  getStatus() {
    return {
      screenscraperConfigured: Boolean(this.settings.getSecret('metadata.screenscraper')),
      igdbConfigured: Boolean(this.settings.getSecret('metadata.igdb')),
      provider: this.settings.get('metadata.provider'),
      requestsPerMinute: this.config.metadata.requestsPerWindow,
      pendingRequests: this.limiter.pending,
    };
  }

  setCredentials(provider, credentials) {
    if (provider === 'screenscraper') {
      const devId = cleanText(credentials?.devId, 120);
      const devPassword = cleanText(credentials?.devPassword, 240);
      if (!devId || !devPassword) {
        throw new AppError('METADATA_CREDENTIALS_INVALID', 'Informe devId e devPassword do ScreenScraper.');
      }
      this.settings.setSecret(
        'metadata.screenscraper',
        JSON.stringify({
          devId,
          devPassword,
          softName: cleanText(credentials.softName, 120) || 'W3Labs-Entertainment-System',
          user: cleanText(credentials.user, 120) || null,
          password: cleanText(credentials.password, 240) || null,
        }),
      );
      return this.getStatus();
    }
    if (provider === 'igdb') {
      const clientId = cleanText(credentials?.clientId, 200);
      const clientSecret = cleanText(credentials?.clientSecret, 300);
      if (!clientId || !clientSecret) {
        throw new AppError('METADATA_CREDENTIALS_INVALID', 'Informe clientId e clientSecret do IGDB.');
      }
      this.settings.setSecret('metadata.igdb', JSON.stringify({ clientId, clientSecret }));
      this.igdbToken = null;
      return this.getStatus();
    }
    throw new AppError('METADATA_PROVIDER_UNKNOWN', 'Provedor de metadados desconhecido.');
  }

  clearCredentials(provider) {
    if (!['screenscraper', 'igdb'].includes(provider)) {
      throw new AppError('METADATA_PROVIDER_UNKNOWN', 'Provedor de metadados desconhecido.');
    }
    this.settings.deleteSecret(`metadata.${provider}`);
    this.igdbToken = null;
    return this.getStatus();
  }

  async scrapeGame(gameId) {
    const game = this.db.get('SELECT * FROM games WHERE id = ?', [gameId]);
    if (!game) throw new AppError('GAME_NOT_FOUND', 'Jogo não encontrado.');
    const preferred = this.settings.get('metadata.provider');
    const candidates = [preferred, preferred === 'igdb' ? 'screenscraper' : 'igdb'].filter(Boolean);
    const cacheKeyBase = `${game.platform_id}:${game.rom_hash}`;

    let lastError = null;
    for (const provider of candidates) {
      if (!this.#credentialsFor(provider)) continue;
      const cacheKey = `${provider}:${cacheKeyBase}`;
      const cached = this.#readCache(cacheKey);
      if (cached) {
        await this.#applyMetadata(game, cached, provider);
        return { provider, cached: true };
      }
      try {
        if (provider === 'igdb' && (!this.igdbToken || Date.now() >= this.igdbTokenExpiresAt - 60_000)) {
          await this.#limiterCall(() => this.#igdbToken());
        }
        const metadata = await this.#limiterCall(() =>
          provider === 'screenscraper' ? this.#fromScreenScraper(game) : this.#fromIgdb(game),
        );
        if (!metadata) throw new AppError('METADATA_NOT_FOUND', 'Nenhum metadado encontrado.');
        await this.#applyMetadata(game, metadata, provider);
        this.#writeCache(cacheKey, provider, metadata);
        this.logger?.info('metadata', 'Metadados atualizados.', {
          gameId,
          provider,
          title: metadata.title,
        });
        return { provider, cached: false };
      } catch (error) {
        lastError = error;
        this.logger?.warn('metadata', 'Provedor falhou; tentando fallback.', {
          provider,
          gameId,
          error: error.message,
        });
      }
    }

    if (lastError) {
      throw new AppError('METADATA_FAILED', 'Não foi possível obter metadados.', {
        reason: lastError.message,
      });
    }
    throw new AppError(
      'METADATA_NOT_CONFIGURED',
      'Configure as credenciais do ScreenScraper ou do IGDB nas configurações.',
    );
  }

  #credentialsFor(provider) {
    try {
      const secret = this.settings.getSecret(`metadata.${provider}`);
      return secret ? JSON.parse(secret) : null;
    } catch {
      return null;
    }
  }

  async #limiterCall(task) {
    return this.limiter.run(task);
  }

  async #fetchJson(url, options = {}) {
    const response = await this.fetch(url, {
      ...options,
      signal: AbortSignal.timeout(this.config.metadata.timeoutMs),
      headers: {
        accept: 'application/json',
        'user-agent': 'W3Labs-Entertainment-System/1.0',
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new AppError('METADATA_HTTP_ERROR', `API respondeu HTTP ${response.status}.`);
    }
    return response.json();
  }

  async #fromScreenScraper(game) {
    const credentials = this.#credentialsFor('screenscraper');
    if (!credentials) throw new AppError('METADATA_NOT_CONFIGURED', 'ScreenScraper não configurado.');
    const params = new URLSearchParams({
      devid: credentials.devId,
      devpassword: credentials.devPassword,
      softname: credentials.softName,
      output: 'json',
      romnom: game.file_name,
      romtype: 'rom',
      systemeid: SCREENSCRAPER_SYSTEMS[game.platform_id],
    });
    if (credentials.user) params.set('ssid', credentials.user);
    if (credentials.password) params.set('sspassword', credentials.password);
    if (game.rom_md5) params.set('md5', game.rom_md5);

    const data = await this.#fetchJson(`https://api.screenscraper.fr/api2/jeuInfos.php?${params}`);
    const jeu = data?.response?.jeu;
    if (!jeu) return null;
    const medias = Array.isArray(jeu.medias) ? jeu.medias : [];
    const cover =
      medias.find((media) => media.type === 'box-2D' && String(media.region ?? '').match(/us|wor|eu|jp/i)) ??
      medias.find((media) => media.type === 'box-2D') ??
      null;
    return {
      title: cleanText(jeu.nom, 300),
      synopsis: cleanText(preferredLanguage(jeu.synopsis), 8_000),
      releaseYear: parseYear(jeu.dates?.[0]?.text ?? jeu.dates?.[0]?.date),
      publisher: cleanText(jeu.editeur?.text, 300),
      developer: cleanText(jeu.developpeur?.text, 300),
      genre: cleanText(jeu.genres?.[0]?.text, 200),
      coverUrl: cover?.url ? String(cover.url).replace(/^http:/, 'https:') : null,
    };
  }

  async #igdbToken() {
    if (this.igdbToken && Date.now() < this.igdbTokenExpiresAt - 60_000) return this.igdbToken;
    const credentials = this.#credentialsFor('igdb');
    if (!credentials) throw new AppError('METADATA_NOT_CONFIGURED', 'IGDB não configurado.');
    const params = new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: 'client_credentials',
    });
    const response = await this.fetch(`https://id.twitch.tv/oauth2/token?${params}`, {
      method: 'POST',
      signal: AbortSignal.timeout(this.config.metadata.timeoutMs),
    });
    if (!response.ok) throw new AppError('METADATA_AUTH_ERROR', 'Falha ao autenticar no IGDB.');
    const data = await response.json();
    this.igdbToken = data.access_token;
    this.igdbTokenExpiresAt = Date.now() + Number(data.expires_in ?? 0) * 1000;
    this.igdbClientId = credentials.clientId;
    return this.igdbToken;
  }

  async #fromIgdb(game) {
    const token = await this.#igdbToken();
    const platformId = IGDB_PLATFORMS[game.platform_id];
    const escapedTitle = String(game.title).replace(/["\\]/g, ' ').slice(0, 200);
    const query = [
      `search "${escapedTitle}"`,
      'fields name,summary,first_release_date,cover.url,genres.name,publishers.name,developers.name;',
      platformId
        ? `where platforms = (${platformId}) & version_parent = null;`
        : 'where version_parent = null;',
      'limit 5;',
    ].join('\n');

    const data = await this.#fetchJson('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: {
        'client-id': this.igdbClientId,
        authorization: `Bearer ${token}`,
        'content-type': 'text/plain',
      },
      body: query,
    });
    const candidates = Array.isArray(data) ? data : [];
    if (candidates.length === 0) return null;
    const normalized = (value) =>
      String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    const chosen =
      candidates.find((candidate) => normalized(candidate.name) === normalized(game.title)) ?? candidates[0];
    const coverUrl = chosen.cover?.url
      ? `https:${String(chosen.cover.url).replace(/^http:/, '')}`.replace('t_thumb', 't_cover_big')
      : null;
    return {
      title: cleanText(chosen.name, 300),
      synopsis: cleanText(chosen.summary, 8_000),
      releaseYear: chosen.first_release_date
        ? new Date(chosen.first_release_date * 1000).getUTCFullYear()
        : null,
      publisher: cleanText(chosen.publishers?.[0]?.name, 300),
      developer: cleanText(chosen.developers?.[0]?.name, 300),
      genre: cleanText(chosen.genres?.[0]?.name, 200),
      coverUrl,
    };
  }

  async #applyMetadata(game, metadata, provider) {
    let coverFile = game.cover_file ?? null;
    if (metadata.coverUrl) {
      coverFile = (await this.#downloadCover(game.id, metadata.coverUrl)) ?? coverFile;
    }
    this.db.run(
      `UPDATE games SET
         title = COALESCE(?, title),
         sort_title = COALESCE(?, sort_title),
         synopsis = COALESCE(?, synopsis),
         release_year = COALESCE(?, release_year),
         publisher = COALESCE(?, publisher),
         developer = COALESCE(?, developer),
         genre = COALESCE(?, genre),
         cover_file = COALESCE(?, cover_file),
         scrape_status = 'completed',
         scraped_at = ?,
         updated_at = ?
       WHERE id = ?`,
      [
        metadata.title,
        metadata.title ? metadata.title.toLocaleLowerCase('pt-BR') : null,
        metadata.synopsis,
        metadata.releaseYear,
        metadata.publisher,
        metadata.developer,
        metadata.genre,
        coverFile,
        new Date().toISOString(),
        new Date().toISOString(),
        game.id,
      ],
    );
    this.logger?.debug('metadata', 'Metadados aplicados.', { gameId: game.id, provider });
  }

  async #downloadCover(gameId, coverUrl) {
    let parsed;
    try {
      parsed = new URL(coverUrl);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' || !ALLOWED_COVER_HOSTS.includes(parsed.hostname)) return null;

    const response = await this.#limiterCall(() =>
      this.fetch(parsed, {
        signal: AbortSignal.timeout(this.config.metadata.timeoutMs),
        headers: { 'user-agent': 'W3Labs-Entertainment-System/1.0' },
      }),
    );
    if (!response.ok) return null;
    const type = String(response.headers.get('content-type') ?? '').toLowerCase();
    const extension = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 12 * 1024 * 1024) return null;
    const target = this.paths.coverPath(gameId, extension);
    this.paths.assertCoverPath(target);
    const temporary = path.join(this.paths.covers, `.${gameId}.${process.pid}.tmp`);
    await fs.promises.writeFile(temporary, bytes);
    await fs.promises.rename(temporary, target);
    return target;
  }

  #readCache(cacheKey) {
    const row = this.db.get('SELECT * FROM scrape_cache WHERE cache_key = ?', [cacheKey]);
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      this.db.run('DELETE FROM scrape_cache WHERE cache_key = ?', [cacheKey]);
      return null;
    }
    try {
      return JSON.parse(row.payload_json);
    } catch {
      return null;
    }
  }

  #writeCache(cacheKey, provider, metadata) {
    const expiresAt = new Date(Date.now() + this.config.metadata.cacheMinutes * 60_000).toISOString();
    this.db.run(
      `INSERT INTO scrape_cache (cache_key, provider, payload_json, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         provider = excluded.provider,
         payload_json = excluded.payload_json,
         expires_at = excluded.expires_at,
         created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      [cacheKey, provider, JSON.stringify(metadata), expiresAt],
    );
  }
}

module.exports = { MetadataService, ALLOWED_COVER_HOSTS };
