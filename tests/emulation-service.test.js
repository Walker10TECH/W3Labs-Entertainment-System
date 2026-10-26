'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { EmulationService } = require('../src/main/services/emulation-service');
const { CoreRegistry } = require('../src/main/cores/core-registry');
const { createTestEnvironment, insertGame, silentLogger } = require('./helpers');

function buildService({ env, game, coreManager, settings }) {
  const coreRegistry = new CoreRegistry({ configFile: null, logger: silentLogger });
  return new EmulationService({
    db: env.db,
    paths: env.paths,
    library: {
      async verifyGameFile() {
        return {
          ...game,
          platformId: game.platform_id,
          filePath: game.file_path,
          romHash: game.rom_hash,
        };
      },
    },
    bios: {
      async resolveForGame() {
        return [];
      },
    },
    hardware: {
      async assess() {
        return { warnings: [], info: {} };
      },
    },
    media: {
      async inspect() {
        return { kind: 'iso' };
      },
    },
    coreRegistry,
    coreManager,
    settings,
    logger: silentLogger,
    config: { emulation: {} },
  });
}

test('lançamento entrega as preferências do app ao núcleo e reporta o que chegou', async () => {
  const env = createTestEnvironment();
  const game = insertGame(env.db, { platformId: 'ps2', title: 'Windowed Test' });
  const captured = {};
  const coreManager = Object.assign(new EventEmitter(), {
    async start(config) {
      Object.assign(captured, config);
      return { sessionId: 'session-1', transport: 'external', pid: 4242 };
    },
    async stop() {
      return { stopped: true };
    },
    async shutdownAll() {},
  });
  const settings = {
    getAll: () => ({ 'video.resolution': 'windowed', 'video.filter': 'bilinear', 'audio.volume': 50 }),
    get: (key) => settings.getAll()[key],
  };
  const previous = process.env.W3_CORE_PCSX2;
  process.env.W3_CORE_PCSX2 = process.execPath;
  const service = buildService({ env, game, coreManager, settings });
  try {
    const session = await service.launch(game.id);
    assert.ok(captured.args.includes('-nofullscreen'));
    assert.ok(!captured.args.includes('-fullscreen'));
    assert.equal(captured.fullscreen, false);
    assert.equal(captured.preferences.applied[0].detail, 'janela');
    assert.ok(captured.preferences.ignored.some((entry) => entry.setting === 'audio.volume'));
    assert.equal(session.preferences.applied.length, 1);
    assert.equal(service.getActive().preferences.applied[0].kind, 'cli');
    assert.ok(
      captured.environment.W3_LAUNCH_PREFERENCES.includes('"fullscreen":false'),
      'bridge precisa receber as preferências normalizadas pelo init',
    );
  } finally {
    await service.shutdown();
    if (previous === undefined) delete process.env.W3_CORE_PCSX2;
    else process.env.W3_CORE_PCSX2 = previous;
    env.db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});
