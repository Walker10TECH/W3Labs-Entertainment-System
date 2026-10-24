'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PS3_MARKERS = ['PS3_DISC.SFB', 'PS3_GAME', 'PS3VOLUME'];
const XBOX_MARKERS = ['XBOX_DVD', 'default.xbe'];
const ONE_AND_HALF_GIB = 1.5 * 1024 * 1024 * 1024;

function platformFromPath(filePath) {
  const normalized = String(filePath).replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/');
  const checks = [
    ['ps1', /^(ps1|psx|playstation(\s|_|-)?1?)$/],
    ['ps2', /^(ps2|playstation(\s|_|-)?2)$/],
    ['ps3', /^(ps3|playstation(\s|_|-)?3)$/],
    ['xbox', /^(xbox|xbox-classic)$/],
    ['xbox360', /^(xbox360|xbox(\s|_|-)?360|x360)$/],
    ['nes', /^(nes|nintendo(\s|_|-)?entertainment)$/],
    ['gb', /^(gb|gbc|gameboy|game(\s|_|-)?boy)$/],
  ];
  for (const segment of segments.slice(0, -1)) {
    for (const [platformId, pattern] of checks) {
      if (pattern.test(segment.trim())) return platformId;
    }
  }
  return null;
}

async function readSlice(filePath, length) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Resolve ISOs ambíguos. O scanner não pode depender só da extensão: .iso é
 * usado por PS1, PS2, PS3 e Xbox.
 */
async function detectIsoPlatform(filePath, { rootPlatformId = null, fileName = null } = {}) {
  if (rootPlatformId) return rootPlatformId;
  const name = String(fileName ?? path.basename(filePath));
  const extension = path.extname(name).toLowerCase();
  if (extension === '.xiso') return 'xbox';
  if (!['.iso', '.img'].includes(extension)) return null;

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return platformFromPath(filePath);
  }

  let slice = Buffer.alloc(0);
  try {
    // 4 MiB cobrem o volume descriptor, o root directory e o marcador XDVDFS
    // sem carregar a ISO inteira.
    slice = await readSlice(filePath, 4 * 1024 * 1024);
  } catch {
    return platformFromPath(filePath);
  }

  const ascii = slice.toString('latin1');
  if (PS3_MARKERS.some((marker) => ascii.includes(marker))) return 'ps3';
  if (ascii.includes('XEX2')) return 'xbox360';
  if (XBOX_MARKERS.some((marker) => ascii.includes(marker))) return 'xbox';
  if (ascii.includes('BOOT2') && ascii.includes('SYSTEM.CNF')) return 'ps2';
  if (/(^|[^A-Z])BOOT\s*=\s*cdrom/i.test(ascii) && ascii.includes('SYSTEM.CNF')) {
    return 'ps1';
  }

  const fromPath = platformFromPath(filePath);
  if (fromPath) return fromPath;

  // PS2 DVD images são grandes; PS1 fica abaixo de ~800 MB. Se não houver
  // marcador de PS3/Xbox e o arquivo for grande, PS2 é a hipótese segura.
  if (stat.size > ONE_AND_HALF_GIB) return 'ps2';
  return null;
}

module.exports = { detectIsoPlatform, platformFromPath };
