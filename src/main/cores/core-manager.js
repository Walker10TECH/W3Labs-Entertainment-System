'use strict';

const { fork } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { AppError } = require('../lib/errors');

const CORE_HOST = path.join(__dirname, 'core-host.js');
const READY_TIMEOUT_MS = 25_000;
const REQUEST_TIMEOUT_MS = 35_000;

class CoreManager extends EventEmitter {
  constructor({ logger, stopGraceMs = 4_000 }) {
    super();
    this.logger = logger;
    this.stopGraceMs = stopGraceMs;
    this.sessions = new Map();
  }

  async start(config) {
    const sessionId = config.sessionId ?? crypto.randomUUID();
    const child = fork(CORE_HOST, [], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        W3_DEBUG: process.env.W3_DEBUG ?? '0',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
      windowsHide: true,
    });
    const session = {
      id: sessionId,
      child,
      startedAt: new Date(),
      info: null,
      pending: new Map(),
      ready: false,
      stopping: false,
      exited: false,
    };
    this.sessions.set(sessionId, session);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (data) => {
      const text = String(data).trim();
      if (text) this.logger?.debug('core-host', text.slice(0, 2_000), { sessionId });
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (data) => {
      this.logger?.warn('core-host', String(data).trim().slice(0, 4_000), { sessionId });
    });

    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new AppError('CORE_READY_TIMEOUT', 'O processo do núcleo não iniciou dentro do tempo esperado.'),
        );
      }, READY_TIMEOUT_MS);
      session.readyTimer = timer;
      session.resolveReady = resolve;
      session.rejectReady = reject;
    });

    child.on('message', (message) => this.#onMessage(session, message));
    child.on('error', (error) => {
      this.logger?.error('core-manager', 'Erro no processo filho do núcleo.', {
        sessionId,
        error: error.message,
      });
      this.#failPending(session, new AppError('CORE_PROCESS_ERROR', error.message));
      session.rejectReady?.(new AppError('CORE_PROCESS_ERROR', error.message));
    });
    child.on('exit', (code, signal) => this.#onExit(session, code, signal));

    try {
      child.send({
        type: 'init',
        data: {
          ...config,
          sessionId,
          capabilities: config.capabilities,
        },
      });
    } catch (error) {
      clearTimeout(session.readyTimer);
      session.rejectReady?.(new AppError('CORE_IPC_ERROR', error.message));
      await this.stop(sessionId).catch(() => {});
      throw new AppError('CORE_IPC_ERROR', error.message);
    }

    try {
      const info = await ready;
      session.ready = true;
      session.info = info;
      this.logger?.info('core-manager', 'Núcleo isolado iniciado.', {
        sessionId,
        coreId: config.coreId,
        pid: info.pid,
        transport: info.transport,
      });
      this.emit('started', {
        sessionId,
        coreId: config.coreId,
        platformId: config.platformId,
        gameId: config.gameId,
        pid: info.pid,
        capabilities: info.capabilities,
        transport: info.transport,
        startedAt: session.startedAt.toISOString(),
      });
      return { ...info, sessionId, coreId: config.coreId };
    } catch (error) {
      await this.stop(sessionId).catch(() => {});
      throw error;
    }
  }

  #onMessage(session, message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      clearTimeout(session.readyTimer);
      session.resolveReady?.(message.data);
      session.resolveReady = null;
      session.rejectReady = null;
      return;
    }
    if (message.type === 'init-error' || message.type === 'fatal') {
      clearTimeout(session.readyTimer);
      const error = new AppError(
        message.error?.code ?? 'CORE_INIT_FAILED',
        message.error?.message ?? 'Falha ao iniciar o núcleo.',
      );
      session.rejectReady?.(error);
      session.rejectReady = null;
      this.#failPending(session, error);
      this.emit('core-error', { sessionId: session.id, error: message.error });
      return;
    }
    if (message.type === 'response') {
      const pending = session.pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      session.pending.delete(message.requestId);
      if (message.ok) pending.resolve(message.data);
      else
        pending.reject(
          new AppError(
            message.error?.code ?? 'CORE_REQUEST_FAILED',
            message.error?.message ?? 'Falha no núcleo.',
          ),
        );
      return;
    }
    if (message.type === 'event') {
      this.emit('event', {
        sessionId: session.id,
        event: message.event,
        payload: message.payload,
      });
    }
  }

  #onExit(session, code, signal) {
    if (session.exited) return;
    session.exited = true;
    clearTimeout(session.readyTimer);
    this.#failPending(
      session,
      new AppError('CORE_EXITED', `O processo do núcleo encerrou (código ${code ?? 'null'}).`),
    );
    if (!session.ready) {
      session.rejectReady?.(
        new AppError('CORE_EXITED', `O núcleo encerrou durante a inicialização (código ${code ?? 'null'}).`),
      );
      session.rejectReady = null;
    }
    this.sessions.delete(session.id);
    this.emit('exit', {
      sessionId: session.id,
      code,
      signal,
      unexpected: !session.stopping,
    });
  }

  #failPending(session, error) {
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    session.pending.clear();
  }

  async request(sessionId, command, payload = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const session = this.sessions.get(sessionId);
    if (!session || session.exited) throw new AppError('CORE_NOT_RUNNING', 'Núcleo não está em execução.');
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(requestId);
        reject(new AppError('CORE_REQUEST_TIMEOUT', 'O núcleo não respondeu ao comando.'));
      }, timeoutMs);
      session.pending.set(requestId, { resolve, reject, timer });
      try {
        session.child.send({ type: 'request', requestId, command, payload });
      } catch (error) {
        clearTimeout(timer);
        session.pending.delete(requestId);
        reject(new AppError('CORE_IPC_ERROR', error.message));
      }
    });
  }

  async stop(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.stopping) return;
    session.stopping = true;
    try {
      session.child.send({ type: 'shutdown' });
    } catch {
      // processo já encerrado
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          session.child.kill('SIGKILL');
        } catch {
          // idem
        }
        resolve();
      }, this.stopGraceMs);
      session.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.sessions.delete(sessionId);
  }

  async shutdownAll() {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }

  get activeCount() {
    return this.sessions.size;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) ?? null;
  }
}

module.exports = { CoreManager };
