'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result?.ok) {
    const error = new Error(result?.error?.message ?? 'Falha na comunicação com o processo principal.');
    error.code = result?.error?.code ?? 'IPC_ERROR';
    error.details = result?.error?.details ?? null;
    throw error;
  }
  return result.data;
}

const EVENT_CHANNELS = new Set([
  'library:scan-progress',
  'emulation:changed',
  'emulation:core-event',
  'ra:changed',
  'bios:changed',
  'cores:install-progress',
  'cores:changed',
]);

function subscribe(channel, callback) {
  if (!EVENT_CHANNELS.has(channel) || typeof callback !== 'function') {
    throw new Error('Evento IPC não permitido.');
  }
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('w3', {
  versions: Object.freeze({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }),
  app: {
    info: () => invoke('app:info'),
    stats: () => invoke('app:stats'),
    openPath: (target) => invoke('app:openPath', target),
  },
  settings: {
    getAll: () => invoke('settings:getAll'),
    set: (key, value) => invoke('settings:set', key, value),
    reset: () => invoke('settings:reset'),
  },
  library: {
    list: (filters) => invoke('library:list', filters),
    roots: () => invoke('library:roots'),
    pickRoot: () => invoke('library:pickRoot'),
    addRoot: (rootPath, platformId) => invoke('library:addRoot', rootPath, platformId),
    removeRoot: (id) => invoke('library:removeRoot', id),
    scan: () => invoke('library:scan'),
    favorite: (id, favorite) => invoke('library:favorite', id, favorite),
    region: (id, region) => invoke('library:region', id, region),
    platform: (id, platformId) => invoke('library:platform', id, platformId),
    remove: (id) => invoke('library:remove', id),
    get: (id) => invoke('library:get', id),
    onScanProgress: (callback) => subscribe('library:scan-progress', callback),
  },
  metadata: {
    scrape: (gameId) => invoke('metadata:scrape', gameId),
    status: () => invoke('metadata:status'),
    setCredentials: (provider, credentials) => invoke('metadata:credentials', provider, credentials),
    clearCredentials: (provider) => invoke('metadata:clearCredentials', provider),
  },
  bios: {
    list: () => invoke('bios:list'),
    matrix: () => invoke('bios:matrix'),
    chooseAndImport: (platformHint) => invoke('bios:chooseAndImport', platformHint),
    chooseAndImportCustom: (options) => invoke('bios:chooseAndImportCustom', options),
    remove: (id) => invoke('bios:remove', id),
    onChanged: (callback) => subscribe('bios:changed', callback),
  },
  emulation: {
    active: () => invoke('emulation:active'),
    launch: (gameId, options) => invoke('emulation:launch', gameId, options),
    pause: () => invoke('emulation:pause'),
    resume: () => invoke('emulation:resume'),
    stop: () => invoke('emulation:stop'),
    onChanged: (callback) => subscribe('emulation:changed', callback),
    onCoreEvent: (callback) => subscribe('emulation:core-event', callback),
  },
  saves: {
    list: (gameId) => invoke('saves:list', gameId),
    save: (gameId, slot) => invoke('saves:save', gameId, slot),
    load: (gameId, slot) => invoke('saves:load', gameId, slot),
    remove: (gameId, slot) => invoke('saves:remove', gameId, slot),
  },
  controllers: {
    profiles: () => invoke('controllers:profiles'),
    saveProfile: (profile) => invoke('controllers:saveProfile', profile),
    setMapping: (id, mapping) => invoke('controllers:setMapping', id, mapping),
    removeProfile: (id) => invoke('controllers:removeProfile', id),
    inspect: (gamepads, platformId) => invoke('controllers:inspect', gamepads, platformId),
  },
  retroachievements: {
    status: () => invoke('ra:status'),
    connect: (credentials) => invoke('ra:connect', credentials),
    disconnect: () => invoke('ra:disconnect'),
    refresh: () => invoke('ra:refresh'),
    setHardcore: (enabled) => invoke('ra:hardcore', enabled),
    linkGame: (gameId, raGameId) => invoke('ra:linkGame', gameId, raGameId),
    syncAchievements: (gameId) => invoke('ra:syncAchievements', gameId),
    onChanged: (callback) => subscribe('ra:changed', callback),
  },
  hardware: {
    info: () => invoke('hardware:info'),
    assess: (platformId) => invoke('hardware:assess', platformId),
  },
  cores: {
    status: () => invoke('cores:status'),
    installCatalog: () => invoke('cores:installCatalog'),
    install: (coreId) => invoke('cores:install', coreId),
    openSite: (coreId) => invoke('cores:openSite', coreId),
    revealConfig: () => invoke('cores:revealConfig'),
    onInstallProgress: (callback) => subscribe('cores:install-progress', callback),
    onChanged: (callback) => subscribe('cores:changed', callback),
  },
});
