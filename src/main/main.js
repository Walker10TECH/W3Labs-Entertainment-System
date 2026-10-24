'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, shell } = require('electron');

const { createRuntimeConfig } = require('./config');
const { AppDatabase } = require('./db/database');
const { Logger } = require('./lib/logger');
const { CryptoVault } = require('./lib/crypto-vault');
const { SettingsService } = require('./services/settings-service');
const { BiosCatalog, DEFAULT_CATALOG_FILE } = require('./services/bios-catalog');
const { BiosService } = require('./services/bios-service');
const { LibraryService } = require('./services/library-service');
const { MetadataService } = require('./services/metadata-service');
const { RetroAchievementsService } = require('./services/retroachievements-service');
const { HardwareService } = require('./services/hardware-service');
const { ControllerService } = require('./services/controller-service');
const { SaveStateService } = require('./services/save-state-service');
const { EmulationService } = require('./services/emulation-service');
const { MediaLoader } = require('./services/media-loader');
const { CoreRegistry } = require('./cores/core-registry');
const { CoreManager } = require('./cores/core-manager');
const { EmulatorInstaller } = require('./cores/emulator-installer');
const { registerIpcHandlers } = require('./ipc');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'w3cover',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow = null;
let services = null;
let logger = null;
let runtime = null;
let shutdownStarted = false;

app.setName('W3Labs Entertainment System');
if (process.platform === 'win32') app.setAppUserModelId('com.w3labs.entertainment');

function buildServices() {
  runtime = createRuntimeConfig({
    appRoot: path.resolve(__dirname, '../..'),
    isPackaged: app.isPackaged,
    userDataPath: app.getPath('userData'),
  });
  logger = new Logger({ logsDir: runtime.paths.logs, consoleEnabled: true });
  logger.info('app', 'Inicializando W3Labs Entertainment System.', {
    version: app.getVersion(),
    dataRoot: runtime.dataRoot,
    packaged: app.isPackaged,
  });

  const db = new AppDatabase(runtime.paths.database, { logger });
  logger.attachDatabase(db);
  const vault = new CryptoVault({ keyPath: path.join(runtime.paths.storage, 'secret.key') });
  const settings = new SettingsService({
    db,
    defaults: runtime.defaultSettings,
    vault,
  });
  const catalog = new BiosCatalog({
    baseFile: DEFAULT_CATALOG_FILE,
    customFile: runtime.paths.customBiosCatalog,
    logger,
  });
  const bios = new BiosService({ db, paths: runtime.paths, catalog, logger });
  const library = new LibraryService({
    db,
    paths: runtime.paths,
    logger,
    config: runtime,
  });
  const metadata = new MetadataService({
    db,
    paths: runtime.paths,
    settings,
    logger,
    config: runtime,
  });
  library.metadataService = metadata;
  const ra = new RetroAchievementsService({ settings, db, logger });
  const hardware = new HardwareService({ getGpuInfo: () => app.getGPUInfo('basic'), logger });
  if (!fs.existsSync(runtime.paths.coresConfig)) {
    const example = path.resolve(__dirname, '../../config/cores.example.json');
    if (fs.existsSync(example)) {
      try {
        fs.copyFileSync(example, runtime.paths.coresConfig);
        logger.info('cores', 'cores.json inicial criado a partir do exemplo.');
      } catch (error) {
        logger.warn('cores', 'Não foi possível criar cores.json.', { error: error.message });
      }
    }
  }
  const coreRegistry = new CoreRegistry({
    configFile: runtime.paths.coresConfig,
    logger,
    managedRoot: path.join(runtime.paths.storage, 'cores'),
  });
  const coreManager = new CoreManager({ logger, stopGraceMs: runtime.emulation.stopGraceMs });
  const installer = new EmulatorInstaller({
    managedRoot: path.join(runtime.paths.storage, 'cores'),
    cacheDir: runtime.paths.cache,
    logger,
  });
  const media = new MediaLoader({ logger });
  const emulation = new EmulationService({
    db,
    paths: runtime.paths,
    library,
    bios,
    hardware,
    coreRegistry,
    coreManager,
    settings,
    logger,
    config: runtime,
    media,
  });
  emulation.setRetroAchievementsService(ra);
  const saveStates = new SaveStateService({ db, paths: runtime.paths, emulation, logger });
  saveStates.setRetroAchievementsService(ra);
  const controllers = new ControllerService({ db, logger });

  services = {
    db,
    settings,
    catalog,
    bios,
    library,
    metadata,
    ra,
    hardware,
    coreRegistry,
    coreManager,
    installer,
    emulation,
    saveStates,
    controllers,
    media,
    scanning: false,
  };
  return services;
}

function registerCoverProtocol() {
  protocol.handle('w3cover', async (request) => {
    try {
      const url = new URL(request.url);
      const id = url.pathname.split('/').filter(Boolean)[0];
      if (!id || !/^[a-zA-Z0-9-]{8,64}$/.test(id)) {
        return new Response('Capa não encontrada.', { status: 404 });
      }
      const row = services.db.get('SELECT cover_file FROM games WHERE id = ?', [id]);
      if (!row?.cover_file) return new Response('Capa não encontrada.', { status: 404 });
      const filePath = runtime.paths.assertCoverPath(row.cover_file);
      if (!fs.existsSync(filePath)) return new Response('Capa não encontrada.', { status: 404 });
      const stat = await fs.promises.stat(filePath);
      if (stat.size > 16 * 1024 * 1024) return new Response('Capa muito grande.', { status: 413 });
      const extension = path.extname(filePath).slice(1).toLowerCase();
      const mime = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
      const data = await fs.promises.readFile(filePath);
      return new Response(data, {
        status: 200,
        headers: {
          'content-type': mime,
          'cache-control': 'private, max-age=86400',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return new Response('Capa indisponível.', { status: 404 });
    }
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#07090d',
    icon: path.join(__dirname, '../renderer/assets/W3Labs.png'),
    title: 'W3Labs Entertainment System',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.on('console-message', (event) => {
    const method = Number(event.level) >= 2 ? 'error' : 'debug';
    logger?.[method]('renderer', String(event.message ?? ''), {
      line: event.lineNumber ?? null,
      source: event.sourceId ?? null,
    });
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger?.error('renderer', 'Processo de renderização encerrado.', details);
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    logger?.error('renderer', 'Falha ao carregar interface.', { code, description });
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function forwardEvents() {
  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };
  services.emulation.on('changed', (session) => send('emulation:changed', session));
  services.emulation.on('tick', (session) => send('emulation:changed', session));
  services.emulation.on('core-event', (payload) => send('emulation:core-event', payload));
  services.ra.on('changed', (payload) => send('ra:changed', payload));
  services.installer.on('progress', (payload) => send('cores:install-progress', payload));
}

async function bootstrap() {
  Menu.setApplicationMenu(null);
  buildServices();
  registerCoverProtocol();
  registerIpcHandlers({
    ipcMain,
    dialog,
    shell,
    app,
    runtime,
    services,
    getMainWindow: () => mainWindow,
    logger,
  });
  createMainWindow();
  forwardEvents();
}

app
  .whenReady()
  .then(() => {
    if (!gotLock) return;
    return bootstrap();
  })
  .catch((error) => {
    console.error(error);
    dialog.showErrorBox('Falha ao iniciar', error.message);
    app.exit(1);
  });

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && runtime) createMainWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  event.preventDefault();
  (async () => {
    try {
      await services?.emulation.shutdown();
    } catch (error) {
      logger?.warn('app', 'Falha ao encerrar emulação.', { error: error.message });
    }
    try {
      services?.db.close();
    } catch (error) {
      logger?.warn('app', 'Falha ao fechar banco.', { error: error.message });
    }
    await logger?.flush();
    app.exit(0);
  })();
});
