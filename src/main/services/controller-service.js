'use strict';

const crypto = require('node:crypto');
const { AppError } = require('../lib/errors');
const { getPlatform } = require('../../../config/platforms');

const GUID_PATTERN = /^[{(]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[)}]?$/i;
const KEYBOARD_GUID = '00000000-0000-0000-0000-000000000000';

function normalizeGuid(value) {
  const guid = String(value ?? '')
    .trim()
    .replace(/^\{|\}$/g, '')
    .toLowerCase();
  return GUID_PATTERN.test(guid) ? guid : null;
}

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

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

class ControllerService {
  constructor({ db, logger }) {
    this.db = db;
    this.logger = logger;
  }

  listProfiles() {
    return this.db.all('SELECT * FROM controller_profiles ORDER BY player_index').map(publicProfile);
  }

  /**
   * Aceita apenas GUID reportado pelo SO no formato canônico. O renderer não
   * consegue fabricar um GUID válido para vincular um controle físico.
   */
  saveProfile({ playerIndex, name, api, hardwareGuid, productName = null, mapping = null }) {
    const player = Number(playerIndex);
    if (!Number.isInteger(player) || player < 1 || player > 4) {
      throw new AppError('CONTROLLER_PLAYER_INVALID', 'Jogador deve estar entre 1 e 4.');
    }
    if (!['xinput', 'directinput', 'keyboard'].includes(api)) {
      throw new AppError('CONTROLLER_API_INVALID', 'API de entrada inválida.');
    }

    let guid;
    if (api === 'keyboard') {
      guid = KEYBOARD_GUID;
    } else {
      guid = normalizeGuid(hardwareGuid);
      if (!guid) {
        throw new AppError(
          'CONTROLLER_GUID_INVALID',
          'O sistema operacional não reportou um GUID de hardware válido. O perfil não pode ser vinculado.',
        );
      }
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
    const cleanName =
      String(name ?? '')
        .trim()
        .slice(0, 80) || `Jogador ${player}`;
    const cleanProduct = productName ? String(productName).trim().slice(0, 160) : null;
    const serializedMapping = JSON.stringify(parseMapping(mapping, api));
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
      [id, player, cleanName, api, guid, cleanProduct, serializedMapping],
    );
    this.logger?.info('controllers', 'Perfil de controle salvo.', { player, api, guid });
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
   * Converte a lista do Gamepad API em um diagnóstico. Um gamepad só é
   * "boundable" quando o campo GUID traz um UUID de hardware válido.
   */
  inspectDetected(gamepads = [], platformId = null) {
    const platform = platformId ? getPlatform(platformId) : null;
    return {
      maxPlayers: platform?.maxPlayers ?? 4,
      guidance:
        'XInput e DirectInput exigem GUID de hardware reportado pelo SO. O Chromium entrega apenas o ID do dispositivo; vincule via bridge de entrada nativo quando o GUID não estiver disponível.',
      devices: (Array.isArray(gamepads) ? gamepads : []).map((gamepad) => {
        const guid = normalizeGuid(gamepad.hardwareGuid);
        return {
          index: Number(gamepad.index) || 0,
          id: String(gamepad.id ?? 'Controle').slice(0, 160),
          mapping: gamepad.mapping ?? 'standard',
          connected: Boolean(gamepad.connected),
          buttons: Number(gamepad.buttons) || 0,
          axes: Number(gamepad.axes) || 0,
          hardwareGuid: guid,
          bindable: Boolean(guid),
        };
      }),
    };
  }
}

module.exports = {
  ControllerService,
  normalizeGuid,
  mappingFor,
  KEYBOARD_GUID,
};
