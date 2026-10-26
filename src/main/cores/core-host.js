'use strict';

/**
 * Processo filho segregado. Este arquivo nunca carrega a ROM/ISO em memória:
 * valida o arquivo por stat e lê apenas os primeiros bytes. Núcleos externos
 * são spawnados daqui; bridges recebem comandos por JSON Lines no stdin.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { readHeader } = require('../lib/hash');

let config = null;
let child = null;
let stopping = false;
let initializedAt = null;
let stdoutBuffer = '';
let pendingInit = null;
const pendingRequests = new Map();

function send(message) {
  if (process.connected) process.send(message);
}

function emit(event, payload = {}) {
  send({ type: 'event', event, payload: { ...payload, at: new Date().toISOString() } });
}

function respond(requestId, data) {
  send({ type: 'response', requestId, ok: true, data });
}

function fail(requestId, code, message, details = null) {
  send({ type: 'response', requestId, ok: false, error: { code, message, ...(details ? { details } : {}) } });
}

function assertStatePath(statePath, slot) {
  if (!config?.stateDir) {
    const error = new Error('Diretório de save states não configurado.');
    error.code = 'STATE_DIR_MISSING';
    throw error;
  }
  const target = path.resolve(String(statePath));
  const base = path.resolve(config.stateDir);
  const relative = path.relative(base, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    const error = new Error('Caminho de save state fora do diretório da sessão.');
    error.code = 'STATE_PATH_OUTSIDE';
    throw error;
  }
  if (path.basename(target) !== `${Number(slot)}.state`) {
    const error = new Error('Nome de save state não segue o slot solicitado.');
    error.code = 'STATE_NAME_INVALID';
    throw error;
  }
  return target;
}

function cleanLog(value) {
  return String(value)
    .replace(/\u0000/g, '')
    .slice(0, 8_000);
}

function handleBridgeMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.id && pendingRequests.has(message.id)) {
    const pending = pendingRequests.get(message.id);
    pendingRequests.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.data ?? null);
    else
      pending.reject(
        Object.assign(new Error(message.error?.message ?? 'Bridge retornou erro.'), {
          code: message.error?.code ?? 'BRIDGE_ERROR',
        }),
      );
    return;
  }
  if (message.id === 'init' && pendingInit) {
    const pending = pendingInit;
    pendingInit = null;
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve();
    else pending.reject(new Error(message.error?.message ?? 'Bridge não inicializou.'));
    return;
  }
  if (message.event === 'ready' && pendingInit) {
    const pending = pendingInit;
    pendingInit = null;
    clearTimeout(pending.timer);
    pending.resolve();
    return;
  }
  if (message.event) {
    emit('core-event', {
      event: String(message.event).slice(0, 80),
      data: message.data ?? message.payload ?? null,
    });
  }
}

function attachBridgeStreams() {
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    if (stdoutBuffer.length > 1024 * 1024) {
      emit('log', { stream: 'stderr', message: 'Buffer do bridge excedeu 1 MB; descartado.' });
      stdoutBuffer = '';
      return;
    }
    let newline;
    while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        handleBridgeMessage(JSON.parse(line));
      } catch {
        emit('log', { stream: 'stdout', message: cleanLog(line) });
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const message = cleanLog(String(chunk).trim());
    if (message) emit('log', { stream: 'stderr', message });
  });
}

async function startBridge() {
  const [executable, ...args] = config.bridgeCommand;
  child = spawn(executable, args, {
    cwd: config.cwd || process.cwd(),
    env: {
      ...process.env,
      ...config.environment,
      W3_ROM_PATH: config.romPath,
      W3_STATE_DIR: config.stateDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  attachBridgeStreams();
  child.on('error', (error) => {
    emit('error', { message: error.message, code: 'BRIDGE_SPAWN_FAILED' });
    if (pendingInit) {
      const pending = pendingInit;
      pendingInit = null;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  });
  child.on('exit', (code, signal) => handleChildExit(code, signal));
  child.stdin.on('error', (error) => emit('log', { stream: 'stderr', message: `stdin: ${error.message}` }));

  const initPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingInit = null;
      reject(new Error('Bridge não respondeu ao init em 15 s.'));
    }, 15_000);
    pendingInit = { resolve, reject, timer };
  });
  child.stdin.write(
    `${JSON.stringify({
      id: 'init',
      command: 'init',
      payload: {
        sessionId: config.sessionId,
        platformId: config.platformId,
        gameId: config.gameId,
        romPath: config.romPath,
        stateDir: config.stateDir,
        biosFiles: config.biosFiles,
        fullscreen: config.fullscreen,
        preferences: config.preferences ?? null,
        environment: config.environment,
      },
    })}\n`,
  );
  await initPromise;
}

function startExternal() {
  child = spawn(config.executable, config.args, {
    cwd: config.cwd || path.dirname(config.romPath),
    env: {
      ...process.env,
      ...config.environment,
      W3_ROM_PATH: config.romPath,
      W3_STATE_DIR: config.stateDir,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: false,
    shell: false,
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    const message = cleanLog(String(chunk).trim());
    if (message) emit('log', { stream: 'stderr', message });
  });
  child.on('error', (error) => emit('error', { message: error.message, code: 'CORE_SPAWN_FAILED' }));
  child.on('exit', (code, signal) => handleChildExit(code, signal));
}

function handleChildExit(code, signal) {
  emit('exit', { code, signal });
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(Object.assign(new Error('Núcleo encerrou antes de responder.'), { code: 'CORE_EXITED' }));
  }
  pendingRequests.clear();
  if (pendingInit) {
    const pending = pendingInit;
    pendingInit = null;
    clearTimeout(pending.timer);
    pending.reject(new Error('Núcleo encerrou durante a inicialização.'));
  }
  if (!stopping) {
    setTimeout(() => process.exit(code ?? 0), 100);
  }
}

async function initialize(incoming) {
  if (config) throw new Error('Sessão já inicializada.');
  config = incoming;
  if (!config?.romPath || !config?.platformId || !config?.gameId) {
    throw Object.assign(new Error('Configuração de sessão incompleta.'), { code: 'CORE_CONFIG_INVALID' });
  }
  const stat = fs.statSync(config.romPath);
  if (!stat.isFile()) {
    throw Object.assign(new Error('ROM/ISO não é um arquivo regular.'), { code: 'ROM_NOT_FILE' });
  }
  // Apenas leitura de cabeçalho; a mídia não é carregada na RAM.
  await readHeader(config.romPath, 16);
  fs.mkdirSync(config.stateDir, { recursive: true });
  initializedAt = new Date().toISOString();

  if (Array.isArray(config.bridgeCommand) && config.bridgeCommand.length > 0) {
    await startBridge();
  } else {
    startExternal();
  }

  send({
    type: 'ready',
    data: {
      sessionId: config.sessionId,
      pid: child?.pid ?? null,
      initializedAt,
      romBytes: stat.size,
      stateDir: config.stateDir,
      capabilities: config.capabilities,
      transport:
        Array.isArray(config.bridgeCommand) && config.bridgeCommand.length > 0 ? 'bridge' : 'external',
    },
  });
}

async function handleRequest(requestId, command, payload = {}) {
  try {
    if (!config) throw Object.assign(new Error('Sessão não inicializada.'), { code: 'CORE_NOT_READY' });
    if (!child) throw Object.assign(new Error('Núcleo não está em execução.'), { code: 'CORE_NOT_RUNNING' });
    const capabilities = config.capabilities ?? {};

    if (command === 'save-state') {
      if (!capabilities.saveState) {
        throw Object.assign(new Error('O núcleo configurado não expõe Save State gerenciável.'), {
          code: 'CORE_STATE_UNSUPPORTED',
        });
      }
      const slot = Number(payload.slot);
      const target = assertStatePath(payload.statePath, slot);
      const result = await sendToBridge({ id: requestId, command: 'save-state', path: target, slot });
      const stat = fs.existsSync(target) ? fs.statSync(target) : null;
      if (!stat || stat.size <= 0) {
        throw Object.assign(new Error('O bridge não produziu um arquivo de estado válido.'), {
          code: 'STATE_NOT_WRITTEN',
        });
      }
      return respond(requestId, { ...result, path: target, sizeBytes: stat.size });
    }

    if (command === 'load-state') {
      if (!capabilities.loadState) {
        throw Object.assign(new Error('O núcleo configurado não expõe Load State gerenciável.'), {
          code: 'CORE_STATE_UNSUPPORTED',
        });
      }
      const slot = Number(payload.slot);
      const target = assertStatePath(payload.statePath, slot);
      if (!fs.existsSync(target)) {
        throw Object.assign(new Error('Save state não encontrado.'), { code: 'STATE_NOT_FOUND' });
      }
      const result = await sendToBridge({ id: requestId, command: 'load-state', path: target, slot });
      return respond(requestId, result);
    }

    if (command === 'pause' || command === 'resume') {
      if (!capabilities.pause) {
        throw Object.assign(new Error('O núcleo configurado não permite pausar/retomar via bridge.'), {
          code: 'CORE_PAUSE_UNSUPPORTED',
        });
      }
      const result = await sendToBridge({ id: requestId, command, path: null, slot: null });
      return respond(requestId, result);
    }

    if (command === 'screenshot') {
      if (!capabilities.screenshot) {
        throw Object.assign(new Error('Captura de tela não suportada pelo núcleo.'), {
          code: 'CORE_SCREENSHOT_UNSUPPORTED',
        });
      }
      const result = await sendToBridge({ id: requestId, command: 'screenshot', path: payload.path ?? null });
      return respond(requestId, result);
    }

    throw Object.assign(new Error(`Comando de núcleo desconhecido: ${command}`), {
      code: 'CORE_COMMAND_UNKNOWN',
    });
  } catch (error) {
    fail(requestId, error.code ?? 'CORE_COMMAND_FAILED', error.message);
  }
}

function sendToBridge(message) {
  if (!config.bridgeCommand || !child?.stdin?.writable) {
    return Promise.reject(Object.assign(new Error('Bridge indisponível.'), { code: 'BRIDGE_UNAVAILABLE' }));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(message.id);
      reject(Object.assign(new Error('Bridge não respondeu em 30 s.'), { code: 'BRIDGE_TIMEOUT' }));
    }, 30_000);
    pendingRequests.set(message.id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  const target = child;
  child = null;
  if (!target) {
    process.exit(exitCode);
    return;
  }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    process.exit(exitCode);
  };
  target.once('exit', finish);
  try {
    if (config?.bridgeCommand && target.stdin?.writable) {
      target.stdin.write(`${JSON.stringify({ id: 'shutdown', command: 'quit' })}\n`);
    } else {
      target.kill('SIGTERM');
    }
  } catch {
    // processo já encerrado
  }
  setTimeout(() => {
    try {
      target.kill('SIGKILL');
    } catch {
      // idem
    }
    finish();
  }, 2_500);
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'init') {
    initialize(message.data).catch((error) => {
      send({ type: 'init-error', error: { code: error.code ?? 'CORE_INIT_FAILED', message: error.message } });
      setTimeout(() => process.exit(1), 50);
    });
    return;
  }
  if (message.type === 'request') {
    void handleRequest(message.requestId, message.command, message.payload);
    return;
  }
  if (message.type === 'shutdown') {
    void shutdown(0);
  }
});

process.on('disconnect', () => {
  void shutdown(0);
});

process.on('uncaughtException', (error) => {
  send({ type: 'fatal', error: { code: 'CORE_HOST_CRASH', message: error.message, stack: error.stack } });
  setTimeout(() => process.exit(1), 50);
});

process.on('unhandledRejection', (error) => {
  send({
    type: 'fatal',
    error: { code: 'CORE_HOST_REJECTION', message: error?.message ?? String(error) },
  });
  setTimeout(() => process.exit(1), 50);
});
