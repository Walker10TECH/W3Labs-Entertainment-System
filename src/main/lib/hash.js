'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const DEFAULT_CHUNK_SIZE = 1024 * 1024;

/**
 * Calcula MD5 e SHA-1 em uma única passada de streaming. Nenhum arquivo é
 * carregado inteiro em memória, inclusive ISOs acima de 2 GB.
 */
async function hashFile(filePath, options = {}) {
  const {
    algorithms = ['md5', 'sha1'],
    chunkSize = DEFAULT_CHUNK_SIZE,
    onProgress = null,
    signal = null,
  } = options;

  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) {
    const error = new Error('O caminho informado não é um arquivo regular.');
    error.code = 'NOT_A_FILE';
    throw error;
  }

  const hashers = Object.fromEntries(
    algorithms.map((algorithm) => [algorithm, crypto.createHash(algorithm)]),
  );
  let bytes = 0;
  let lastNotified = 0;

  const source = fs.createReadStream(filePath, {
    highWaterMark: chunkSize,
    signal: signal ?? undefined,
  });

  try {
    for await (const chunk of source) {
      bytes += chunk.length;
      for (const hasher of Object.values(hashers)) hasher.update(chunk);
      if (onProgress && bytes - lastNotified >= 16 * 1024 * 1024) {
        lastNotified = bytes;
        onProgress({ bytes, totalBytes: stat.size });
      }
    }
  } finally {
    source.destroy();
  }

  const result = { bytes, size: stat.size };
  for (const [algorithm, hasher] of Object.entries(hashers)) {
    result[algorithm] = hasher.digest('hex');
  }
  onProgress?.({ bytes, totalBytes: stat.size, done: true });
  return result;
}

function hashBuffer(buffer, algorithm = 'sha1') {
  return crypto.createHash(algorithm).update(buffer).digest('hex');
}

/** Lê somente o cabeçalho de mídias grandes (ex.: assinatura de ISO). */
async function readHeader(filePath, bytes = 64 * 1024) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(bytes, 1024 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

module.exports = {
  DEFAULT_CHUNK_SIZE,
  hashFile,
  hashBuffer,
  readHeader,
};
