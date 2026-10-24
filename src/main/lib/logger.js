'use strict';

const fs = require('node:fs');
const path = require('node:path');

function serializeMeta(meta) {
  if (!meta) return '';
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ' {"note":"meta não serializável"}';
  }
}

class Logger {
  constructor({ logsDir, consoleEnabled = true } = {}) {
    this.logsDir = logsDir;
    this.consoleEnabled = consoleEnabled;
    this.db = null;
    this.writeChain = Promise.resolve();
    if (logsDir) fs.mkdirSync(logsDir, { recursive: true });
  }

  attachDatabase(db) {
    this.db = db;
  }

  log(level, scope, message, meta = null) {
    const now = new Date();
    const line = `[${now.toISOString()}] ${level.toUpperCase().padEnd(5)} ${scope} :: ${message}${serializeMeta(meta)}\n`;
    if (this.consoleEnabled) {
      const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
      console[method](line.trimEnd());
    }

    if (this.logsDir) {
      const file = path.join(this.logsDir, `w3labs-${now.toISOString().slice(0, 10)}.txt`);
      this.writeChain = this.writeChain
        .then(() => fs.promises.appendFile(file, line, 'utf8'))
        .catch((error) => {
          if (this.consoleEnabled) console.error('[logger] falha ao gravar TXT:', error.message);
        });
    }

    if (this.db) {
      try {
        this.db.run(
          'INSERT INTO logs (level, scope, message, meta_json, created_at) VALUES (?, ?, ?, ?, ?)',
          [level, scope, message, meta ? JSON.stringify(meta) : null, now.toISOString()],
        );
      } catch (error) {
        if (this.consoleEnabled) console.error('[logger] falha ao gravar SQLite:', error.message);
      }
    }
  }

  info(scope, message, meta) {
    this.log('info', scope, message, meta);
  }

  warn(scope, message, meta) {
    this.log('warn', scope, message, meta);
  }

  error(scope, message, meta) {
    this.log('error', scope, message, meta);
  }

  debug(scope, message, meta) {
    if (process.env.W3_DEBUG === '1') this.log('debug', scope, message, meta);
  }

  async flush() {
    await this.writeChain;
  }
}

module.exports = { Logger };
