'use strict';

const path = require('node:path');
const { AppPaths } = require('./lib/paths');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const APP_VERSION = require('../../package.json').version;

const DEFAULT_SETTINGS = Object.freeze({
  'video.resolution': '1080p',
  'video.filter': 'crt',
  'video.aspectRatio': '4:3',
  'video.vsync': true,
  'audio.volume': 80,
  'audio.device': 'default',
  'audio.mute': false,
  'library.autoScrape': false,
  'metadata.provider': 'screenscraper',
  'metadata.language': 'pt-BR',
  'privacy.sendAnonymousMetrics': false,
  'retroachievements.hardcore': false,
  'retroachievements.username': null,
  'ui.reduceMotion': false,
});

function createRuntimeConfig({
  appRoot = PROJECT_ROOT,
  isPackaged = false,
  userDataPath,
  env = process.env,
} = {}) {
  const dataRoot = env.W3_DATA_DIR
    ? path.resolve(env.W3_DATA_DIR)
    : isPackaged
      ? path.resolve(userDataPath)
      : appRoot;
  const paths = new AppPaths({ dataRoot, appRoot });
  return {
    appRoot,
    isPackaged,
    isDev: !isPackaged,
    dataRoot,
    paths,
    defaultSettings: DEFAULT_SETTINGS,
    scanning: {
      maxConcurrency: Math.max(1, Math.min(4, Number(env.W3_SCAN_CONCURRENCY) || 2)),
      maxFileBytesInMemory: 2 * 1024 * 1024,
      ignoredDirectories: new Set([
        '.git',
        'node_modules',
        'System Volume Information',
        '$RECYCLE.BIN',
        'Windows',
        'saves',
      ]),
    },
    metadata: {
      requestsPerWindow: 50,
      windowMs: 60_000,
      cacheMinutes: 60 * 24 * 14,
      timeoutMs: 15_000,
    },
    emulation: {
      maxActiveSessions: 1,
      stopGraceMs: 4_000,
    },
    version: env.npm_package_version || APP_VERSION,
  };
}

module.exports = { createRuntimeConfig, DEFAULT_SETTINGS, PROJECT_ROOT };
