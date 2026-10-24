'use strict';

const { AppError } = require('../lib/errors');

class SettingsService {
  constructor({ db, defaults = {}, vault }) {
    this.db = db;
    this.defaults = defaults;
    this.vault = vault;
    this.cache = new Map();
  }

  get(key) {
    if (this.cache.has(key)) return this.cache.get(key);
    const row = this.db.get('SELECT value_json FROM settings WHERE key = ?', [key]);
    let value = this.defaults[key] ?? null;
    if (row) {
      try {
        value = JSON.parse(row.value_json);
      } catch {
        // valor corrompido volta ao default
      }
    }
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new AppError('INVALID_SETTING', 'Valor de configuração não serializável.');
    }
    this.db.run(
      `INSERT INTO settings (key, value_json, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [String(key), serialized],
    );
    this.cache.set(String(key), value);
    return value;
  }

  setMany(values) {
    for (const [key, value] of Object.entries(values ?? {})) this.set(key, value);
    return this.getAll();
  }

  getAll() {
    const result = { ...this.defaults };
    for (const row of this.db.all('SELECT key, value_json FROM settings')) {
      try {
        result[row.key] = JSON.parse(row.value_json);
      } catch {
        // ignora valor inválido
      }
    }
    return result;
  }

  getSecret(name) {
    const row = this.db.get('SELECT ciphertext FROM secret_store WHERE name = ?', [name]);
    if (!row) return null;
    try {
      return this.vault.decrypt(row.ciphertext);
    } catch {
      return null;
    }
  }

  setSecret(name, value) {
    const ciphertext = this.vault.encrypt(String(value));
    this.db.run(
      `INSERT INTO secret_store (name, ciphertext, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
      [String(name), ciphertext],
    );
  }

  deleteSecret(name) {
    this.db.run('DELETE FROM secret_store WHERE name = ?', [String(name)]);
  }
}

module.exports = { SettingsService };
