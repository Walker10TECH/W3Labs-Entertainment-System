'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { PLATFORMS } = require('../../../config/platforms');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function normalizeParams(params) {
  return params.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

/**
 * Conexão única do processo principal. Todas as consultas usam prepared
 * statements; WAL permite leitura da biblioteca durante a escrita de playtime.
 */
class AppDatabase {
  constructor(filePath, { logger = null } = {}) {
    this.filePath = filePath;
    this.logger = logger;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.raw = new DatabaseSync(filePath, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    this.closed = false;
    this.configure();
    this.migrate();
    this.seedPlatforms();
  }

  configure() {
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA wal_autocheckpoint = 1000;
      PRAGMA temp_store = MEMORY;
    `);
  }

  migrate() {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);

    const applied = new Set(
      this.raw
        .prepare('SELECT version FROM schema_migrations')
        .all()
        .map((row) => Number(row.version)),
    );

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((file) => /^\d+_.+\.sql$/.test(file))
      .sort((a, b) => a.localeCompare(b));

    for (const file of files) {
      const version = Number(file.slice(0, file.indexOf('_')));
      if (applied.has(version)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        this.raw.exec(sql);
        this.raw.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(version, file);
        this.raw.exec('COMMIT');
        this.logger?.info('db', `Migração aplicada: ${file}`);
      } catch (error) {
        this.raw.exec('ROLLBACK');
        throw error;
      }
    }
  }

  seedPlatforms() {
    const statement = this.raw.prepare(`
      INSERT INTO platforms (
        id, name, short_name, manufacturer, generation, rom_extensions,
        max_players, heavy, bios_required, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        short_name = excluded.short_name,
        manufacturer = excluded.manufacturer,
        generation = excluded.generation,
        rom_extensions = excluded.rom_extensions,
        max_players = excluded.max_players,
        heavy = excluded.heavy,
        bios_required = excluded.bios_required,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `);

    this.transaction(() => {
      for (const platform of Object.values(PLATFORMS)) {
        statement.run(
          platform.id,
          platform.name,
          platform.shortName,
          platform.manufacturer,
          platform.generation,
          JSON.stringify(platform.extensions),
          platform.maxPlayers,
          platform.heavy ? 1 : 0,
          platform.bios.required ? 1 : 0,
        );
      }
    });
  }

  prepare(sql) {
    return this.raw.prepare(sql);
  }

  run(sql, params = []) {
    return this.prepare(sql).run(...normalizeParams(params));
  }

  get(sql, params = []) {
    return this.prepare(sql).get(...normalizeParams(params));
  }

  all(sql, params = []) {
    return this.prepare(sql).all(...normalizeParams(params));
  }

  transaction(fn) {
    if (this.closed) throw new Error('Banco de dados fechado.');
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        // A transação pode já ter sido desfeita pelo SQLite.
      }
      throw error;
    }
  }

  pragma(name) {
    const safe = String(name).replace(/[^a-z0-9_]/gi, '');
    return this.raw.prepare(`PRAGMA ${safe}`).all();
  }

  checkpoint() {
    try {
      this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (error) {
      this.logger?.warn('db', 'Falha ao executar checkpoint WAL.', { error: error.message });
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.checkpoint();
    this.raw.close();
  }
}

module.exports = { AppDatabase };
