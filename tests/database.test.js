'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');
const { createTestEnvironment } = require('./helpers');

test('SQLite é configurado em WAL e cria o esquema', () => {
  const env = createTestEnvironment();
  try {
    const journal = env.db.pragma('journal_mode');
    assert.equal(String(journal[0].journal_mode).toLowerCase(), 'wal');
    const tables = env.db
      .all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((row) => row.name);
    for (const table of [
      'platforms',
      'games',
      'bios_files',
      'save_states',
      'play_sessions',
      'controller_profiles',
      'settings',
      'secret_store',
      'logs',
    ]) {
      assert.ok(tables.includes(table), `tabela ausente: ${table}`);
    }
    assert.equal(env.db.get('SELECT COUNT(*) AS count FROM platforms').count, 7);
  } finally {
    env.db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('foreign keys impedem jogo em plataforma inexistente', () => {
  const env = createTestEnvironment();
  try {
    assert.throws(
      () =>
        env.db.run(
          `INSERT INTO games (id, platform_id, title, sort_title, file_path, file_name, rom_hash)
           VALUES ('x', 'dreamcast', 'X', 'x', '/tmp/x', 'x', 'hash')`,
        ),
      /FOREIGN KEY/i,
    );
  } finally {
    env.db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('consulta de 1000 jogos permanece abaixo de 100 ms', () => {
  const env = createTestEnvironment();
  try {
    const insert = env.db.prepare(
      `INSERT INTO games (id, platform_id, title, sort_title, file_path, file_name, rom_hash)
       VALUES (?, 'nes', ?, ?, ?, ?, ?)`,
    );
    env.db.transaction(() => {
      for (let index = 0; index < 1000; index += 1) {
        const id = crypto.randomUUID();
        insert.run(
          id,
          `Game ${String(index).padStart(4, '0')}`,
          `game ${index}`,
          `/games/${id}.nes`,
          `${id}.nes`,
          crypto.createHash('sha1').update(id).digest('hex'),
        );
      }
    });
    const statement = env.db.prepare(
      `SELECT id, title FROM games
       WHERE is_missing = 0
       ORDER BY favorite DESC, sort_title COLLATE NOCASE
       LIMIT 300`,
    );
    // Aquecimento + medição; 100 ms é o RNF06 para uma listagem de 1000 jogos.
    statement.all();
    const started = process.hrtime.bigint();
    const rows = statement.all();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(rows.length, 300);
    assert.ok(elapsedMs < 100, `consulta levou ${elapsedMs.toFixed(2)}ms`);
  } finally {
    env.db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});
