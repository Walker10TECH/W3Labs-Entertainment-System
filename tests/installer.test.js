'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { chooseAsset, safeArchiveEntry, EmulatorInstaller } = require('../src/main/cores/emulator-installer');
const { silentLogger, temporaryRoot } = require('./helpers');

test('seleciona o asset oficial correto e rejeita archive traversal', () => {
  const assets = [
    { name: 'pcsx2-v2.8.2-windows-x64-Qt-symbols.7z' },
    { name: 'pcsx2-v2.8.2-windows-x64-Qt.7z' },
    { name: 'pcsx2-v2.8.2-linux-appimage-x64-Qt.AppImage' },
  ];
  const asset = chooseAsset(assets, /windows-x64-Qt\.7z$/i);
  assert.equal(asset.name, 'pcsx2-v2.8.2-windows-x64-Qt.7z');

  const duckAssets = [
    { name: 'duckstation-windows-x64-release-symbols.7z' },
    { name: 'duckstation-windows-x64-release.zip' },
    { name: 'duckstation-windows-x64-installer.exe' },
  ];
  const duckAsset = chooseAsset(duckAssets, /duckstation-windows-x64-release\.zip$/i);
  assert.equal(duckAsset.name, 'duckstation-windows-x64-release.zip');

  assert.equal(safeArchiveEntry('folder/file.exe'), true);
  assert.equal(safeArchiveEntry('../evil.exe'), false);
  assert.equal(safeArchiveEntry('C:/Windows/evil.exe'), false);
  assert.equal(safeArchiveEntry('/tmp/evil'), false);
});

test('catálogo de instaladores cobre PS1, PS2, PS3, Xbox e Xbox 360', () => {
  const root = temporaryRoot('w3-installer-');
  try {
    const installer = new EmulatorInstaller({
      managedRoot: `${root}/cores`,
      cacheDir: `${root}/cache`,
      logger: silentLogger,
      fetchImpl: async () => {
        throw new Error('não deve acessar a rede no catálogo');
      },
    });
    const catalog = installer.catalog();
    assert.deepEqual(catalog.map((entry) => entry.coreId).sort(), [
      'duckstation',
      'pcsx2',
      'rpcs3',
      'xemu',
      'xenia',
    ]);
    assert.equal(
      catalog.every((entry) => entry.installed === false),
      true,
    );
    assert.equal(installer.getSourceUrl('duckstation'), 'https://www.duckstation.org/');
    assert.equal(installer.getSourceUrl('xenia'), 'https://xenia.jp/download/');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
