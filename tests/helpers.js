'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppPaths } = require('../src/main/lib/paths');
const { AppDatabase } = require('../src/main/db/database');

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  attachDatabase() {},
  async flush() {},
};

function temporaryRoot(prefix = 'w3labs-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createTestEnvironment() {
  const root = temporaryRoot();
  const paths = new AppPaths({ dataRoot: root });
  const db = new AppDatabase(paths.database, { logger: silentLogger });
  return { root, paths, db };
}

function insertGame(db, overrides = {}) {
  const id = overrides.id ?? crypto.randomUUID();
  const platformId = overrides.platformId ?? 'nes';
  const filePath = overrides.filePath ?? path.join(os.tmpdir(), `${id}.nes`);
  const hash = overrides.romHash ?? crypto.createHash('sha1').update(id).digest('hex');
  db.run(
    `INSERT INTO games (
       id, platform_id, title, sort_title, file_path, file_name, file_size,
       file_mtime_ms, rom_hash, rom_md5, region
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      platformId,
      overrides.title ?? 'Test Game',
      (overrides.title ?? 'Test Game').toLowerCase(),
      filePath,
      path.basename(filePath),
      overrides.fileSize ?? 1024,
      overrides.mtime ?? Date.now(),
      hash,
      overrides.romMd5 ?? crypto.createHash('md5').update(id).digest('hex'),
      overrides.region ?? 'unknown',
    ],
  );
  return db.get('SELECT * FROM games WHERE id = ?', [id]);
}

function writeFixtureFile(directory, name, bytes = 4096) {
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, Buffer.alloc(bytes, Math.floor(Math.random() * 255)));
  return filePath;
}

module.exports = {
  silentLogger,
  temporaryRoot,
  createTestEnvironment,
  insertGame,
  writeFixtureFile,
};
