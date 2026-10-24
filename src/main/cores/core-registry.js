'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppError } = require('../lib/errors');
const { getPlatform } = require('../../../config/platforms');

function expand(value) {
  return String(value)
    .replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? '')
    .replace(/^~(?=$|[\\/])/, os.homedir());
}

function candidatePaths(relative) {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    '/usr/bin',
    '/usr/local/bin',
    '/Applications',
  ].filter(Boolean);
  return [path.join(...relative), ...roots.map((root) => path.join(root, ...relative))];
}

function findOnPath(command) {
  if (!command) return null;
  if (command.includes('/') || command.includes('\\')) {
    return fs.existsSync(command) && fs.statSync(command).isFile() ? command : null;
  }
  const pathEntries = String(process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean);
  const extensions =
    process.platform === 'win32'
      ? String(process.env.PATHEXT ?? '.EXE;.CMD;.BAT')
          .split(';')
          .filter(Boolean)
      : [''];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(
        directory,
        `${command}${command.toLowerCase().endsWith(extension.toLowerCase()) ? '' : extension}`,
      );
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // continua
      }
    }
  }
  return null;
}

const DEFAULT_CORES = Object.freeze({
  duckstation: {
    label: 'DuckStation',
    candidates: [
      ...candidatePaths(['DuckStation', 'duckstation-qt-x64-ReleaseLTCG.exe']),
      ...candidatePaths(['DuckStation', 'duckstation-qt.exe']),
      '/Applications/DuckStation.app/Contents/MacOS/DuckStation',
      '/usr/bin/duckstation-qt',
    ],
    args: ['-batch', '-fullscreen', '--', '{rom}'],
    capabilities: { pause: false, saveState: false, loadState: false, screenshot: false },
    biosKind: 'directory',
  },
  pcsx2: {
    label: 'PCSX2',
    candidates: [
      ...candidatePaths(['PCSX2', 'pcsx2-qt.exe']),
      '/Applications/PCSX2.app/Contents/MacOS/PCSX2',
      '/usr/bin/pcsx2-qt',
    ],
    args: ['-fullscreen', '-batch', '--', '{rom}'],
    capabilities: { pause: false, saveState: false, loadState: false, screenshot: false },
    biosKind: 'directory',
  },
  mesen: {
    label: 'Mesen',
    candidates: [
      ...candidatePaths(['Mesen', 'Mesen.exe']),
      ...candidatePaths(['Mesen2', 'Mesen.exe']),
      '/Applications/Mesen.app/Contents/MacOS/Mesen',
      '/usr/bin/mesen',
    ],
    args: ['{rom}', '/fullscreen'],
    capabilities: { pause: false, saveState: false, loadState: false, screenshot: false },
    biosKind: 'none',
  },
  xemu: {
    label: 'xemu',
    candidates: [
      ...candidatePaths(['xemu', 'xemu.exe']),
      '/Applications/xemu.app/Contents/MacOS/xemu',
      '/usr/bin/xemu',
    ],
    args: [
      '-full-screen',
      '-dvd_path',
      '{rom}',
      '-bootrom_path',
      '{bios:bootrom}',
      '-flashrom_path',
      '{bios:flash}',
    ],
    capabilities: { pause: false, saveState: false, loadState: false, screenshot: false },
    biosKind: 'files',
  },
  rpcs3: {
    label: 'RPCS3',
    candidates: [
      ...candidatePaths(['RPCS3', 'rpcs3.exe']),
      '/Applications/RPCS3.app/Contents/MacOS/rpcs3',
      '/usr/bin/rpcs3',
    ],
    args: ['--no-gui', '{rom}'],
    capabilities: { pause: false, saveState: false, loadState: false, screenshot: false },
    biosKind: 'none',
  },
  sameboy: {
    label: 'SameBoy',
    candidates: [
      ...candidatePaths(['SameBoy', 'sameboy.exe']),
      '/Applications/SameBoy.app/Contents/MacOS/SameBoy',
      '/usr/bin/sameboy',
    ],
    args: ['{rom}'],
    capabilities: { pause: false, saveState: false, loadState: false, screenshot: false },
    biosKind: 'none',
  },
  xenia: {
    label: 'Xenia Canary',
    candidates: [
      ...candidatePaths(['Xenia', 'xenia_canary.exe']),
      ...candidatePaths(['Xenia', 'xenia.exe']),
      ...candidatePaths(['Xenia Canary', 'xenia_canary.exe']),
    ],
    args: ['{rom}'],
    capabilities: { pause: false, saveState: false, loadState: false, screenshot: false },
    biosKind: 'none',
  },
});

const DEFAULT_CAPABILITIES = Object.freeze({
  pause: false,
  saveState: false,
  loadState: false,
  screenshot: false,
});

function mergeCapabilities(raw) {
  return {
    pause: Boolean(raw?.pause),
    saveState: Boolean(raw?.saveState),
    loadState: Boolean(raw?.loadState),
    screenshot: Boolean(raw?.screenshot),
  };
}

function normalizeCore(id, raw, source = 'builtin') {
  if (!raw || typeof raw !== 'object') return null;
  const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
  const bridgeCommand = Array.isArray(raw.bridgeCommand)
    ? raw.bridgeCommand.map(String)
    : typeof raw.bridgeCommand === 'string' && raw.bridgeCommand.trim()
      ? [raw.bridgeCommand.trim()]
      : null;
  const capabilities = bridgeCommand
    ? {
        pause: true,
        saveState: true,
        loadState: true,
        screenshot: true,
        ...mergeCapabilities(raw.capabilities),
      }
    : mergeCapabilities(raw.capabilities);
  return {
    id,
    label: String(raw.label ?? id),
    executable: raw.executable ? expand(raw.executable) : null,
    candidates: Array.isArray(raw.candidates) ? raw.candidates.map(expand) : [],
    args,
    bridgeCommand,
    capabilities,
    biosKind: raw.biosKind ?? 'none',
    environment: raw.environment && typeof raw.environment === 'object' ? raw.environment : {},
    source,
  };
}

class CoreRegistry {
  constructor({ configFile, logger, managedRoot = null }) {
    this.logger = logger;
    this.managedRoot = managedRoot ? path.resolve(managedRoot) : null;
    this.cores = new Map();
    for (const [id, raw] of Object.entries(DEFAULT_CORES)) {
      this.cores.set(id, normalizeCore(id, raw, 'builtin'));
    }
    this.loadOverrides(configFile);
  }

  loadOverrides(configFile) {
    if (!configFile || !fs.existsSync(configFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      for (const [id, raw] of Object.entries(parsed.cores ?? {})) {
        const normalized = normalizeCore(id, { ...DEFAULT_CORES[id], ...raw }, 'user');
        if (normalized) this.cores.set(id, normalized);
      }
      this.logger?.info('cores', 'Configuração de núcleos carregada.', { file: configFile });
    } catch (error) {
      this.logger?.warn('cores', 'cores.json inválido; usando padrões.', { error: error.message });
    }
  }

  get(coreId) {
    const core = this.cores.get(coreId);
    if (!core) throw new AppError('CORE_UNKNOWN', `Núcleo desconhecido: ${coreId}`);
    return core;
  }

  managedInfo(coreId) {
    if (!this.managedRoot) return null;
    const directory = path.join(this.managedRoot, coreId);
    const manifestPath = path.join(directory, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const executable = path.resolve(directory, manifest.executable);
      const relative = path.relative(directory, executable);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
      if (!fs.existsSync(executable)) return null;
      return {
        executable,
        version: manifest.version ?? null,
        installedAt: manifest.installedAt ?? null,
        source: manifest.source ?? null,
        asset: manifest.asset ?? null,
      };
    } catch {
      return null;
    }
  }

  resolveExecutable(core) {
    const envName = `W3_CORE_${core.id.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
    const fromEnv = process.env[envName] ? expand(process.env[envName]) : null;
    const candidates = [fromEnv, core.executable, ...core.candidates].filter(Boolean);
    for (const candidate of candidates) {
      const resolved = findOnPath(candidate);
      if (resolved) return resolved;
    }
    return this.managedInfo(core.id)?.executable ?? null;
  }

  statusForPlatform(platformId) {
    const platform = getPlatform(platformId);
    return {
      platformId,
      defaultCore: platform.defaultCore,
      cores: platform.cores.map((coreId) => {
        const core = this.get(coreId);
        const executable = this.resolveExecutable(core);
        return {
          id: core.id,
          label: core.label,
          installed: Boolean(executable),
          executable,
          capabilities: core.capabilities,
          source: core.source,
        };
      }),
    };
  }

  statusAll() {
    return [...this.cores.keys()].map((id) => {
      const core = this.get(id);
      const executable = this.resolveExecutable(core);
      return {
        id,
        label: core.label,
        installed: Boolean(executable),
        executable,
        capabilities: core.capabilities,
        source: core.source,
      };
    });
  }

  buildLaunchSpec(platformId, game, biosFiles, { stateDir, slot = 0 } = {}) {
    const platform = getPlatform(platformId);
    const core = this.get(platform.defaultCore);
    const executable = this.resolveExecutable(core);
    const bridgeFirst = core.bridgeCommand?.[0];
    const bridgeExecutable = bridgeFirst ? findOnPath(bridgeFirst) : null;

    if (!executable && !bridgeExecutable) {
      throw new AppError(
        'CORE_NOT_INSTALLED',
        `O núcleo ${core.label} não foi encontrado. Instale-o ou defina ${core.id} em cores.json.`,
        { platformId, coreId: core.id },
      );
    }

    const biosByKind = Object.fromEntries(biosFiles.map((bios) => [bios.kind, bios.path]));
    const tokens = {
      rom: game.filePath,
      stateDir: stateDir ?? '',
      slot: String(slot),
      platform: platformId,
      gameId: game.id,
      biosDir: biosFiles[0] ? path.dirname(biosFiles[0].path) : '',
      ...Object.fromEntries(Object.entries(biosByKind).map(([kind, file]) => [`bios:${kind}`, file])),
    };
    const replaceTokens = (value) =>
      String(value).replace(/\{([a-zA-Z:]+)\}/g, (match, key) => {
        if (tokens[key] === undefined) {
          throw new AppError('CORE_ARG_TOKEN_UNKNOWN', `Placeholder desconhecido em cores.json: ${match}`);
        }
        return tokens[key];
      });

    return {
      coreId: core.id,
      label: core.label,
      executable: executable ?? bridgeExecutable,
      args: core.args.map(replaceTokens),
      bridgeCommand: core.bridgeCommand?.map(replaceTokens) ?? null,
      environment: { ...core.environment },
      capabilities: core.capabilities,
      biosKind: core.biosKind,
      stateDir,
    };
  }
}

module.exports = {
  CoreRegistry,
  DEFAULT_CORES,
  DEFAULT_CAPABILITIES,
  normalizeCore,
};
