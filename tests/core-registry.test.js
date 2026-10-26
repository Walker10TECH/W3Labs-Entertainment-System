'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { CoreRegistry } = require('../src/main/cores/core-registry');
const { silentLogger, temporaryRoot } = require('./helpers');

test('registro expõe todos os núcleos e monta launch spec com tokens', () => {
  const root = temporaryRoot('w3-registry-');
  const previous = process.env.W3_CORE_DUCKSTATION;
  process.env.W3_CORE_DUCKSTATION = process.execPath;
  try {
    const registry = new CoreRegistry({ configFile: null, logger: silentLogger });
    assert.ok(registry.statusAll().length >= 6);
    const status = registry.statusForPlatform('ps1');
    assert.equal(status.defaultCore, 'duckstation');
    assert.equal(status.cores[0].installed, true);

    const stateDir = path.join(root, 'saves', 'ps1', 'a'.repeat(40));
    const spec = registry.buildLaunchSpec(
      'ps1',
      { id: 'game-1', filePath: path.join(root, 'Game.cue') },
      [],
      { stateDir },
    );
    assert.equal(spec.coreId, 'duckstation');
    assert.equal(spec.executable, process.execPath);
    assert.ok(spec.args.includes(path.join(root, 'Game.cue')));
    assert.ok(spec.args.includes('--'));
    assert.equal(spec.stateDir, stateDir);
  } finally {
    if (previous === undefined) delete process.env.W3_CORE_DUCKSTATION;
    else process.env.W3_CORE_DUCKSTATION = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('launch spec converte preferências do app em opções do núcleo', () => {
  const root = temporaryRoot('w3-registry-');
  const previous = process.env.W3_CORE_PCSX2;
  process.env.W3_CORE_PCSX2 = process.execPath;
  try {
    const registry = new CoreRegistry({ configFile: null, logger: silentLogger });
    const spec = registry.buildLaunchSpec(
      'ps2',
      { id: 'game-2', filePath: path.join(root, 'Game.iso') },
      [],
      {
        stateDir: path.join(root, 'saves', 'ps2', 'b'.repeat(40)),
        preferences: { 'video.resolution': 'windowed', 'audio.volume': 20 },
        overlayDirectory: path.join(root, 'overlays'),
      },
    );
    assert.ok(spec.args.includes('-nofullscreen'));
    assert.ok(!spec.args.includes('-fullscreen'));
    assert.ok(spec.args.indexOf('-nofullscreen') < spec.args.indexOf('--'));
    assert.equal(spec.preferences.applied[0].kind, 'cli');
    assert.equal(spec.preferences.applied[0].detail, 'janela');
    assert.equal(JSON.parse(spec.environment.W3_LAUNCH_PREFERENCES).fullscreen, false);
    assert.ok(spec.preferences.ignored.some((entry) => entry.setting === 'audio.volume'));
    assert.equal(spec.preferences.overlayPath, null);
  } finally {
    if (previous === undefined) delete process.env.W3_CORE_PCSX2;
    else process.env.W3_CORE_PCSX2 = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
