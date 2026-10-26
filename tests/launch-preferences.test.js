'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  applyLaunchPreferences,
  normalizePreferences,
  preferenceCoverage,
} = require('../src/main/cores/launch-preferences');
const { temporaryRoot } = require('./helpers');

const SETTINGS = {
  'video.resolution': '1080p',
  'video.filter': 'bilinear',
  'video.aspectRatio': '4:3',
  'video.vsync': true,
  'audio.volume': 35,
  'audio.device': 'default',
  'audio.mute': false,
};

const RPCS3_BASE = [
  'Core:',
  '  Preferred SPU Threads: 0',
  'Video:',
  '  Renderer: Vulkan',
  '  Resolution: 1280x720',
  '  Aspect ratio: 16:9',
  '  VSync Mode: Disabled',
  '  Stretch To Display Area: false',
  '  Output Scaling Mode: Bilinear',
  '  Vulkan:',
  '    Adapter: Test GPU',
  'Audio:',
  '  Renderer: Cubeb',
  '  Audio Device: "@@@default@@@"',
  '  Master Volume: 100',
  '',
].join('\n');

test('normalização lê janela, volume e flags booleanas das configurações', () => {
  const prefs = normalizePreferences({ 'video.resolution': 'windowed', 'audio.volume': '140' });
  assert.equal(prefs.fullscreen, false);
  assert.equal(prefs.volume, 100);
  assert.equal(normalizePreferences({ 'audio.volume': 'abc' }).volume, 80);
  assert.equal(normalizePreferences({}).vsync, false);
});

test('flags fixas do cores.json são substituídas pela preferência de tela', () => {
  const duckstation = applyLaunchPreferences({
    coreId: 'duckstation',
    settings: { ...SETTINGS, 'video.resolution': 'windowed' },
    baseArgs: ['-batch', '-fullscreen', '--', 'Game.cue'],
  });
  assert.deepEqual(duckstation.args, ['-batch', '-nofullscreen', '--', 'Game.cue']);
  assert.equal(duckstation.applied[0].kind, 'cli');
  assert.equal(duckstation.applied[0].detail, 'janela');
  assert.deepEqual(
    duckstation.applied.filter((entry) => entry.setting !== 'video.resolution'),
    [],
  );
  assert.ok(duckstation.ignored.some((entry) => entry.setting === 'audio.volume'));
});

test('núcleos sem opção de linha de comando recebem apenas as args originais', () => {
  const mesen = applyLaunchPreferences({
    coreId: 'mesen',
    settings: { ...SETTINGS, 'video.resolution': 'windowed' },
    baseArgs: ['Game.nes', '/fullscreen'],
  });
  assert.deepEqual(mesen.args, ['Game.nes']);
  const xenia = applyLaunchPreferences({
    coreId: 'xenia',
    settings: SETTINGS,
    baseArgs: ['default.xex'],
  });
  assert.deepEqual(xenia.args, ['default.xex']);
  assert.ok(xenia.ignored.some((entry) => entry.setting === 'audio.volume'));
  const sameboy = applyLaunchPreferences({
    coreId: 'sameboy',
    settings: SETTINGS,
    baseArgs: ['Game.gb'],
  });
  assert.deepEqual(sameboy.args, ['Game.gb']);
  assert.equal(sameboy.applied.length, 0);
});

test('overlay do RPCS3 parte do config.yml do próprio emulador e preserva as demais chaves', (t) => {
  const root = temporaryRoot('w3-prefs-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coreDir = path.join(root, 'rpcs3');
  fs.mkdirSync(path.join(coreDir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(coreDir, 'rpcs3.exe'), '');
  fs.writeFileSync(path.join(coreDir, 'config', 'config.yml'), RPCS3_BASE);

  const result = applyLaunchPreferences({
    coreId: 'rpcs3',
    settings: SETTINGS,
    baseArgs: ['--no-gui', 'PS3_GAME/BOOT.BIN'],
    executable: path.join(coreDir, 'rpcs3.exe'),
    overlayDirectory: path.join(root, 'overlays'),
  });

  assert.ok(result.overlayPath.endsWith(path.join('rpcs3', 'config.yml')));
  assert.deepEqual(result.args.slice(0, 4), ['--config', result.overlayPath, '--fullscreen', '--no-gui']);

  const overlay = fs.readFileSync(result.overlayPath, 'utf8');
  assert.match(overlay, /^ {2}Resolution: 1920x1080$/m);
  assert.match(overlay, /^ {2}Aspect ratio: 4:3$/m);
  assert.match(overlay, /^ {2}VSync Mode: Full$/m);
  assert.match(overlay, /^ {2}Master Volume: 35$/m);
  assert.match(overlay, /^ {4}Adapter: Test GPU$/m);
  assert.equal(result.ignored.length, 1);
  assert.deepEqual(result.ignored[0], {
    setting: 'audio.mute',
    label: 'Sem áudio',
    reason: 'unsupported',
  });
  assert.ok(result.applied.some((entry) => entry.kind === 'config' && entry.detail === '35%'));
});

test('chave ausente no arquivo do emulador é reportada como não aplicada', (t) => {
  const root = temporaryRoot('w3-prefs-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coreDir = path.join(root, 'rpcs3');
  fs.mkdirSync(path.join(coreDir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(coreDir, 'rpcs3.exe'), '');
  fs.writeFileSync(
    path.join(coreDir, 'config', 'config.yml'),
    RPCS3_BASE.replace(/^ {2}Output Scaling Mode: Bilinear$/m, '  Shader Mode: Async'),
  );

  const result = applyLaunchPreferences({
    coreId: 'rpcs3',
    settings: SETTINGS,
    baseArgs: ['--no-gui', 'BOOT.BIN'],
    executable: path.join(coreDir, 'rpcs3.exe'),
    overlayDirectory: path.join(root, 'overlays'),
  });
  assert.ok(result.overlayPath);
  assert.ok(
    result.ignored.some((entry) => entry.setting === 'video.filter' && entry.reason === 'key-missing'),
  );
  assert.ok(!fs.readFileSync(result.overlayPath, 'utf8').includes('Output Scaling Mode'));
});

test('overlay do xemu é gerado do zero com chaves e tipos aceitos pelo binário', (t) => {
  const root = temporaryRoot('w3-prefs-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = applyLaunchPreferences({
    coreId: 'xemu',
    settings: { ...SETTINGS, 'video.filter': 'none', 'video.aspectRatio': 'stretch' },
    baseArgs: ['-full-screen', '-dvd_path', 'default.xiso'],
    executable: path.join(root, 'xemu.exe'),
    overlayDirectory: path.join(root, 'overlays'),
  });

  assert.deepEqual(result.args.slice(0, 2), ['-config_path', result.overlayPath]);
  assert.ok(result.args.includes('-full-screen'));
  const overlay = fs.readFileSync(result.overlayPath, 'utf8');
  assert.match(overlay, /\[display\]\nfiltering = "nearest"/);
  assert.match(overlay, /aspect_ratio = "auto"/);
  assert.match(overlay, /fit = "stretch"/);
  assert.match(overlay, /vsync = true/);
  assert.match(overlay, /volume_limit = 0\.35/);
  assert.ok(result.applied.some((entry) => entry.setting === 'video.vsync'));
});

test('silenciar tem prioridade sobre o volume salvo e o dispositivo só aceita o padrão', (t) => {
  const root = temporaryRoot('w3-prefs-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coreDir = path.join(root, 'rpcs3');
  fs.mkdirSync(path.join(coreDir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(coreDir, 'rpcs3.exe'), '');
  fs.writeFileSync(path.join(coreDir, 'config', 'config.yml'), RPCS3_BASE);

  const result = applyLaunchPreferences({
    coreId: 'rpcs3',
    settings: { ...SETTINGS, 'audio.mute': true, 'audio.device': 'hdmi' },
    baseArgs: ['--no-gui', 'BOOT.BIN'],
    executable: path.join(coreDir, 'rpcs3.exe'),
    overlayDirectory: path.join(root, 'overlays'),
  });
  const overlay = fs.readFileSync(result.overlayPath, 'utf8');
  assert.match(overlay, /^ {2}Master Volume: 0$/m);
  assert.ok(result.applied.some((entry) => entry.setting === 'audio.mute' && entry.detail === 'mudo'));
  assert.ok(result.ignored.some((entry) => entry.setting === 'audio.device'));
});

test('cobertura declara por núcleo como cada preferência chega ao emulador', () => {
  const coverage = preferenceCoverage();
  assert.deepEqual(
    Object.keys(coverage).sort(),
    [
      'audio.device',
      'audio.mute',
      'audio.volume',
      'video.aspectRatio',
      'video.filter',
      'video.resolution',
      'video.vsync',
    ].sort(),
  );
  const resolution = coverage['video.resolution'].cores;
  assert.ok(resolution.some((core) => core.coreId === 'pcsx2' && core.kinds.includes('cli')));
  assert.ok(resolution.some((core) => core.coreId === 'rpcs3' && core.kinds.includes('config')));
  const filter = coverage['video.filter'].cores;
  assert.deepEqual(filter.map((core) => core.coreId).sort(), ['rpcs3', 'xemu', 'xenia']);
  assert.ok(coverage['audio.volume'].cores.every((core) => core.coreId !== 'pcsx2'));
});
