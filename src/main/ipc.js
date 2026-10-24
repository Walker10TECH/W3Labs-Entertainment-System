'use strict';

const path = require('node:path');
const { AppError, publicError } = require('./lib/errors');
const { publicPlatforms } = require('../../config/platforms');
const { DEFAULT_SETTINGS } = require('./config');

const SETTINGS_SCHEMA = Object.freeze({
  'video.resolution': new Set(['native', '720p', '1080p', '1440p', '4k', 'windowed']),
  'video.filter': new Set(['none', 'crt', 'scanlines', 'bilinear', 'aa']),
  'video.aspectRatio': new Set(['4:3', '16:9', 'stretch']),
  'video.vsync': null,
  'audio.volume': null,
  'audio.device': null,
  'audio.mute': null,
  'library.autoScrape': null,
  'metadata.provider': new Set(['screenscraper', 'igdb']),
  'metadata.language': null,
  'privacy.sendAnonymousMetrics': null,
  'ui.reduceMotion': null,
});

function registerIpcHandlers({ ipcMain, dialog, shell, app, runtime, services, getMainWindow, logger }) {
  const trustedWebContentsId = () => getMainWindow()?.webContents.id ?? null;

  const assertTrusted = (event) => {
    const expected = trustedWebContentsId();
    if (!expected || event.sender.id !== expected) {
      throw new AppError('IPC_UNTRUSTED_SENDER', 'Origem IPC não autorizada.');
    }
    const url = event.senderFrame?.url ?? '';
    if (!url.startsWith('file://')) {
      throw new AppError('IPC_UNTRUSTED_ORIGIN', 'Origem IPC inválida.');
    }
  };

  const safeHandle = (channel, handler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        assertTrusted(event);
        const data = await handler(event, ...args);
        return { ok: true, data: data ?? null };
      } catch (error) {
        const expected = error instanceof AppError;
        const method = expected ? 'warn' : 'error';
        logger?.[method]('ipc', `${channel} falhou: ${error.message}`, {
          code: error.code ?? 'INTERNAL_ERROR',
        });
        return { ok: false, error: publicError(error) };
      }
    });
  };

  const notify = (channel, payload) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  safeHandle('app:info', async () => ({
    name: 'W3Labs Entertainment System',
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    dataRoot: runtime.dataRoot,
    savesRoot: runtime.paths.saves,
    logsRoot: runtime.paths.logs,
    platforms: publicPlatforms(),
    settings: services.settings.getAll(),
    hardcore: services.ra.getStatus(),
    cores: services.coreRegistry.statusAll(),
  }));

  safeHandle('app:stats', async () => {
    const stats = services.library.stats();
    const recent = services.library.recent(8);
    return {
      ...stats,
      biosMatrix: services.bios.getMatrix(),
      recent,
    };
  });

  safeHandle('app:openPath', async (_event, target) => {
    const map = {
      saves: runtime.paths.saves,
      logs: runtime.paths.logs,
      data: runtime.dataRoot,
      bios: runtime.paths.bios,
    };
    const targetPath = map[target];
    if (!targetPath) throw new AppError('OPEN_PATH_INVALID', 'Destino inválido.');
    const error = await shell.openPath(targetPath);
    if (error) throw new AppError('OPEN_PATH_FAILED', error);
    return { opened: targetPath };
  });

  safeHandle('settings:getAll', async () => services.settings.getAll());
  safeHandle('settings:set', async (_event, key, value) => {
    if (!Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA, key)) {
      throw new AppError('SETTING_UNKNOWN', 'Configuração desconhecida.');
    }
    const allowed = SETTINGS_SCHEMA[key];
    if (allowed && !allowed.has(String(value))) {
      throw new AppError('SETTING_INVALID', 'Valor de configuração inválido.');
    }
    if (key === 'audio.volume') {
      const volume = Number(value);
      if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
        throw new AppError('SETTING_INVALID', 'Volume deve ficar entre 0 e 100.');
      }
      services.settings.set(key, Math.round(volume));
    } else if (
      key === 'video.vsync' ||
      key === 'audio.mute' ||
      key === 'library.autoScrape' ||
      key === 'ui.reduceMotion'
    ) {
      services.settings.set(key, Boolean(value));
    } else {
      services.settings.set(key, value);
    }
    return services.settings.getAll();
  });
  safeHandle('settings:reset', async () => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) services.settings.set(key, value);
    return services.settings.getAll();
  });

  safeHandle('library:list', async (_event, filters) => services.library.list(filters ?? {}));
  safeHandle('library:roots', async () => services.library.listRoots());
  safeHandle('library:pickRoot', async () => {
    const win = getMainWindow();
    const result = await dialog.showOpenDialog(win, {
      title: 'Adicionar pasta de jogos',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Adicionar biblioteca',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  safeHandle('library:addRoot', async (_event, rootPath, platformId) => {
    return services.library.addRoot(rootPath, platformId || null);
  });
  safeHandle('library:removeRoot', async (_event, id) => services.library.removeRoot(id));
  safeHandle('library:scan', async (event) => {
    if (services.scanning) throw new AppError('SCAN_IN_PROGRESS', 'Já existe um escaneamento em andamento.');
    services.scanning = true;
    try {
      return await services.library.scanAll({
        onProgress: (payload) => {
          if (!event.sender.isDestroyed()) event.sender.send('library:scan-progress', payload);
        },
      });
    } finally {
      services.scanning = false;
    }
  });
  safeHandle('library:favorite', async (_event, id, favorite) =>
    services.library.setFavorite(id, Boolean(favorite)),
  );
  safeHandle('library:region', async (_event, id, region) => services.library.setRegion(id, region));
  safeHandle('library:platform', async (_event, id, platformId) =>
    services.library.setPlatform(id, platformId),
  );
  safeHandle('library:remove', async (_event, id) => services.library.removeFromLibrary(id));
  safeHandle('library:get', async (_event, id) => services.library.get(id));
  safeHandle('metadata:scrape', async (_event, gameId) => services.metadata.scrapeGame(gameId));
  safeHandle('metadata:status', async () => services.metadata.getStatus());
  safeHandle('metadata:credentials', async (_event, provider, credentials) => {
    if (!['screenscraper', 'igdb'].includes(provider)) {
      throw new AppError('METADATA_PROVIDER_UNKNOWN', 'Provedor desconhecido.');
    }
    return services.metadata.setCredentials(provider, credentials);
  });
  safeHandle('metadata:clearCredentials', async (_event, provider) =>
    services.metadata.clearCredentials(provider),
  );

  safeHandle('bios:list', async () => services.bios.list());
  safeHandle('bios:matrix', async () => services.bios.getMatrix());
  safeHandle('bios:chooseAndImport', async (event, platformHint = null) => {
    const win = getMainWindow();
    const result = await dialog.showOpenDialog(win, {
      title: 'Importar BIOS do próprio usuário',
      properties: ['openFile'],
      filters: [
        { name: 'BIOS / Firmware', extensions: ['bin', 'rom', 'img'] },
        { name: 'Todos os arquivos', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const imported = await services.bios.importFromFile(result.filePaths[0], { platformHint });
    notify('bios:changed', services.bios.getMatrix());
    return imported;
  });
  safeHandle('bios:chooseAndImportCustom', async (_event, options = {}) => {
    const win = getMainWindow();
    const result = await dialog.showOpenDialog(win, {
      title: 'Selecionar BIOS personalizada',
      properties: ['openFile'],
      filters: [
        { name: 'BIOS / Firmware', extensions: ['bin', 'rom', 'img', 'pup'] },
        { name: 'Todos os arquivos', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const imported = await services.bios.importCustomFromFile(result.filePaths[0], {
      platformId: options.platformId,
      region: options.region,
      kind: options.kind,
      label: options.label,
      acknowledged: options.acknowledged === true,
    });
    notify('bios:changed', services.bios.getMatrix());
    return imported;
  });
  safeHandle('bios:remove', async (_event, id) => {
    services.bios.remove(id);
    notify('bios:changed', services.bios.getMatrix());
    return { removed: true };
  });

  safeHandle('emulation:active', async () => services.emulation.getActive());
  safeHandle('emulation:launch', async (_event, gameId, options) =>
    services.emulation.launch(gameId, options ?? {}),
  );
  safeHandle('emulation:pause', async () => services.emulation.pause());
  safeHandle('emulation:resume', async () => services.emulation.resume());
  safeHandle('emulation:stop', async () => services.emulation.stop({ reason: 'user' }));

  safeHandle('saves:list', async (_event, gameId) => services.saveStates.list(gameId));
  safeHandle('saves:save', async (_event, gameId, slot) => services.saveStates.save(gameId, slot));
  safeHandle('saves:load', async (_event, gameId, slot) => services.saveStates.load(gameId, slot));
  safeHandle('saves:remove', async (_event, gameId, slot) => services.saveStates.remove(gameId, slot));

  safeHandle('controllers:profiles', async () => services.controllers.listProfiles());
  safeHandle('controllers:saveProfile', async (_event, profile) => services.controllers.saveProfile(profile));
  safeHandle('controllers:setMapping', async (_event, id, mapping) =>
    services.controllers.setMapping(id, mapping),
  );
  safeHandle('controllers:removeProfile', async (_event, id) => services.controllers.removeProfile(id));
  safeHandle('controllers:inspect', async (_event, gamepads, platformId) =>
    services.controllers.inspectDetected(gamepads, platformId),
  );

  safeHandle('ra:status', async () => services.ra.getStatus());
  safeHandle('ra:connect', async (_event, credentials) => {
    const status = await services.ra.connect(credentials ?? {});
    notify('ra:changed', status);
    return status;
  });
  safeHandle('ra:disconnect', async () => {
    const status = services.ra.disconnect();
    notify('ra:changed', status);
    notify('emulation:changed', services.emulation.getActive());
    return status;
  });
  safeHandle('ra:refresh', async () => {
    const status = await services.ra.refresh();
    notify('ra:changed', status);
    return status;
  });
  safeHandle('ra:hardcore', async (_event, enabled) => {
    const status = await services.ra.setHardcore(Boolean(enabled));
    notify('ra:changed', status);
    notify('emulation:changed', services.emulation.getActive());
    return status;
  });
  safeHandle('ra:linkGame', async (_event, gameId, raGameId) => services.ra.linkGame(gameId, raGameId));
  safeHandle('ra:syncAchievements', async (_event, gameId) => services.ra.syncAchievements(gameId));

  safeHandle('hardware:info', async () => services.hardware.info());
  safeHandle('hardware:assess', async (_event, platformId) => services.hardware.assess(platformId));
  const installCatalog = () =>
    services.installer.catalog().map((entry) => {
      const executable = services.coreRegistry.resolveExecutable(services.coreRegistry.get(entry.coreId));
      return {
        ...entry,
        detectedExecutable: executable,
        detectedInSystem: Boolean(executable && executable !== entry.executable),
      };
    });

  safeHandle('cores:status', async () => services.coreRegistry.statusAll());
  safeHandle('cores:installCatalog', async () => installCatalog());
  safeHandle('cores:install', async (_event, coreId) => {
    const result = await services.installer.install(coreId);
    notify('cores:changed', installCatalog());
    return { ...result, catalog: installCatalog() };
  });
  safeHandle('cores:openSite', async (_event, coreId) => {
    const url = services.installer.getSourceUrl(coreId);
    if (!url) throw new AppError('CORE_SOURCE_UNKNOWN', 'Fonte oficial desconhecida.');
    await shell.openExternal(url);
    return { opened: url };
  });
  safeHandle('cores:revealConfig', async () => {
    const target = path.dirname(runtime.paths.coresConfig);
    await shell.openPath(target);
    return { opened: target };
  });

  return { notify };
}

module.exports = { registerIpcHandlers };
