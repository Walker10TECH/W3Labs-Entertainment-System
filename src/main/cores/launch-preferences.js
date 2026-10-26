'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Cada regra abaixo corresponde a uma opção verificada no binário instalado
 * nesta máquina (saída de `--help` dos Qt/QEMU-style e chaves dos arquivos de
 * configuração que os próprios emuladores escreveram). Nada é enviado a um
 * núcleo sem verificação: preferências sem regra viram `ignored`. Núcleos sem
 * opção verificada (SameBoy) ficam fora da tabela e são launcheados com as
 * args originais de cores.json.
 */

const RESOLUTION_BY_LABEL = Object.freeze({
  native: '1280x720',
  '720p': '1280x720',
  '1080p': '1920x1080',
  '1440p': '2560x1440',
  '4k': '3840x2160',
});

const SETTING_LABELS = Object.freeze({
  'video.resolution': 'Resolução',
  'video.filter': 'Filtro',
  'video.aspectRatio': 'Proporção',
  'video.vsync': 'VSync',
  'audio.volume': 'Volume',
  'audio.device': 'Dispositivo de áudio',
  'audio.mute': 'Sem áudio',
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePreferences(settings = {}) {
  const resolution = String(settings['video.resolution'] ?? '1080p');
  const rawVolume = Number(settings['audio.volume']);
  return {
    resolution,
    fullscreen: resolution !== 'windowed',
    filter: String(settings['video.filter'] ?? 'none'),
    aspectRatio: String(settings['video.aspectRatio'] ?? '4:3'),
    vsync: Boolean(settings['video.vsync']),
    volume: Number.isFinite(rawVolume) ? Math.min(100, Math.max(0, Math.round(rawVolume))) : 80,
    device: String(settings['audio.device'] ?? 'default'),
    mute: Boolean(settings['audio.mute']),
  };
}

const ADAPTERS = Object.freeze({
  duckstation: {
    label: 'DuckStation',
    strip: ['-fullscreen', '-nofullscreen'],
    placement: 'auto',
    rules: [
      {
        setting: 'video.resolution',
        kind: 'cli',
        args: (prefs) => (prefs.fullscreen ? ['-fullscreen'] : ['-nofullscreen']),
        detail: (prefs) => (prefs.fullscreen ? 'tela cheia' : 'janela'),
      },
    ],
  },
  pcsx2: {
    label: 'PCSX2',
    strip: ['-fullscreen', '-nofullscreen'],
    placement: 'auto',
    rules: [
      {
        setting: 'video.resolution',
        kind: 'cli',
        args: (prefs) => (prefs.fullscreen ? ['-fullscreen'] : ['-nofullscreen']),
        detail: (prefs) => (prefs.fullscreen ? 'tela cheia' : 'janela'),
      },
    ],
  },
  mesen: {
    label: 'Mesen',
    strip: ['/fullscreen', '--fullscreen'],
    placement: 'append',
    rules: [
      {
        setting: 'video.resolution',
        kind: 'cli',
        args: (prefs) => (prefs.fullscreen ? ['/fullscreen'] : []),
        detail: (prefs) => (prefs.fullscreen ? 'tela cheia' : 'janela'),
      },
    ],
  },
  rpcs3: {
    label: 'RPCS3',
    strip: ['--fullscreen'],
    placement: 'auto',
    rules: [
      {
        setting: 'video.resolution',
        kind: 'cli',
        args: (prefs) => (prefs.fullscreen ? ['--fullscreen'] : []),
        detail: (prefs) => (prefs.fullscreen ? 'tela cheia' : 'janela'),
      },
      {
        setting: 'video.resolution',
        kind: 'config',
        section: 'Video',
        key: 'Resolution',
        when: (prefs) => prefs.fullscreen && Boolean(RESOLUTION_BY_LABEL[prefs.resolution]),
        value: (prefs) => RESOLUTION_BY_LABEL[prefs.resolution],
        detail: (prefs) => RESOLUTION_BY_LABEL[prefs.resolution],
      },
      {
        setting: 'video.aspectRatio',
        kind: 'config',
        section: 'Video',
        key: 'Aspect ratio',
        when: (prefs) => ['4:3', '16:9'].includes(prefs.aspectRatio),
        value: (prefs) => prefs.aspectRatio,
        detail: (prefs) => prefs.aspectRatio,
      },
      {
        setting: 'video.aspectRatio',
        kind: 'config',
        section: 'Video',
        key: 'Stretch To Display Area',
        when: (prefs) => prefs.aspectRatio === 'stretch',
        value: () => 'true',
        detail: () => 'esticar à tela',
      },
      {
        setting: 'video.filter',
        kind: 'config',
        section: 'Video',
        key: 'Output Scaling Mode',
        when: (prefs) => ['none', 'bilinear'].includes(prefs.filter),
        value: (prefs) => (prefs.filter === 'none' ? 'Nearest' : 'Bilinear'),
        detail: (prefs) => (prefs.filter === 'none' ? 'nearest' : 'bilinear'),
      },
      {
        setting: 'video.vsync',
        kind: 'config',
        section: 'Video',
        key: 'VSync Mode',
        when: () => true,
        value: (prefs) => (prefs.vsync ? 'Full' : 'Disabled'),
        detail: (prefs) => (prefs.vsync ? 'ativo' : 'desligado'),
      },
      {
        setting: 'audio.volume',
        kind: 'config',
        section: 'Audio',
        key: 'Master Volume',
        when: (prefs) => !prefs.mute,
        value: (prefs) => String(prefs.volume),
        detail: (prefs) => `${prefs.volume}%`,
      },
      {
        setting: 'audio.mute',
        kind: 'config',
        section: 'Audio',
        key: 'Master Volume',
        when: (prefs) => prefs.mute,
        value: () => '0',
        detail: () => 'mudo',
      },
      {
        setting: 'audio.device',
        kind: 'config',
        section: 'Audio',
        key: 'Audio Device',
        when: (prefs) => prefs.device === 'default',
        value: () => '"@@@default@@@"',
        detail: () => 'padrão do sistema',
      },
    ],
    overlay: {
      fileName: 'config.yml',
      syntax: 'yaml',
      mode: 'patch',
      flag: (file) => ['--config', file],
      candidates: (executable) =>
        [
          executable ? path.join(path.dirname(executable), 'config', 'config.yml') : null,
          path.join(os.homedir(), 'AppData', 'Roaming', 'rpcs3', 'config.yml'),
          path.join(process.env.LOCALAPPDATA ?? '', 'rpcs3', 'config.yml'),
        ].filter(Boolean),
    },
  },
  xenia: {
    label: 'Xenia Canary',
    strip: [],
    placement: 'auto',
    rules: [
      {
        setting: 'video.resolution',
        kind: 'config',
        section: 'Display',
        key: 'fullscreen',
        when: () => true,
        value: (prefs) => String(prefs.fullscreen),
        detail: (prefs) => (prefs.fullscreen ? 'tela cheia' : 'janela'),
      },
      {
        setting: 'video.vsync',
        kind: 'config',
        section: 'GPU',
        key: 'vsync',
        when: () => true,
        value: (prefs) => String(prefs.vsync),
        detail: (prefs) => (prefs.vsync ? 'ativo' : 'desligado'),
      },
      {
        setting: 'video.filter',
        kind: 'config',
        section: 'Display',
        key: 'postprocess_antialiasing',
        when: (prefs) => ['none', 'aa'].includes(prefs.filter),
        value: (prefs) => (prefs.filter === 'aa' ? '"fxaa"' : '""'),
        detail: (prefs) => (prefs.filter === 'aa' ? 'FXAA' : 'sem anti-serrilhado'),
      },
      {
        setting: 'audio.mute',
        kind: 'config',
        section: 'APU',
        key: 'mute',
        when: () => true,
        value: (prefs) => String(prefs.mute),
        detail: (prefs) => (prefs.mute ? 'mudo' : 'audível'),
      },
    ],
    overlay: {
      fileName: 'xenia-canary.config.toml',
      syntax: 'toml',
      mode: 'patch',
      flag: (file) => [`--config=${file}`],
      candidates: (executable) =>
        executable
          ? [
              path.join(path.dirname(executable), 'xenia-canary.config.toml'),
              path.join(path.dirname(executable), 'xenia.config.toml'),
            ]
          : [],
    },
  },
  xemu: {
    label: 'xemu',
    strip: ['-full-screen'],
    placement: 'auto',
    rules: [
      {
        setting: 'video.resolution',
        kind: 'cli',
        args: (prefs) => (prefs.fullscreen ? ['-full-screen'] : []),
        detail: (prefs) => (prefs.fullscreen ? 'tela cheia' : 'janela'),
      },
      {
        setting: 'video.filter',
        kind: 'config',
        section: 'display',
        key: 'filtering',
        when: (prefs) => ['none', 'bilinear'].includes(prefs.filter),
        value: (prefs) => (prefs.filter === 'none' ? '"nearest"' : '"linear"'),
        detail: (prefs) => (prefs.filter === 'none' ? 'nearest' : 'linear'),
      },
      {
        setting: 'video.aspectRatio',
        kind: 'config',
        section: 'display.ui',
        key: 'aspect_ratio',
        when: (prefs) => ['4:3', '16:9'].includes(prefs.aspectRatio),
        value: (prefs) => `"${prefs.aspectRatio.replace(':', 'x')}"`,
        detail: (prefs) => prefs.aspectRatio,
      },
      {
        setting: 'video.aspectRatio',
        kind: 'config',
        section: 'display.ui',
        key: 'fit',
        when: (prefs) => prefs.aspectRatio === 'stretch',
        value: () => '"stretch"',
        detail: () => 'esticar à tela',
      },
      {
        setting: 'video.aspectRatio',
        kind: 'config',
        section: 'display.ui',
        key: 'aspect_ratio',
        when: (prefs) => prefs.aspectRatio === 'stretch',
        value: () => '"auto"',
        detail: () => 'proporção automática',
      },
      {
        setting: 'video.vsync',
        kind: 'config',
        section: 'display.window',
        key: 'vsync',
        when: () => true,
        value: (prefs) => String(prefs.vsync),
        detail: (prefs) => (prefs.vsync ? 'ativo' : 'desligado'),
      },
      {
        setting: 'audio.volume',
        kind: 'config',
        section: 'audio',
        key: 'volume_limit',
        when: (prefs) => !prefs.mute,
        value: (prefs) => (prefs.volume / 100).toFixed(2),
        detail: (prefs) => `${prefs.volume}%`,
      },
      {
        setting: 'audio.mute',
        kind: 'config',
        section: 'audio',
        key: 'volume_limit',
        when: (prefs) => prefs.mute,
        value: () => '0.00',
        detail: () => 'mudo',
      },
    ],
    overlay: {
      fileName: 'w3labs.toml',
      syntax: 'toml',
      mode: 'generate',
      flag: (file) => ['-config_path', file],
      candidates: () => [],
    },
  },
});

function patchYaml(text, rule) {
  const lines = text.split(/\r?\n/);
  const keyPattern = new RegExp(`^  ${escapeRegExp(rule.key)}: `);
  const sectionPattern = /^([A-Za-z][^:]*):\s*$/;
  let inSection = false;
  for (let index = 0; index < lines.length; index += 1) {
    const sectionMatch = sectionPattern.exec(lines[index]);
    if (sectionMatch) {
      inSection = sectionMatch[1] === rule.section;
      continue;
    }
    if (!inSection || !keyPattern.test(lines[index])) continue;
    lines[index] = `  ${rule.key}: ${rule.value}`;
    return { text: lines.join('\n'), replaced: true };
  }
  return { text, replaced: false };
}

function patchToml(text, rule) {
  const lines = text.split(/\r?\n/);
  const sectionPattern = /^\s*\[\s*([^\]]+?)\s*\]\s*$/;
  const keyPattern = new RegExp(`^(\\s*)${escapeRegExp(rule.key)}\\s*=\\s*(.*)$`);
  let inSection = false;
  for (let index = 0; index < lines.length; index += 1) {
    const sectionMatch = sectionPattern.exec(lines[index]);
    if (sectionMatch) {
      inSection = sectionMatch[1] === rule.section;
      continue;
    }
    if (!inSection) continue;
    const keyMatch = keyPattern.exec(lines[index]);
    if (!keyMatch) continue;
    const comment = /(\s+#.*)$/.exec(keyMatch[2]);
    lines[index] = `${keyMatch[1]}${rule.key} = ${rule.value}${comment ? comment[1] : ''}`;
    return { text: lines.join('\n'), replaced: true };
  }
  return { text, replaced: false };
}

function generateToml(rules) {
  const sections = new Map();
  for (const rule of rules) {
    if (!sections.has(rule.section)) sections.set(rule.section, []);
    sections.get(rule.section).push(`${rule.key} = ${rule.value}`);
  }
  return `${[...sections].map(([section, entries]) => `[${section}]\n${entries.join('\n')}`).join('\n\n')}\n`;
}

function applicableRules(adapter, prefs) {
  return adapter.rules.filter((rule) => {
    if (rule.kind === 'cli') return true;
    return rule.when ? rule.when(prefs) : true;
  });
}

function insertFlags(args, flags, placement) {
  if (flags.length === 0) return args;
  if (placement === 'append') return [...args, ...flags];
  const separator = args.indexOf('--');
  if (separator < 0) return [...flags, ...args];
  return [...args.slice(0, separator), ...flags, ...args.slice(separator)];
}

function buildCliArgs(adapter, rules, baseArgs, prefs) {
  let args = adapter.strip.length ? baseArgs.filter((arg) => !adapter.strip.includes(arg)) : [...baseArgs];
  for (const rule of rules.filter((entry) => entry.kind === 'cli')) {
    args = insertFlags(args, rule.args(prefs), adapter.placement);
  }
  return args;
}

function applyLaunchPreferences({ coreId, settings, baseArgs, executable = null, overlayDirectory = null }) {
  const adapter = ADAPTERS[coreId];
  const prefs = normalizePreferences(settings);
  const applied = [];
  const ignored = [];
  if (!adapter) {
    for (const setting of Object.keys(SETTING_LABELS)) {
      ignored.push({ setting, reason: 'core-unknown' });
    }
    return { args: [...baseArgs], applied, ignored, overlayPath: null };
  }

  const rules = applicableRules(adapter, prefs);
  let args = buildCliArgs(adapter, rules, baseArgs, prefs);
  let overlayPath = null;

  const configRules = rules.filter((rule) => rule.kind === 'config');
  if (configRules.length > 0) {
    const overlay = adapter.overlay;
    const target =
      overlayDirectory && path.isAbsolute(overlayDirectory)
        ? path.join(overlayDirectory, coreId, overlay.fileName)
        : null;
    const base =
      overlay.mode === 'patch'
        ? overlay.candidates(executable).find((candidate) => fs.existsSync(candidate))
        : null;

    if (target && (overlay.mode === 'generate' || base)) {
      let contents;
      try {
        if (overlay.mode === 'generate') {
          contents = generateToml(configRules.map((rule) => ({ ...rule, value: rule.value(prefs) })));
        } else {
          contents = fs.readFileSync(base, 'utf8');
        }
        const written = [];
        if (overlay.mode === 'patch') {
          for (const rule of configRules) {
            const value = rule.value(prefs);
            const result =
              overlay.syntax === 'yaml'
                ? patchYaml(contents, { ...rule, value })
                : patchToml(contents, { ...rule, value });
            contents = result.text;
            if (result.replaced) written.push(rule);
            else ignored.push({ setting: rule.setting, reason: 'key-missing' });
          }
        } else {
          written.push(...configRules);
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
        overlayPath = target;
        args = insertFlags(args, overlay.flag(target), adapter.placement);
        applied.push(...written);
      } catch {
        overlayPath = null;
        for (const rule of configRules) {
          ignored.push({ setting: rule.setting, reason: 'write-failed' });
        }
      }
    } else {
      for (const rule of configRules) {
        ignored.push({
          setting: rule.setting,
          reason: overlay.mode === 'patch' ? 'no-base-config' : 'no-overlay-dir',
        });
      }
    }
  }

  for (const rule of rules.filter((entry) => entry.kind === 'cli')) {
    applied.push(rule);
  }
  for (const setting of Object.keys(SETTING_LABELS)) {
    if (applied.some((entry) => entry.setting === setting)) continue;
    if (ignored.some((entry) => entry.setting === setting)) continue;
    ignored.push({ setting, reason: 'unsupported' });
  }

  return {
    args,
    applied: applied.map((rule) => ({
      setting: rule.setting,
      label: SETTING_LABELS[rule.setting],
      kind: rule.kind,
      detail: rule.detail(prefs),
    })),
    ignored: ignored.map((entry) => ({
      setting: entry.setting,
      label: SETTING_LABELS[entry.setting],
      reason: entry.reason,
    })),
    overlayPath,
    preferences: prefs,
  };
}

function preferenceCoverage() {
  const bySetting = {};
  for (const setting of Object.keys(SETTING_LABELS)) {
    bySetting[setting] = { label: SETTING_LABELS[setting], cores: [] };
  }
  for (const [coreId, adapter] of Object.entries(ADAPTERS)) {
    const seen = new Map();
    for (const rule of adapter.rules) {
      if (!seen.has(rule.setting)) seen.set(rule.setting, new Set());
      seen.get(rule.setting).add(rule.kind);
    }
    for (const [setting, kinds] of seen) {
      bySetting[setting].cores.push({
        coreId,
        label: adapter.label,
        kinds: [...kinds],
        needsBaseConfig:
          kinds.has('config') && !kinds.has('cli') ? ADAPTERS[coreId].overlay?.mode === 'patch' : false,
      });
    }
  }
  return bySetting;
}

module.exports = {
  ADAPTERS,
  SETTING_LABELS,
  RESOLUTION_BY_LABEL,
  applyLaunchPreferences,
  normalizePreferences,
  preferenceCoverage,
};
