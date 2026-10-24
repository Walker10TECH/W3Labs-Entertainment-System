'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HASH_PATTERN = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[a-zA-Z0-9._-]+$/;

function isInside(baseDir, candidate) {
  const base = path.resolve(baseDir);
  const target = path.resolve(candidate);
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertInside(baseDir, candidate, label = 'caminho') {
  if (!isInside(baseDir, candidate)) {
    const error = new Error(`Acesso negado: ${label} está fora do diretório permitido.`);
    error.code = 'PATH_OUTSIDE_SANDBOX';
    throw error;
  }
  return candidate;
}

function sanitizeSegment(value) {
  const segment = String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return segment || 'item';
}

class AppPaths {
  constructor({ dataRoot, appRoot = null }) {
    this.dataRoot = path.resolve(dataRoot);
    this.appRoot = appRoot ? path.resolve(appRoot) : this.dataRoot;
    this.storage = path.join(this.dataRoot, 'data');
    this.database = path.join(this.storage, 'w3labs.db');
    this.configDir = path.join(this.storage, 'config');
    this.saves = path.join(this.dataRoot, 'saves');
    this.bios = path.join(this.storage, 'bios');
    this.covers = path.join(this.storage, 'covers');
    this.logs = path.join(this.dataRoot, 'logs');
    this.cache = path.join(this.storage, 'cache');
    this.coresConfig = path.join(this.storage, 'cores.json');
    this.customBiosCatalog = path.join(this.storage, 'bios-catalog.custom.json');
    this.ensure();
  }

  ensure() {
    for (const directory of [
      this.dataRoot,
      this.storage,
      this.configDir,
      this.saves,
      this.bios,
      this.covers,
      this.logs,
      this.cache,
    ]) {
      fs.mkdirSync(directory, { recursive: true });
    }
  }

  saveStatePath(platformId, romHash, slot) {
    if (!SAFE_ID.test(String(platformId))) {
      const error = new Error('Identificador de plataforma inválido.');
      error.code = 'INVALID_PLATFORM';
      throw error;
    }
    if (!HASH_PATTERN.test(String(romHash))) {
      const error = new Error('Hash SHA-1 da ROM inválido.');
      error.code = 'INVALID_ROM_HASH';
      throw error;
    }
    const parsedSlot = Number(slot);
    if (!Number.isInteger(parsedSlot) || parsedSlot < 0 || parsedSlot > 99) {
      const error = new Error('Slot deve ser um inteiro entre 0 e 99.');
      error.code = 'INVALID_SAVE_SLOT';
      throw error;
    }
    const directory = path.join(this.saves, platformId, romHash);
    return {
      directory,
      filePath: path.join(directory, `${parsedSlot}.state`),
    };
  }

  coverPath(gameId, extension = 'jpg') {
    if (!SAFE_ID.test(String(gameId))) {
      const error = new Error('Identificador de jogo inválido.');
      error.code = 'INVALID_GAME_ID';
      throw error;
    }
    const ext = String(extension)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
      const error = new Error('Extensão de capa inválida.');
      error.code = 'INVALID_COVER_EXTENSION';
      throw error;
    }
    return path.join(this.covers, `${gameId}.${ext}`);
  }

  biosPath(platformId, label, md5) {
    if (!SAFE_ID.test(String(platformId)) || !/^[a-f0-9]{32}$/.test(String(md5))) {
      const error = new Error('Metadados inválidos para o destino da BIOS.');
      error.code = 'INVALID_BIOS_METADATA';
      throw error;
    }
    const directory = path.join(this.bios, platformId);
    const fileName = `${sanitizeSegment(label)}-${String(md5).slice(0, 8)}.bin`;
    return { directory, filePath: path.join(directory, fileName) };
  }

  logFile(date = new Date()) {
    const day = date.toISOString().slice(0, 10);
    return path.join(this.logs, `w3labs-${day}.txt`);
  }

  assertCoverPath(candidate) {
    return assertInside(this.covers, candidate, 'capa');
  }

  assertBiosPath(candidate) {
    return assertInside(this.bios, candidate, 'BIOS');
  }

  assertSavePath(candidate) {
    return assertInside(this.saves, candidate, 'save state');
  }
}

module.exports = {
  AppPaths,
  isInside,
  assertInside,
  sanitizeSegment,
  HASH_PATTERN,
};
