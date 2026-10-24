'use strict';

const { EventEmitter } = require('node:events');
const { AppError } = require('../lib/errors');
const { getPlatform } = require('../../../config/platforms');

class EmulationService extends EventEmitter {
  constructor({
    db,
    paths,
    library,
    bios,
    hardware,
    coreRegistry,
    coreManager,
    settings,
    logger,
    config,
    media,
  }) {
    super();
    this.db = db;
    this.paths = paths;
    this.library = library;
    this.bios = bios;
    this.hardware = hardware;
    this.coreRegistry = coreRegistry;
    this.coreManager = coreManager;
    this.settings = settings;
    this.logger = logger;
    this.config = config;
    this.media = media;
    this.active = null;
    this.ticker = setInterval(() => this.#tick(), 15_000);
    this.ticker.unref?.();

    this.coreManager.on('exit', (info) => this.#handleCoreExit(info));
    this.coreManager.on('event', ({ sessionId, event, payload }) => {
      this.emit('core-event', { sessionId, event, payload });
    });
  }

  getActive() {
    if (!this.active) return null;
    return this.#publicSession(this.active);
  }

  async launch(gameId, { acknowledgedWarnings = false } = {}) {
    if (this.active) {
      throw new AppError('SESSION_ALREADY_ACTIVE', 'Encerre o jogo atual antes de iniciar outro.');
    }
    const game = await this.library.verifyGameFile(gameId);
    const platform = getPlatform(game.platformId);
    const mediaInfo = await this.media.inspect(game);
    // BIOS primeiro: evita mostrar aviso de hardware quando o boot ainda
    // está bloqueado por uma pendência de BIOS.
    const biosFiles = await this.bios.resolveForGame(game);

    const hardware = await this.hardware.assess(game.platformId);
    if (hardware.warnings.length > 0 && !acknowledgedWarnings) {
      throw new AppError(
        'HARDWARE_WARNING',
        'O hardware pode não atender aos requisitos mínimos para esta plataforma.',
        { warnings: hardware.warnings, canProceed: true, hardwareInfo: hardware.info },
      );
    }

    const stateDirectory = this.paths.saveStatePath(platform.id, game.romHash, 0).directory;
    this.paths.assertSavePath(stateDirectory);

    const coreConfig = this.coreRegistry.buildLaunchSpec(platform.id, game, biosFiles, {
      stateDir: stateDirectory,
    });

    const coreInfo = await this.coreManager.start({
      platformId: platform.id,
      gameId: game.id,
      coreId: coreConfig.coreId,
      romPath: game.filePath,
      executable: coreConfig.executable,
      args: coreConfig.args,
      bridgeCommand: coreConfig.bridgeCommand,
      environment: coreConfig.environment,
      capabilities: coreConfig.capabilities,
      biosFiles,
      stateDir: stateDirectory,
      fullscreen: this.settings.get('video.resolution') !== 'windowed',
    });

    const id = coreInfo.sessionId;
    const startedAt = new Date();
    const bootGuardSeconds = platform.bios.bootGuardSeconds ?? 0;
    const hardcore = this.#isHardcoreActive();
    try {
      this.db.run(
        `INSERT INTO play_sessions (id, game_id, core_id, started_at, hardcore, status)
         VALUES (?, ?, ?, ?, ?, 'running')`,
        [id, game.id, coreConfig.coreId, startedAt.toISOString(), hardcore ? 1 : 0],
      );
      this.db.run(
        "UPDATE games SET last_played_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
        [startedAt.toISOString(), game.id],
      );
    } catch (error) {
      await this.coreManager.stop(id).catch(() => {});
      throw error;
    }

    this.active = {
      id,
      gameId: game.id,
      game,
      platformId: platform.id,
      platform,
      coreId: coreConfig.coreId,
      coreLabel: coreConfig.label,
      capabilities: coreConfig.capabilities,
      transport: coreInfo.transport,
      pid: coreInfo.pid,
      startedAt,
      bootEndsAt: new Date(startedAt.getTime() + bootGuardSeconds * 1000),
      bootGuardSeconds,
      paused: false,
      lastTickAt: Date.now(),
      accumulatedMs: 0,
      hardcoreAtStart: hardcore,
      stopping: false,
      warnings: hardware.warnings,
    };
    this.logger?.info('emulation', 'Sessão iniciada.', {
      gameId: game.id,
      platformId: platform.id,
      core: coreConfig.coreId,
      sessionId: id,
      hardcore,
    });
    const session = this.#publicSession(this.active);
    this.emit('changed', session);
    return { ...session, biosFiles, hardware, media: mediaInfo };
  }

  async pause() {
    const active = this.#requireActive();
    if (active.paused) return this.#publicSession(active);
    if (!active.capabilities.pause) {
      throw new AppError('CORE_PAUSE_UNSUPPORTED', 'Este núcleo não expõe pausa via bridge.');
    }
    this.#accrue(active);
    await this.coreManager.request(active.id, 'pause');
    active.paused = true;
    this.db.run("UPDATE play_sessions SET status = 'paused' WHERE id = ?", [active.id]);
    this.logger?.info('emulation', 'Sessão pausada.', { sessionId: active.id });
    const session = this.#publicSession(active);
    this.emit('changed', session);
    return session;
  }

  async resume() {
    const active = this.#requireActive();
    if (!active.paused) return this.#publicSession(active);
    if (!active.capabilities.pause) {
      throw new AppError('CORE_PAUSE_UNSUPPORTED', 'Este núcleo não expõe retomada via bridge.');
    }
    await this.coreManager.request(active.id, 'resume');
    active.paused = false;
    active.lastTickAt = Date.now();
    this.db.run("UPDATE play_sessions SET status = 'running' WHERE id = ?", [active.id]);
    const session = this.#publicSession(active);
    this.emit('changed', session);
    return session;
  }

  async stop({ reason = 'user' } = {}) {
    const active = this.#requireActive();
    active.stopping = true;
    this.#accrue(active);
    await this.coreManager.stop(active.id).catch((error) => {
      this.logger?.warn('emulation', 'Falha ao encerrar núcleo.', { error: error.message });
    });
    this.#finalize(active, { status: 'stopped', exitCode: 0, reason });
    return { stopped: true };
  }

  getBootGuard(session) {
    const remaining = Math.max(0, Math.ceil((session.bootEndsAt.getTime() - Date.now()) / 1000));
    return {
      active: remaining > 0,
      remainingSeconds: remaining,
      totalSeconds: session.bootGuardSeconds,
    };
  }

  #requireActive() {
    if (!this.active) throw new AppError('NO_ACTIVE_SESSION', 'Nenhum jogo em execução.');
    return this.active;
  }

  #isHardcoreActive() {
    const service = this.raService;
    return Boolean(service?.isHardcoreActive());
  }

  setRetroAchievementsService(service) {
    this.raService = service;
  }

  #tick() {
    if (!this.active || this.active.paused) return;
    this.#accrue(this.active);
    this.emit('tick', this.#publicSession(this.active));
  }

  #accrue(active) {
    const now = Date.now();
    const elapsed = Math.max(0, now - active.lastTickAt);
    active.lastTickAt = now;
    if (active.paused) return;
    active.accumulatedMs += elapsed;
    const seconds = Math.floor(active.accumulatedMs / 1000);
    if (seconds <= 0) return;
    active.accumulatedMs -= seconds * 1000;
    try {
      this.db.transaction(() => {
        this.db.run('UPDATE play_sessions SET duration_seconds = duration_seconds + ? WHERE id = ?', [
          seconds,
          active.id,
        ]);
        this.db.run('UPDATE games SET playtime_seconds = playtime_seconds + ? WHERE id = ?', [
          seconds,
          active.gameId,
        ]);
      });
    } catch (error) {
      this.logger?.warn('emulation', 'Falha ao contabilizar playtime.', { error: error.message });
    }
  }

  #handleCoreExit({ sessionId, code, signal, unexpected }) {
    const active = this.active;
    if (!active || active.id !== sessionId) return;
    this.#accrue(active);
    this.#finalize(active, {
      status: unexpected ? 'crashed' : 'stopped',
      exitCode: code,
      signal,
      reason: unexpected ? 'core-exit' : 'core-closed',
    });
  }

  #finalize(active, { status, exitCode = null, signal = null, reason = null }) {
    if (!this.active || this.active.id !== active.id) return;
    this.#accrue(active);
    const endedAt = new Date().toISOString();
    try {
      this.db.run(
        `UPDATE play_sessions SET ended_at = ?, status = ?, exit_code = ?, error_message = ? WHERE id = ?`,
        [
          endedAt,
          status,
          exitCode,
          status === 'crashed' ? `Sinal: ${signal ?? 'desconhecido'}` : null,
          active.id,
        ],
      );
    } catch (error) {
      this.logger?.warn('emulation', 'Falha ao finalizar sessão.', { error: error.message });
    }
    this.logger?.[status === 'crashed' ? 'error' : 'info']('emulation', 'Sessão encerrada.', {
      sessionId: active.id,
      gameId: active.gameId,
      status,
      exitCode,
      reason,
    });
    this.active = null;
    this.emit('changed', null);
    this.emit('stopped', { sessionId: active.id, gameId: active.gameId, status, exitCode, reason });
  }

  #publicSession(active) {
    return {
      id: active.id,
      gameId: active.gameId,
      gameTitle: active.game.title,
      platformId: active.platformId,
      platformName: active.platform.shortName,
      coreId: active.coreId,
      coreLabel: active.coreLabel,
      pid: active.pid,
      transport: active.transport,
      capabilities: active.capabilities,
      paused: active.paused,
      hardcore: Boolean(this.raService?.isHardcoreActive()),
      startedAt: active.startedAt.toISOString(),
      bootGuard: this.getBootGuard(active),
      playtimeSeconds: Math.floor(
        (Number(
          this.db.get('SELECT duration_seconds FROM play_sessions WHERE id = ?', [active.id])
            ?.duration_seconds ?? 0,
        ) || 0) +
          active.accumulatedMs / 1000,
      ),
      warnings: active.warnings,
    };
  }

  async shutdown() {
    clearInterval(this.ticker);
    if (this.active) {
      await this.stop({ reason: 'app-quit' }).catch(() => {});
    }
    await this.coreManager.shutdownAll();
  }
}

module.exports = { EmulationService };
