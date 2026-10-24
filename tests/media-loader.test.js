'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { MediaLoader } = require('../src/main/services/media-loader');
const { silentLogger, temporaryRoot } = require('./helpers');

test('inspeciona ROM e ISO sem carregar a mídia na memória', async () => {
  const root = temporaryRoot('w3-media-');
  const loader = new MediaLoader({ logger: silentLogger });
  try {
    const romPath = path.join(root, 'Game (USA).nes');
    const isoPath = path.join(root, 'Game (USA).iso');
    fs.writeFileSync(romPath, Buffer.concat([Buffer.from('NES\x1a'), Buffer.alloc(4096, 7)]));
    fs.writeFileSync(isoPath, Buffer.alloc(128 * 1024, 3));

    const rom = await loader.loadRom({ platformId: 'nes', filePath: romPath });
    assert.equal(rom.mediaType, 'rom');
    assert.equal(rom.loadedInMemory, false);
    assert.equal(rom.readStrategy, 'stream-on-disk');
    assert.ok(rom.headerBytes <= 64 * 1024);
    assert.equal(rom.sizeBytes, 4100);

    const iso = await loader.loadIso({ platformId: 'ps2', filePath: isoPath });
    assert.equal(iso.mediaType, 'iso');
    assert.equal(iso.loadedInMemory, false);
    assert.equal(iso.sizeBytes, 128 * 1024);

    const stream = loader.openStream({ filePath: romPath }, { start: 0, end: 2 });
    let bytes = '';
    for await (const chunk of stream) bytes += chunk.toString('latin1');
    assert.equal(bytes, 'NES');

    await assert.rejects(
      loader.inspect({ platformId: 'ps2', filePath: romPath }),
      (error) => error.code === 'MEDIA_EXTENSION_UNSUPPORTED',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
