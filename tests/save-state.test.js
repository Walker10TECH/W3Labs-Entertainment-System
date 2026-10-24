'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { SaveStateService } = require('../src/main/services/save-state-service');
const { createTestEnvironment, insertGame, silentLogger } = require('./helpers');

function harness({ bootGuardSeconds = 0 } = {}) {
  const env = createTestEnvironment();
  const game = insertGame(env.db, {
    platformId: 'ps1',
    title: 'State Test',
    fileName: 'state-test.cue',
  });
  const requests = [];
  let hardcore = false;
  const active = {
    id: 'session-1',
    gameId: game.id,
    platformId: 'ps1',
    game: { id: game.id, romHash: game.rom_hash, title: game.title },
    coreId: 'duckstation',
    capabilities: { saveState: true, loadState: true, pause: true },
    startedAt: new Date(),
  };
  const emulation = {
    active,
    coreManager: {
      async request(sessionId, command, payload) {
        requests.push({ sessionId, command, payload });
        if (command === 'save-state') {
          fs.mkdirSync(path.dirname(payload.statePath), { recursive: true });
          fs.writeFileSync(payload.statePath, Buffer.from('fake-state-bytes'));
        }
        return { ok: true };
      },
    },
    getBootGuard() {
      return { active: bootGuardSeconds > 0, remainingSeconds: bootGuardSeconds, totalSeconds: 10 };
    },
  };
  const ra = {
    isHardcoreActive: () => hardcore,
    setHardcore(value) {
      hardcore = value;
    },
  };
  const service = new SaveStateService({
    db: env.db,
    paths: env.paths,
    emulation,
    logger: silentLogger,
  });
  service.setRetroAchievementsService(ra);
  return { env, game, active, service, requests, ra };
}

test('grava e carrega save state no caminho canônico por hash e slot', async () => {
  const { env, game, service, requests } = harness();
  try {
    const result = await service.save(game.id, 2);
    const expected = path.join(env.paths.saves, 'ps1', game.rom_hash, '2.state');
    assert.equal(result.statePath, expected);
    assert.ok(fs.existsSync(expected));
    assert.equal(requests[0].command, 'save-state');
    assert.equal(requests[0].payload.slot, 2);

    const list = service.list(game.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].slot, 2);
    assert.equal(list[0].sizeBytes, 16);

    await service.load(game.id, 2);
    assert.equal(requests[1].command, 'load-state');

    service.remove(game.id, 2);
    assert.equal(fs.existsSync(expected), false);
    assert.equal(service.list(game.id).length, 0);
  } finally {
    env.db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('Hardcore bloqueia salvamento e carregamento imediatamente', async () => {
  const { env, game, service, ra } = harness();
  try {
    await service.save(game.id, 0);
    ra.setHardcore(true);
    await assert.rejects(service.save(game.id, 1), (error) => error.code === 'HARDCORE_LOCKED');
    await assert.rejects(service.load(game.id, 0), (error) => error.code === 'HARDCORE_LOCKED');
  } finally {
    env.db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('boot guard de 10 segundos impede salvar e sobrescrever', async () => {
  const { env, game, service } = harness({ bootGuardSeconds: 7 });
  try {
    await assert.rejects(service.save(game.id, 0), (error) => error.code === 'BOOT_GUARD_ACTIVE');
    await assert.rejects(service.load(game.id, 0), (error) => error.code === 'BOOT_GUARD_ACTIVE');
  } finally {
    env.db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('rejeita jogo inativo e slots fora do intervalo', async () => {
  const { env, game, service, active } = harness();
  try {
    await assert.rejects(service.save('another-game', 0), (error) => error.code === 'GAME_NOT_ACTIVE');
    await assert.rejects(service.save(game.id, -1), (error) => error.code === 'INVALID_SAVE_SLOT');
    active.gameId = game.id;
    await assert.rejects(service.save(game.id, 100), (error) => error.code === 'INVALID_SAVE_SLOT');
  } finally {
    env.db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});
