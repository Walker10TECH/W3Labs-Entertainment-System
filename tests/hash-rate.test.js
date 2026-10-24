'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { hashFile, readHeader } = require('../src/main/lib/hash');
const { RateLimiter } = require('../src/main/lib/rate-limiter');
const { createRuntimeConfig } = require('../src/main/config');
const { temporaryRoot } = require('./helpers');

test('hash em streaming calcula MD5 e SHA-1 sem alterar o arquivo', async () => {
  const root = temporaryRoot('w3-hash-');
  const file = path.join(root, 'rom.bin');
  const data = crypto.randomBytes(17 * 1024 * 1024 + 17);
  fs.writeFileSync(file, data);
  try {
    const progress = [];
    const result = await hashFile(file, {
      chunkSize: 64 * 1024,
      onProgress: (event) => progress.push(event),
    });
    assert.equal(result.md5, crypto.createHash('md5').update(data).digest('hex'));
    assert.equal(result.sha1, crypto.createHash('sha1').update(data).digest('hex'));
    assert.equal(result.bytes, data.length);
    assert.equal(fs.statSync(file).size, data.length);
    assert.ok(progress.length >= 2, 'progresso intermediário não emitido');
    assert.ok(progress.some((event) => event.bytes > 0 && !event.done));
    assert.ok(progress.at(-1).done);
    const header = await readHeader(file, 32);
    assert.deepEqual(header, data.subarray(0, 32));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rate limiter respeita janela deslizante e espaçamento', async () => {
  const limiter = new RateLimiter({ maxRequests: 3, windowMs: 120, minIntervalMs: 25 });
  const started = Date.now();
  const times = [];
  await Promise.all(
    Array.from({ length: 4 }, () =>
      limiter.run(async () => {
        times.push(Date.now() - started);
      }),
    ),
  );
  assert.equal(times.length, 4);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 120, `4 requisições levaram apenas ${elapsed}ms`);
  assert.ok(times[1] - times[0] >= 20, 'espaçamento mínimo não aplicado');
});

test('configuração de metadados usa 50 requisições por minuto', () => {
  const config = createRuntimeConfig({ appRoot: temporaryRoot('w3-config-'), isPackaged: false });
  try {
    assert.equal(config.metadata.requestsPerWindow, 50);
    assert.equal(config.metadata.windowMs, 60_000);
  } finally {
    fs.rmSync(config.appRoot, { recursive: true, force: true });
  }
});
