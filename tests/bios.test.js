'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { BiosCatalog } = require('../src/main/services/bios-catalog');
const { BiosService } = require('../src/main/services/bios-service');
const { createTestEnvironment, insertGame, silentLogger, temporaryRoot } = require('./helpers');

function buildCatalog(buffer) {
  const root = temporaryRoot('w3-bios-catalog-');
  const file = path.join(root, 'catalog.json');
  const md5 = crypto.createHash('md5').update(buffer).digest('hex');
  const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      entries: [
        {
          platform: 'ps1',
          region: 'ntsc-u',
          kind: 'bios',
          label: 'Test BIOS NTSC-U',
          size: buffer.length,
          md5,
          sha1,
          systemFileName: 'scph-test.bin',
        },
      ],
    }),
  );
  return { root, file, md5, sha1 };
}

test('importa BIOS somente com hash reconhecido e valida na execução', async () => {
  const env = createTestEnvironment();
  const catalogRoot = temporaryRoot('w3-catalog-source-');
  let catalogFile;
  try {
    const biosBytes = crypto.randomBytes(32 * 1024);
    catalogFile = buildCatalog(biosBytes);
    const catalog = new BiosCatalog({ baseFile: catalogFile.file, logger: silentLogger });
    const service = new BiosService({
      db: env.db,
      paths: env.paths,
      catalog,
      logger: silentLogger,
    });

    const source = path.join(catalogRoot, 'scph.bin');
    fs.writeFileSync(source, biosBytes);

    const imported = await service.importFromFile(source);
    assert.equal(imported.platformId, 'ps1');
    assert.equal(imported.region, 'ntsc-u');
    assert.equal(imported.status, 'valid');
    assert.equal(imported.md5, catalogFile.md5);
    assert.equal(imported.sha1, catalogFile.sha1);
    assert.ok(fs.existsSync(path.join(env.paths.bios, 'ps1')));

    const duplicate = await service.importFromFile(source);
    assert.equal(duplicate.id, imported.id);

    const game = { platformId: 'ps1', region: 'ntsc-u' };
    const resolved = await service.resolveForGame(game);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].kind, 'bios');
    assert.equal(resolved[0].md5, catalogFile.md5);

    await assert.rejects(
      service.resolveForGame({ platformId: 'ps1', region: 'pal' }),
      (error) => error.code === 'BIOS_REQUIRED',
    );

    const matrix = service.getMatrix();
    const ps1 = matrix.find((entry) => entry.platformId === 'ps1');
    assert.equal(ps1.ready, true);

    // Alterar o arquivo no disco invalida a BIOS no próximo boot.
    const storedPath = resolved[0].path;
    fs.writeFileSync(storedPath, crypto.randomBytes(biosBytes.length));
    await assert.rejects(service.resolveForGame(game), (error) => error.code === 'BIOS_TAMPERED');
  } finally {
    env.db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
    fs.rmSync(catalogRoot, { recursive: true, force: true });
    if (catalogFile) fs.rmSync(catalogFile.root, { recursive: true, force: true });
  }
});

test('rejeita BIOS desconhecida sem copiar o arquivo', async () => {
  const env = createTestEnvironment();
  const sourceRoot = temporaryRoot('w3-bios-bad-');
  try {
    const catalogFile = buildCatalog(Buffer.from('expected-bios'));
    const catalog = new BiosCatalog({ baseFile: catalogFile.file, logger: silentLogger });
    const service = new BiosService({ db: env.db, paths: env.paths, catalog, logger: silentLogger });
    const source = path.join(sourceRoot, 'unknown.bin');
    fs.writeFileSync(source, Buffer.from('not-the-catalogued-bios'));
    await assert.rejects(
      service.importFromFile(source),
      (error) => error.code === 'BIOS_HASH_NOT_RECOGNIZED',
    );
    assert.equal(service.list().length, 0);
    fs.rmSync(catalogFile.root, { recursive: true, force: true });
  } finally {
    env.db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test('região desconhecida bloqueia jogo que exige BIOS', async () => {
  const env = createTestEnvironment();
  try {
    const catalogFile = buildCatalog(Buffer.from('x'.repeat(1024)));
    const service = new BiosService({
      db: env.db,
      paths: env.paths,
      catalog: new BiosCatalog({ baseFile: catalogFile.file, logger: silentLogger }),
      logger: silentLogger,
    });
    insertGame(env.db, { platformId: 'ps1', region: 'unknown', filePath: '/tmp/game.cue' });
    await assert.rejects(
      service.resolveForGame({ platformId: 'ps1', region: 'unknown' }),
      (error) => error.code === 'BIOS_REGION_REQUIRED',
    );
    fs.rmSync(catalogFile.root, { recursive: true, force: true });
  } finally {
    env.db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('importa BIOS personalizada atestada e revalida o hash antes do boot', async () => {
  const env = createTestEnvironment();
  const sourceRoot = temporaryRoot('w3-bios-custom-');
  let catalogFile;
  try {
    catalogFile = buildCatalog(Buffer.from('catalog-only'));
    const service = new BiosService({
      db: env.db,
      paths: env.paths,
      catalog: new BiosCatalog({ baseFile: catalogFile.file, logger: silentLogger }),
      logger: silentLogger,
    });
    const source = path.join(sourceRoot, 'meu-dump-ps1.bin');
    fs.writeFileSync(source, crypto.randomBytes(512 * 1024));

    await assert.rejects(
      service.importCustomFromFile(source, {
        platformId: 'ps1',
        region: 'ntsc-u',
        kind: 'bios',
        acknowledged: false,
      }),
      (error) => error.code === 'BIOS_CUSTOM_ACK_REQUIRED',
    );

    const wrongSize = path.join(sourceRoot, 'tamanho-errado.bin');
    fs.writeFileSync(wrongSize, Buffer.alloc(1024, 1));
    await assert.rejects(
      service.importCustomFromFile(wrongSize, {
        platformId: 'ps1',
        region: 'ntsc-u',
        kind: 'bios',
        acknowledged: true,
      }),
      (error) => error.code === 'BIOS_CUSTOM_SIZE_INVALID',
    );

    const imported = await service.importCustomFromFile(source, {
      platformId: 'ps1',
      region: 'ntsc-u',
      kind: 'bios',
      label: 'Meu dump verificado',
      acknowledged: true,
    });
    assert.equal(imported.isCustom, true);
    assert.equal(imported.verificationMethod, 'user-attested-hash');
    assert.equal(imported.region, 'ntsc-u');
    assert.equal(service.getMatrix().find((entry) => entry.platformId === 'ps1').ready, true);

    const duplicate = await service.importCustomFromFile(source, {
      platformId: 'ps1',
      region: 'ntsc-u',
      kind: 'bios',
      acknowledged: true,
    });
    assert.equal(duplicate.id, imported.id);

    const resolved = await service.resolveForGame({ platformId: 'ps1', region: 'ntsc-u' });
    assert.equal(resolved.length, 1);
    fs.writeFileSync(resolved[0].path, crypto.randomBytes(512 * 1024));
    await assert.rejects(
      service.resolveForGame({ platformId: 'ps1', region: 'ntsc-u' }),
      (error) => error.code === 'BIOS_TAMPERED',
    );
  } finally {
    env.db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    if (catalogFile) fs.rmSync(catalogFile.root, { recursive: true, force: true });
  }
});
