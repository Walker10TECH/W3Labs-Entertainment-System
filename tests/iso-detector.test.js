'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { detectIsoPlatform, platformFromPath } = require('../src/main/services/iso-detector');
const { temporaryRoot } = require('./helpers');

function writeIso(root, name, marker) {
  const file = path.join(root, name);
  const buffer = Buffer.alloc(1024 * 1024);
  Buffer.from(marker).copy(buffer, 128);
  fs.writeFileSync(file, buffer);
  return file;
}

test('detecta ISO de PS3 e Xbox por marcadores internos', async () => {
  const root = temporaryRoot('w3-iso-');
  try {
    const ps3 = writeIso(root, 'game-ps3.iso', 'PS3_DISC.SFB PS3_GAME');
    const xbox = writeIso(root, 'game-xbox.iso', 'XBOX_DVD');
    const ps2 = writeIso(root, 'game-ps2.iso', 'SYSTEM.CNF;1 BOOT2 = cdrom0:\\SLUS_000.00;1');
    assert.equal(await detectIsoPlatform(ps3), 'ps3');
    assert.equal(await detectIsoPlatform(xbox), 'xbox');
    assert.equal(await detectIsoPlatform(ps2), 'ps2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('usa a pasta como dica quando a ISO não expõe marcador', async () => {
  const root = temporaryRoot('w3-iso-path-');
  try {
    const ps2Dir = path.join(root, 'PS2');
    fs.mkdirSync(ps2Dir, { recursive: true });
    const file = writeIso(ps2Dir, 'unknown.iso', 'no marker');
    assert.equal(platformFromPath(file), 'ps2');
    assert.equal(await detectIsoPlatform(file), 'ps2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('respeita a plataforma explícita da raiz', async () => {
  const root = temporaryRoot('w3-iso-root-');
  try {
    const file = writeIso(root, 'game.iso', 'PS3_DISC.SFB');
    assert.equal(await detectIsoPlatform(file, { rootPlatformId: 'ps2' }), 'ps2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
