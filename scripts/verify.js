'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const requiredFiles = [
  'package.json',
  'src/main/main.js',
  'src/preload/preload.js',
  'src/renderer/index.html',
  'src/main/db/migrations/001_initial.sql',
  'src/main/db/migrations/002_custom_bios.sql',
  'config/platforms.js',
  'config/bios-catalog.json',
];
const errors = [];

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  errors.push(`Node ${process.versions.node} é antigo; use 22.13+ (recomendado 24).`);
}

try {
  require('node:sqlite');
} catch {
  errors.push('node:sqlite indisponível. Use Node 22.13+ ou o Electron 45.');
}

for (const relative of requiredFiles) {
  if (!fs.existsSync(path.join(root, relative))) errors.push(`Arquivo ausente: ${relative}`);
}

try {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'config/bios-catalog.json'), 'utf8'));
  if (!Array.isArray(catalog.entries) || catalog.entries.length === 0) {
    errors.push('Catálogo de BIOS vazio ou inválido.');
  }
} catch (error) {
  errors.push(`Catálogo de BIOS inválido: ${error.message}`);
}

const { PLATFORMS } = require(path.join(root, 'config/platforms'));
if (Object.keys(PLATFORMS).length !== 7) errors.push('Esperadas 7 plataformas em config/platforms.js.');

if (errors.length > 0) {
  console.error('Falha na verificação:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `OK — Node ${process.versions.node}, Electron ${require('electron/package.json').version}, 7 plataformas.`,
);
console.log(`Raiz: ${root}`);
