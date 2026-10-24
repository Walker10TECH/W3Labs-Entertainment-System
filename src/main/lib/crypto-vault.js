'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KEY_BYTES = 32;
const IV_BYTES = 12;

function loadOrCreateKey(keyPath) {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  try {
    const encoded = fs.readFileSync(keyPath, 'utf8').trim();
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== KEY_BYTES) throw new Error('Chave AES-256 inválida.');
    return key;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const key = crypto.randomBytes(KEY_BYTES);
    try {
      fs.writeFileSync(keyPath, key.toString('base64'), { mode: 0o600, flag: 'wx' });
      return key;
    } catch (writeError) {
      if (writeError.code === 'EEXIST') return loadOrCreateKey(keyPath);
      throw writeError;
    }
  }
}

class CryptoVault {
  constructor({ keyPath }) {
    this.keyPath = keyPath;
    this.key = loadOrCreateKey(keyPath);
  }

  encrypt(plainText) {
    if (typeof plainText !== 'string') throw new TypeError('Texto a cifrar deve ser string.');
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
  }

  decrypt(payload) {
    const parts = String(payload).split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw new Error('Formato de segredo cifrado inválido.');
    }
    const [, ivB64, tagB64, dataB64] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return decrypted.toString('utf8');
  }

  encryptJson(value) {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson(payload) {
    return JSON.parse(this.decrypt(payload));
  }
}

module.exports = { CryptoVault, loadOrCreateKey };
