'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { LibraryService, cleanTitle, detectRegion } = require('../src/main/services/library-service');
const { createTestEnvironment, silentLogger, temporaryRoot } = require('./helpers');

function makeService(env) {
  return new LibraryService({
    db: env.db,
    paths: env.paths,
    logger: silentLogger,
    config: {
      scanning: {
        maxConcurrency: 2,
        ignoredDirectories: new Set(['node_modules', '.git', 'saves']),
      },
    },
  });
}

test('escaneia diretórios, evita duplicar .bin de cue e preserva arquivo ao remover', async () => {
  const env = createTestEnvironment();
  const libraryRoot = temporaryRoot('w3-library-files-');
  try {
    fs.mkdirSync(path.join(libraryRoot, 'ps1'), { recursive: true });
    fs.mkdirSync(path.join(libraryRoot, 'nes'), { recursive: true });
    fs.writeFileSync(path.join(libraryRoot, 'nes', 'Adventure (USA).nes'), Buffer.alloc(2048, 7));
    fs.writeFileSync(
      path.join(libraryRoot, 'ps1', 'RPG (Europe) (Disc 1).cue'),
      Buffer.from('FILE "x.bin" BINARY'),
    );
    fs.writeFileSync(path.join(libraryRoot, 'ps1', 'RPG (Europe) (Disc 1).bin'), Buffer.alloc(4096, 1));

    const service = makeService(env);
    const root = await service.addRoot(libraryRoot, null);
    assert.equal(root.platformId, null);

    const progress = [];
    const summary = await service.scanAll({ onProgress: (event) => progress.push(event) });
    assert.equal(summary.filesSeen, 3);
    assert.equal(summary.gamesAdded, 2);
    assert.ok(progress.some((event) => event.phase === 'hashing'));

    const games = service.list({ limit: 50 });
    assert.equal(games.length, 2);
    const nes = games.find((game) => game.platformId === 'nes');
    const ps1 = games.find((game) => game.platformId === 'ps1');
    assert.equal(nes.title, 'Adventure');
    assert.equal(nes.region, 'ntsc-u');
    assert.equal(ps1.region, 'pal');
    assert.equal(ps1.discNumber, 1);
    assert.equal(ps1.romHash.length, 40);

    assert.equal(service.list({ search: 'Nintendo' }).length, 1);
    assert.equal(service.list({ search: 'Europe' }).length, 0);
    assert.equal(service.list({ search: 'Adventure' }).length, 1);

    // Segundo scan não deve recalcular arquivos inalterados.
    const second = await service.scanAll();
    assert.equal(second.gamesAdded, 0);

    service.setFavorite(nes.id, true);
    assert.equal(service.list({ favorite: true }).length, 1);
    service.setRegion(nes.id, 'pal');
    assert.equal(service.get(nes.id).region, 'pal');

    const removed = service.removeFromLibrary(nes.id);
    assert.equal(removed.fileKept, true);
    assert.ok(fs.existsSync(nes.filePath), 'arquivo físico deve permanecer');
    assert.equal(service.list().length, 1);
  } finally {
    env.db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
    fs.rmSync(libraryRoot, { recursive: true, force: true });
  }
});

test('marca arquivos desaparecidos como missing sem apagar a linha', async () => {
  const env = createTestEnvironment();
  const libraryRoot = temporaryRoot('w3-library-missing-');
  try {
    fs.writeFileSync(path.join(libraryRoot, 'Game (Japan).nes'), Buffer.alloc(512, 2));
    const service = makeService(env);
    await service.addRoot(libraryRoot, 'nes');
    await service.scanAll();
    const [game] = service.list();
    assert.ok(game);
    fs.unlinkSync(game.filePath);
    await service.scanAll();
    assert.equal(service.list().length, 0);
    const row = env.db.get('SELECT is_missing FROM games WHERE id = ?', [game.id]);
    assert.equal(row.is_missing, 1);
  } finally {
    env.db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
    fs.rmSync(libraryRoot, { recursive: true, force: true });
  }
});

test('reescaneamento reclassifica a plataforma sem recalcular o hash', async () => {
  const env = createTestEnvironment();
  const libraryRoot = temporaryRoot('w3-library-reclass-');
  try {
    fs.writeFileSync(path.join(libraryRoot, 'Disc.iso'), Buffer.alloc(1024, 4));
    const service = makeService(env);
    await service.addRoot(libraryRoot, 'ps2');
    const first = await service.scanAll();
    assert.equal(first.gamesAdded, 1);
    assert.equal(service.list()[0].platformId, 'ps2');

    await service.addRoot(libraryRoot, 'ps3');
    const second = await service.scanAll();
    assert.equal(second.gamesAdded, 0);
    assert.equal(service.list()[0].platformId, 'ps3');
  } finally {
    env.db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
    fs.rmSync(libraryRoot, { recursive: true, force: true });
  }
});

test('normaliza títulos e regiões de nomes comuns', () => {
  assert.equal(cleanTitle('Final Fantasy VII (USA) (Disc 1).cue'), 'Final Fantasy VII');
  assert.equal(detectRegion('Game (Europe).iso'), 'pal');
  assert.equal(detectRegion('Game (Japan).nes'), 'ntsc-j');
  assert.equal(detectRegion('Game (USA).chd'), 'ntsc-u');
  assert.equal(detectRegion('Game.iso'), 'unknown');
});
