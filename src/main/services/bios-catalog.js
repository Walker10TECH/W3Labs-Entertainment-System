'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../lib/errors');
const { PLATFORMS, normalizeRegion } = require('../../../config/platforms');

const KINDS = new Set(['bios', 'bootrom', 'flash', 'firmware']);

function normalizeEntry(entry, source) {
  if (!entry || typeof entry !== 'object') return null;
  const md5 = String(entry.md5 ?? '')
    .trim()
    .toLowerCase();
  const sha1 = entry.sha1 ? String(entry.sha1).trim().toLowerCase() : null;
  const platform = String(entry.platform ?? '').trim();
  const kind = String(entry.kind ?? '').trim();
  const region = normalizeRegion(entry.region);
  const size = Number(entry.size);
  if (!/^[a-f0-9]{32}$/.test(md5)) return null;
  if (sha1 && !/^[a-f0-9]{40}$/.test(sha1)) return null;
  if (!platform || !PLATFORMS[platform] || !KINDS.has(kind) || region === 'unknown') return null;
  if (!Number.isInteger(size) || size <= 0) return null;
  return Object.freeze({
    platform,
    kind,
    region,
    size,
    md5,
    sha1,
    label: String(entry.label || `${platform.toUpperCase()} ${kind}`),
    systemFileName: entry.systemFileName ? String(entry.systemFileName) : null,
    source,
  });
}

class BiosCatalog {
  constructor({ baseFile, customFile = null, logger = null }) {
    this.logger = logger;
    this.entries = [];
    this.byMd5 = new Map();
    this.load(baseFile, 'builtin');
    if (customFile && fs.existsSync(customFile)) this.load(customFile, 'custom');
  }

  load(file, source) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (source === 'custom') {
        this.logger?.warn('bios', 'Catálogo customizado inválido; ignorando.', {
          file,
          error: error.message,
        });
        return;
      }
      throw new AppError('BIOS_CATALOG_INVALID', `Catálogo de BIOS inválido: ${path.basename(file)}`);
    }
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    for (const raw of entries) {
      const entry = normalizeEntry(raw, source);
      if (!entry) {
        this.logger?.warn('bios', 'Entrada de catálogo ignorada por formato inválido.', {
          md5: raw?.md5,
          platform: raw?.platform,
        });
        continue;
      }
      if (this.byMd5.has(entry.md5)) continue;
      this.entries.push(entry);
      this.byMd5.set(entry.md5, entry);
    }
  }

  match(md5, platformHint = null) {
    const entry = this.byMd5.get(String(md5).toLowerCase());
    if (!entry) return null;
    if (platformHint && platformHint !== entry.platform) return null;
    return entry;
  }

  list() {
    return [...this.entries];
  }
}

const DEFAULT_CATALOG_FILE = path.resolve(__dirname, '../../../config/bios-catalog.json');

module.exports = { BiosCatalog, DEFAULT_CATALOG_FILE };
