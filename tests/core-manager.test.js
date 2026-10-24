'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { CoreManager } = require('../src/main/cores/core-manager');
const { silentLogger, temporaryRoot } = require('./helpers');

test('núcleo roda em processo filho e executa comandos via bridge JSONL', async () => {
  const root = temporaryRoot('w3-core-');
  const stateDir = path.join(root, 'saves', 'nes', 'a'.repeat(40));
  const romPath = path.join(root, 'game.nes');
  fs.writeFileSync(romPath, Buffer.alloc(4096, 3));
  const manager = new CoreManager({ logger: silentLogger, stopGraceMs: 1_500 });
  try {
    const info = await manager.start({
      platformId: 'nes',
      gameId: 'game-1',
      coreId: 'test-bridge',
      romPath,
      stateDir,
      executable: null,
      args: [],
      bridgeCommand: [process.execPath, path.join(__dirname, 'fixtures', 'fake-bridge.js')],
      environment: {},
      capabilities: { pause: true, saveState: true, loadState: true, screenshot: false },
      biosFiles: [],
      fullscreen: false,
    });
    assert.equal(info.transport, 'bridge');
    assert.ok(info.pid > 0);
    assert.notEqual(info.pid, process.pid);

    const target = path.join(stateDir, '3.state');
    const saved = await manager.request(info.sessionId, 'save-state', { slot: 3, statePath: target });
    assert.equal(saved.saved, true);
    assert.ok(fs.existsSync(target));

    await manager.request(info.sessionId, 'pause');
    await manager.request(info.sessionId, 'resume');
    await manager.request(info.sessionId, 'load-state', { slot: 3, statePath: target });

    await assert.rejects(
      manager.request(info.sessionId, 'save-state', { slot: 4, statePath: path.join(root, 'escape.state') }),
      (error) => error.code === 'STATE_PATH_OUTSIDE',
    );

    await manager.stop(info.sessionId);
    assert.equal(manager.activeCount, 0);
  } finally {
    await manager.shutdownAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
