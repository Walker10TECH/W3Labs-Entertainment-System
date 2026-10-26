'use strict';

const crypto = require('node:crypto');
const { AppError } = require('../lib/errors');
const { getPlatform } = require('../../../config/platforms');
const {
  detectControllers,
  summarize,
  normalizeGuid,
  deterministicGuid,
  classifyCategory,
  isHidGameDevice,
  cleanGamepadName,
  KEYBOARD_GUID,
} = require('./controller-detector');

const SUPPORTED_APIS = Object.freeze(['xinput', 'directinput', 'keyboard']);

/**
 * Controles sem identificador do sistema recebem um GUID derivado do nome.
 * É estável entre sessões e permite vincular o aparelho mesmo quando o SO
 * não reporta GUID (Chromium, drivers genéricos).
 */
function derivedProfileGuid(api, productName) {
  return deterministicGuid('virtual', api, normalizeName(productName));
}

function normalizeName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function normalizeApi(api, mapping) {
  if (SUPPORTED_APIS.includes(api)) return api;
  if (api === 'gamepad-api' || api == null) {
    return mapping === 'standard' ? 'xinput' : 'directinput';
  }
  return null;
}

// ============================================================================
// Perfis: mapping, sanitização, serialização
// ============================================================================

function mappingFor(api) {
  if (api === 'keyboard') {
    return {
      up: 'KeyW',
      down: 'KeyS',
      left: 'KeyA',
      right: 'KeyD',
      south: 'KeyJ',
      east: 'KeyK',
      west: 'KeyL',
      north: 'KeyI',
      start: 'Enter',
      select: 'ShiftRight',
      l1: 'KeyQ',
      r1: 'KeyE',
      l2: 'KeyU',
      r2: 'KeyO',
    };
  }
  return {
    up: 'DPadUp',
    down: 'DPadDown',
    left: 'DPadLeft',
    right: 'DPadRight',
    south: 'A',
    east: 'B',
    west: 'X',
    north: 'Y',
    start: 'Start',
    select: 'Back',
    l1: 'LB',
    r1: 'RB',
    l2: 'LT',
    r2: 'RT',
    leftStick: 'L3',
    rightStick: 'R3',
  };
}

function parseMapping(raw, api) {
  if (!raw || typeof raw !== 'object') return mappingFor(api);
  const mapping = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[a-zA-Z0-9_]{1,24}$/.test(key)) continue;
    if (typeof value !== 'string' || value.length > 80) continue;
    mapping[key] = value;
  }
  return Object.keys(mapping).length > 0 ? mapping : mappingFor(api);
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function publicProfile(row) {
  return {
    id: row.id,
    playerIndex: row.player_index,
    name: row.name,
    api: row.api,
    hardwareGuid: row.hardware_guid,
    productName: row.product_name,
    isValid: Boolean(row.is_valid),
    mapping: parseMapping(safeJson(row.mapping_json), row.api),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// ControllerService
// ============================================================================

class ControllerService {
  constructor({ db, logger }) {
    this.db = db;
    this.logger = logger;
  }

  listProfiles() {
    return this.db.all('SELECT * FROM controller_profiles ORDER BY player_index').map(publicProfile);
  }

  /**
   * O GUID reportado pelo SO é preferido. Quando ele não existe, o perfil
   * recebe um GUID derivado do produto — o vínculo deixa de depender do
   * navegador/driver para funcionar.
   */
  saveProfile({ playerIndex, name, api, hardwareGuid, productName = null, mapping = null }) {
    const player = Number(playerIndex);
    if (!Number.isInteger(player) || player < 1 || player > 4) {
      throw new AppError('CONTROLLER_PLAYER_INVALID', 'Jogador deve estar entre 1 e 4.');
    }
    const resolvedApi = normalizeApi(api, null);
    if (!resolvedApi) {
      throw new AppError('CONTROLLER_API_INVALID', 'API de entrada inválida.');
    }

    const cleanName =
      String(name ?? '')
        .trim()
        .slice(0, 80) || `Jogador ${player}`;
    const cleanProduct = productName ? String(productName).trim().slice(0, 160) : null;

    let guid;
    if (resolvedApi === 'keyboard') {
      guid = KEYBOARD_GUID;
    } else {
      guid = normalizeGuid(hardwareGuid) ?? derivedProfileGuid(resolvedApi, cleanProduct || cleanName);
    }

    const duplicate = this.db.get(
      'SELECT * FROM controller_profiles WHERE hardware_guid = ? AND player_index <> ?',
      [guid, player],
    );
    if (duplicate) {
      throw new AppError('CONTROLLER_ALREADY_BOUND', 'Este controle já está vinculado a outro jogador.');
    }

    const existing = this.db.get('SELECT * FROM controller_profiles WHERE player_index = ?', [player]);
    const id = existing?.id ?? crypto.randomUUID();
    const serializedMapping = JSON.stringify(parseMapping(mapping, resolvedApi));
    this.db.run(
      `INSERT INTO controller_profiles (
         id, player_index, name, api, hardware_guid, product_name, is_valid, mapping_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(id) DO UPDATE SET
         player_index = excluded.player_index,
         name = excluded.name,
         api = excluded.api,
         hardware_guid = excluded.hardware_guid,
         product_name = excluded.product_name,
         is_valid = 1,
         mapping_json = excluded.mapping_json,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      [id, player, cleanName, resolvedApi, guid, cleanProduct, serializedMapping],
    );
    this.logger?.info('controllers', 'Perfil de controle salvo.', {
      player,
      api: resolvedApi,
      guid,
    });
    return this.listProfiles().find((profile) => profile.id === id);
  }

  setMapping(id, mapping) {
    const row = this.db.get('SELECT * FROM controller_profiles WHERE id = ?', [id]);
    if (!row) throw new AppError('CONTROLLER_PROFILE_NOT_FOUND', 'Perfil não encontrado.');
    const parsed = parseMapping(mapping, row.api);
    this.db.run(
      "UPDATE controller_profiles SET mapping_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      [JSON.stringify(parsed), id],
    );
    return this.listProfiles().find((profile) => profile.id === id);
  }

  removeProfile(id) {
    this.db.run('DELETE FROM controller_profiles WHERE id = ?', [id]);
  }

  /**
   * Diagnóstico a partir da lista do Gamepad API (sem bridge nativo).
   * Todo dispositivo recebe um GUID estável, então todos são vinculáveis.
   */
  inspectDetected(gamepads = [], platformId = null) {
    const platform = platformId ? getPlatform(platformId) : null;
    return {
      maxPlayers: platform?.maxPlayers ?? 4,
      guidance:
        'Diagnóstico via Gamepad API. Dispositivos sem GUID do sistema recebem um GUID derivado do nome, então o vínculo continua disponível.',
      sources: ['chromium-gamepad-api'],
      counts: {
        total: Array.isArray(gamepads) ? gamepads.length : 0,
        verified: 0,
        bindable: Array.isArray(gamepads) ? gamepads.length : 0,
      },
      devices: (Array.isArray(gamepads) ? gamepads : []).map((gamepad, index) => {
        const rawId = String(gamepad.id ?? 'Controle').slice(0, 160);
        const productName = cleanGamepadName(rawId) || 'Controle';
        const reported = normalizeGuid(gamepad.hardwareGuid);
        const api = normalizeApi(null, gamepad.mapping) ?? 'directinput';
        const guid = reported ?? derivedProfileGuid(api, productName);
        return {
          index,
          key: `chromium-gamepad-api:${guid}`,
          id: productName,
          productName,
          api,
          source: 'chromium-gamepad-api',
          category: classifyCategory(productName),
          mapping: gamepad.mapping ?? '',
          connected: Boolean(gamepad.connected),
          buttons: Number(gamepad.buttons) || 0,
          axes: Number(gamepad.axes) || 0,
          hardwareGuid: guid,
          guidOrigin: reported ? 'os' : 'derived',
          bindable: true,
        };
      }),
    };
  }

  /**
   * Diagnóstico nativo (XInput + HID) com fallback para os hints do Chromium.
   * Preserva a forma histórica dos campos e adiciona metadados de categoria,
   * origem do GUID e chave estável de vínculo.
   */
  async inspectHardware(platformId = null, { gamepadHints = null } = {}) {
    const platform = platformId ? getPlatform(platformId) : null;
    const detection = await detectControllers({
      platformId: platform?.id ?? null,
      maxPlayers: platform?.maxPlayers ?? 4,
      gamepadHints: Array.isArray(gamepadHints) ? gamepadHints.slice(0, 16) : null,
    });

    return {
      maxPlayers: detection.maxPlayers,
      guidance: detection.guidance,
      sources: detection.sources,
      counts: detection.counts,
      devices: detection.devices.map((device) => ({
        index: device.index,
        key: device.key,
        id: device.id,
        hardwareGuid: device.hardwareGuid,
        productName: device.productName,
        api: device.api,
        bindable: true,
        source: device.source,
        category: device.category,
        realGuid: device.realGuid,
        guidOrigin: device.guidOrigin,
        vendorId: device.vendorId,
        productId: device.productId,
        manufacturer: device.manufacturer,
        connected: device.connected ?? true,
        slot: device.slot ?? null,
        mapping: device.mapping ?? null,
        buttons: device.buttons ?? null,
        axes: device.axes ?? null,
      })),
    };
  }
}

module.exports = {
  ControllerService,
  scanHardwareControllers: async () => {
    const detection = await detectControllers();
    return detection.devices.map((device, index) => ({
      index,
      id: device.id,
      hardwareGuid: device.hardwareGuid,
      productName: device.productName,
      api: device.api,
      source: device.source,
    }));
  },
  detectControllers,
  summarize,
  normalizeGuid,
  mappingFor,
  KEYBOARD_GUID,
  deterministicGuid,
  classifyCategory,
  isHidGameDevice,
};
