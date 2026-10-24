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
