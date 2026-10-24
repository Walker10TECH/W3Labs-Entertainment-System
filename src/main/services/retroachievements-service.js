'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { AppError } = require('../lib/errors');
const { RateLimiter } = require('../lib/rate-limiter');

const RA_API = 'https://retroachievements.org/API';
const RA_TIMEOUT_MS = 12_000;

class RetroAchievementsService extends EventEmitter {
  constructor({ settings, db, logger, fetchImpl = globalThis.fetch, limiter = null }) {
    super();
    this.settings = settings;
    this.db = db;
    this.logger = logger;
    this.fetch = fetchImpl;
    this.limiter = limiter ?? new RateLimiter({ maxRequests: 30, windowMs: 60_000, minIntervalMs: 2_000 });
    this.profile = null;
    this.online = false;
    this.lastCheckedAt = null;
  }

  get username() {
    return this.settings.get('retroachievements.username') || null;
  }

  get apiKey() {
    return this.settings.getSecret('retroachievements.apiKey');
  }

  get connected() {
    return Boolean(this.username && this.apiKey);
  }

  get hardcore() {
    return Boolean(this.settings.get('retroachievements.hardcore'));
  }

  isHardcoreActive() {
    return this.connected && this.hardcore;
  }

  getStatus() {
    return {
      connected: this.connected,
      username: this.username,
      hardcore: this.isHardcoreActive(),
      hardcoreRequested: this.hardcore,
      online: this.online,
      profile: this.profile,
      lastCheckedAt: this.lastCheckedAt,
      requestsPerMinute: this.limiter.maxRequests,
    };
  }

  async connect({ username, apiKey }) {
    const cleanUser = String(username ?? '').trim();
    const cleanKey = String(apiKey ?? '').trim();
    if (!cleanUser || !cleanKey) {
      throw new AppError('RA_CREDENTIALS_REQUIRED', 'Informe usuário e Web API Key do RetroAchievements.');
    }
    if (!/^[A-Za-z0-9_.-]{2,32}$/.test(cleanUser)) {
      throw new AppError('RA_USERNAME_INVALID', 'Nome de usuário do RetroAchievements inválido.');
    }
    if (cleanKey.length < 16 || cleanKey.length > 128) {
      throw new AppError('RA_KEY_INVALID', 'Web API Key do RetroAchievements inválida.');
    }

    const profile = await this.#request('API_GetUserProfile.php', cleanUser, { u: cleanUser }, cleanKey);
    if (!profile?.User) {
      throw new AppError('RA_AUTH_FAILED', 'Não foi possível autenticar no RetroAchievements.');
    }
    this.settings.set('retroachievements.username', cleanUser);
    this.settings.setSecret('retroachievements.apiKey', cleanKey);
    this.settings.set('retroachievements.hardcore', false);
    this.profile = {
      user: profile.User,
      motto: profile.Motto ?? '',
      points: Number(profile.TotalPoints ?? 0),
      truePoints: Number(profile.TotalTruePoints ?? 0),
      avatar: profile.UserPic ? `https://retroachievements.org${profile.UserPic}` : null,
    };
    this.online = true;
    this.lastCheckedAt = new Date().toISOString();
    this.logger?.info('retroachievements', 'Conta conectada.', { user: cleanUser });
    this.#emit();
    return this.getStatus();
  }

  async refresh() {
    if (!this.connected) throw new AppError('RA_NOT_CONNECTED', 'Conecte a conta do RetroAchievements.');
    const profile = await this.#request(
      'API_GetUserProfile.php',
      this.apiKey,
      { u: this.username },
      this.apiKey,
    );
    this.profile = {
      user: profile.User,
      motto: profile.Motto ?? '',
      points: Number(profile.TotalPoints ?? 0),
      truePoints: Number(profile.TotalTruePoints ?? 0),
      avatar: profile.UserPic ? `https://retroachievements.org${profile.UserPic}` : null,
    };
    this.online = true;
    this.lastCheckedAt = new Date().toISOString();
    this.#emit();
    return this.getStatus();
  }

  disconnect() {
    this.settings.deleteSecret('retroachievements.apiKey');
    this.settings.set('retroachievements.username', null);
    this.settings.set('retroachievements.hardcore', false);
    this.profile = null;
    this.online = false;
    this.lastCheckedAt = null;
    this.logger?.info('retroachievements', 'Conta desconectada.');
    this.#emit();
    return this.getStatus();
  }

  async setHardcore(enabled) {
    if (enabled) {
      if (!this.connected) {
        throw new AppError('RA_NOT_CONNECTED', 'O modo Hardcore exige uma conta conectada.');
      }
      // Exige conexão ativa no momento da ativação.
      try {
        await this.refresh();
      } catch (error) {
        this.online = false;
        throw new AppError(
          'RA_OFFLINE',
          'Sem conexão com o RetroAchievements. O modo Hardcore não pode ser ativado.',
          { reason: error.message },
        );
      }
      this.settings.set('retroachievements.hardcore', true);
      this.logger?.info('retroachievements', 'Modo Hardcore ativado: save states bloqueados.');
    } else {
      this.settings.set('retroachievements.hardcore', false);
      this.logger?.info('retroachievements', 'Modo Hardcore desativado.');
    }
    this.#emit();
    return this.getStatus();
  }

  assertSaveStatesAllowed() {
    if (this.isHardcoreActive()) {
      throw new AppError(
        'HARDCORE_LOCKED',
        'Save States estão desabilitados enquanto o modo Hardcore do RetroAchievements estiver ativo.',
      );
    }
  }

  async linkGame(gameId, raGameId) {
    const id = Number(raGameId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppError('RA_GAME_ID_INVALID', 'ID de jogo do RetroAchievements inválido.');
    }
    this.db.run(
      "UPDATE games SET ra_game_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      [id, gameId],
    );
    return { gameId, raGameId: id };
  }

  async syncAchievements(gameId) {
    if (!this.connected) throw new AppError('RA_NOT_CONNECTED', 'Conecte a conta do RetroAchievements.');
    const game = this.db.get('SELECT * FROM games WHERE id = ?', [gameId]);
    if (!game) throw new AppError('GAME_NOT_FOUND', 'Jogo não encontrado.');
    if (!game.ra_game_id) {
      throw new AppError(
        'RA_GAME_NOT_LINKED',
        'Vincule o jogo a um ID do RetroAchievements antes de sincronizar.',
      );
    }
    const data = await this.#request(
      'API_GetGameInfoAndUserProgress.php',
      this.apiKey,
      { u: this.username, g: game.ra_game_id },
      this.apiKey,
    );
    const achievements = data?.Achievements ? Object.values(data.Achievements) : [];
    const hardcore = this.isHardcoreActive() ? 1 : 0;
    for (const achievement of achievements) {
      this.db.run(
        `INSERT INTO achievements (
           id, game_id, ra_achievement_id, title, description, points, badge_url, earned_at, hardcore
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(game_id, ra_achievement_id) DO UPDATE SET
           title = excluded.title,
           description = excluded.description,
           points = excluded.points,
           badge_url = excluded.badge_url,
           earned_at = COALESCE(excluded.earned_at, achievements.earned_at),
           hardcore = excluded.hardcore`,
        [
          crypto.randomUUID(),
          gameId,
          Number(achievement.ID),
          String(achievement.Title ?? 'Conquista'),
          achievement.Description ?? null,
          Number(achievement.Points ?? 0),
          achievement.BadgeName
            ? `https://media.retroachievements.org/Badge/${achievement.BadgeName}.png`
            : null,
          achievement.DateEarned ?? achievement.DateEarnedHardcore ?? null,
          hardcore,
        ],
      );
    }
    this.#emit();
    return {
      gameId,
      raGameId: game.ra_game_id,
      achievements: achievements.length,
      hardcore: Boolean(hardcore),
    };
  }

  async #request(endpoint, apiKey, params) {
    if (!apiKey) {
      throw new AppError('RA_NOT_CONNECTED', 'Conecte a conta do RetroAchievements.');
    }
    const url = new URL(`${RA_API}/${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
    url.searchParams.set('z', apiKey);
    let response;
    try {
      response = await this.limiter.run(() =>
        this.fetch(url, {
          signal: AbortSignal.timeout(RA_TIMEOUT_MS),
          headers: { accept: 'application/json', 'user-agent': 'W3Labs-Entertainment-System/1.0' },
        }),
      );
    } catch (error) {
      this.online = false;
      throw new AppError('RA_OFFLINE', 'Falha de conexão com o RetroAchievements.', {
        reason: error.message,
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError('RA_AUTH_FAILED', 'Credenciais do RetroAchievements rejeitadas.');
    }
    if (!response.ok) {
      throw new AppError('RA_HTTP_ERROR', `RetroAchievements respondeu HTTP ${response.status}.`);
    }
    this.online = true;
    return response.json();
  }

  #emit() {
    this.emit('changed', this.getStatus());
  }
}

module.exports = { RetroAchievementsService };
