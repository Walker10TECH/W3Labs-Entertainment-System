'use strict';

/**
 * Catálogo canônico de plataformas. É a única fonte de verdade para extensões,
 * requisitos de BIOS, isolamento de núcleos e limites de jogadores.
 */
const REGIONS = Object.freeze({
  'ntsc-u': { id: 'ntsc-u', label: 'NTSC-U', short: 'USA' },
  'ntsc-j': { id: 'ntsc-j', label: 'NTSC-J', short: 'JAP' },
  pal: { id: 'pal', label: 'PAL', short: 'EUR' },
  global: { id: 'global', label: 'Global', short: 'ALL' },
  unknown: { id: 'unknown', label: 'Não definida', short: '?' },
});

const PLATFORMS = Object.freeze({
  ps1: {
    id: 'ps1',
    name: 'PlayStation',
    shortName: 'PS1',
    manufacturer: 'Sony',
    generation: 5,
    year: 1994,
    color: '#f0a44b',
    accent: 'amber',
    mediaType: 'rom',
    extensions: ['.cue', '.chd', '.pbp', '.iso', '.m3u'],
    maxPlayers: 2,
    heavy: false,
    isolated: true,
    defaultCore: 'duckstation',
    cores: ['duckstation'],
    bios: {
      required: true,
      kinds: ['bios'],
      regions: ['ntsc-u', 'ntsc-j', 'pal'],
      bootGuardSeconds: 10,
      label: 'BIOS PS1',
    },
    hardwareWarning: false,
    saveStateFormat: 'RetroArch/libretro ou bridge compatível',
  },
  ps2: {
    id: 'ps2',
    name: 'PlayStation 2',
    shortName: 'PS2',
    manufacturer: 'Sony',
    generation: 6,
    year: 2000,
    color: '#6f8cff',
    accent: 'blue',
    mediaType: 'iso',
    extensions: ['.iso', '.chd', '.cso'],
    maxPlayers: 2,
    heavy: true,
    isolated: true,
    defaultCore: 'pcsx2',
    cores: ['pcsx2'],
    bios: {
      required: true,
      kinds: ['bios'],
      regions: ['ntsc-u', 'ntsc-j', 'pal'],
      bootGuardSeconds: 10,
      label: 'BIOS PS2',
    },
    hardwareWarning: true,
    saveStateFormat: 'PCSX2/bridge compatível',
  },
  nes: {
    id: 'nes',
    name: 'Nintendo Entertainment System',
    shortName: 'NES',
    manufacturer: 'Nintendo',
    generation: 3,
    year: 1983,
    color: '#ee6b6e',
    accent: 'red',
    mediaType: 'rom',
    extensions: ['.nes', '.unf', '.unif'],
    maxPlayers: 2,
    heavy: false,
    isolated: true,
    defaultCore: 'mesen',
    cores: ['mesen'],
    bios: {
      required: false,
      kinds: [],
      regions: [],
      bootGuardSeconds: 0,
      label: 'Sem BIOS obrigatória',
    },
    hardwareWarning: false,
    saveStateFormat: 'Mesen/libretro ou bridge compatível',
  },
  xbox: {
    id: 'xbox',
    name: 'Xbox Clássico',
    shortName: 'XBOX',
    manufacturer: 'Microsoft',
    generation: 6,
    year: 2001,
    color: '#76d572',
    accent: 'green',
    mediaType: 'iso',
    extensions: ['.iso', '.xiso'],
    maxPlayers: 4,
    heavy: true,
    isolated: true,
    defaultCore: 'xemu',
    cores: ['xemu'],
    bios: {
      required: true,
      kinds: ['bootrom', 'flash'],
      regions: ['global'],
      bootGuardSeconds: 10,
      label: 'MCPX + BIOS flash',
    },
    hardwareWarning: true,
    saveStateFormat: 'Bridge de snapshots do xemu',
  },
  ps3: {
    id: 'ps3',
    name: 'PlayStation 3',
    shortName: 'PS3',
    manufacturer: 'Sony',
    generation: 7,
    year: 2006,
    color: '#9b8cff',
    accent: 'violet',
    mediaType: 'iso',
    extensions: ['.iso', '.pkg'],
    maxPlayers: 4,
    heavy: true,
    isolated: true,
    defaultCore: 'rpcs3',
    cores: ['rpcs3'],
    bios: {
      required: false,
      recommended: true,
      kinds: ['firmware'],
      regions: ['global'],
      bootGuardSeconds: 0,
      label: 'Firmware PS3 (recomendado)',
    },
    hardwareWarning: true,
    saveStateFormat: 'RPCS3/bridge compatível',
  },
  xbox360: {
    id: 'xbox360',
    name: 'Xbox 360',
    shortName: 'X360',
    manufacturer: 'Microsoft',
    generation: 7,
    year: 2005,
    color: '#5fd06f',
    accent: 'green',
    mediaType: 'iso',
    extensions: ['.iso', '.xex', '.zar'],
    maxPlayers: 4,
    heavy: true,
    isolated: true,
    defaultCore: 'xenia',
    cores: ['xenia'],
    bios: {
      required: false,
      kinds: [],
      regions: [],
      bootGuardSeconds: 0,
      label: 'Sem BIOS obrigatória',
    },
    hardwareWarning: true,
    saveStateFormat: 'Xenia/bridge compatível',
  },
  gb: {
    id: 'gb',
    name: 'Game Boy / Game Boy Color',
    shortName: 'GB',
    manufacturer: 'Nintendo',
    generation: 4,
    year: 1989,
    color: '#bbda56',
    accent: 'lime',
    mediaType: 'rom',
    extensions: ['.gb', '.gbc'],
    maxPlayers: 2,
    heavy: false,
    isolated: true,
    defaultCore: 'sameboy',
    cores: ['sameboy'],
    bios: {
      required: false,
      optional: true,
      kinds: ['bootrom'],
      regions: ['global'],
      bootGuardSeconds: 0,
      label: 'Boot ROM opcional',
    },
    hardwareWarning: false,
    saveStateFormat: 'SameBoy/libretro ou bridge compatível',
  },
});

const EXTENSION_INDEX = new Map();
for (const platform of Object.values(PLATFORMS)) {
  for (const extension of platform.extensions) {
    EXTENSION_INDEX.set(extension.toLowerCase(), platform.id);
  }
}

function getPlatform(platformId) {
  const platform = PLATFORMS[platformId];
  if (!platform) {
    const error = new Error(`Plataforma desconhecida: ${platformId}`);
    error.code = 'UNKNOWN_PLATFORM';
    throw error;
  }
  return platform;
}

function platformForFile(fileName) {
  const dot = String(fileName).lastIndexOf('.');
  if (dot < 0) return null;
  return EXTENSION_INDEX.get(String(fileName).slice(dot).toLowerCase()) ?? null;
}

function publicPlatforms() {
  return Object.values(PLATFORMS).map((platform) => ({
    id: platform.id,
    name: platform.name,
    shortName: platform.shortName,
    manufacturer: platform.manufacturer,
    generation: platform.generation,
    year: platform.year,
    color: platform.color,
    accent: platform.accent,
    extensions: platform.extensions,
    maxPlayers: platform.maxPlayers,
    heavy: platform.heavy,
    isolated: platform.isolated,
    defaultCore: platform.defaultCore,
    cores: platform.cores,
    biosRequired: platform.bios.required,
    biosRecommended: Boolean(platform.bios.recommended),
    biosOptional: Boolean(platform.bios.optional),
    biosLabel: platform.bios.label,
    biosKinds: platform.bios.kinds,
    biosRegions: platform.bios.regions,
    hardwareWarning: platform.hardwareWarning,
  }));
}

function normalizeRegion(region) {
  const value = String(region ?? '').toLowerCase();
  if (REGIONS[value]) return value;
  if (['usa', 'us', 'ntsc', 'ntsc-u/c', 'america'].includes(value)) return 'ntsc-u';
  if (['japan', 'jp', 'ntsc-j', 'asia'].includes(value)) return 'ntsc-j';
  if (['europe', 'eu', 'eur', 'pal-e'].includes(value)) return 'pal';
  if (['world', 'all', 'global'].includes(value)) return 'global';
  return 'unknown';
}

module.exports = {
  PLATFORMS,
  REGIONS,
  getPlatform,
  platformForFile,
  publicPlatforms,
  normalizeRegion,
};
