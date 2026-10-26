'use strict';

const crypto = require('node:crypto');

/**
 * Detector nativo de controles.
 *
 * Fontes, em ordem de precedência:
 *   1. xinput-ffi  → slots XInput com nome/vendor/produto (Windows).
 *   2. node-hid    → dispositivos HID/DirectInput com serial/porta estáveis.
 *   3. Gamepad API → hints do renderer (Chromium), sem GUID de hardware.
 *
 * Cada dispositivo físico aparece uma única vez: um slot XInput absorve a
 * coleção HID equivalente e hints do Chromium que já têm correspondência
 * nativa são descartados.
 */

const GUID_PATTERN = /^[{(]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[)}]?$/i;

// GUID sentinela usado pelo ControllerService para o "controle" de teclado.
const KEYBOARD_GUID = '00000000-0000-0000-0000-000000000000';

// HID Generic Desktop usage page e usages relevantes para gamepads/joysticks.
const HID_USAGE_PAGE_GENERIC = 0x01;
const HID_USAGE_JOYSTICK = 0x04;
const HID_USAGE_GAMEPAD = 0x05;
const HID_USAGE_MULTIAXIS = 0x08;

// Quanto menor, melhor: a coleção de gamepad vence as demais do mesmo aparelho.
const HID_USAGE_PRIORITY = Object.freeze({
  [HID_USAGE_GAMEPAD]: 0,
  [HID_USAGE_JOYSTICK]: 1,
  [HID_USAGE_MULTIAXIS]: 2,
});

const GAME_DEVICE_NAME =
  /gamepad|joystick|controller|wheel|flight|hotas|arcade|fight\s*stick|racing|sim\s*rig|force\s*feedback|dualshock|dualsense|xbox|nintendo|joy-?con|steam\s*controller|8bitdo/i;

const CATEGORY_RULES = Object.freeze([
  {
    category: 'wheel',
    pattern:
      /wheel|racing|force\s*feedback|g29|g920|g923|g27|t300|t500|tx\s*racing|csl|club\s*sport|dd[12]|simucube|fanatec|moza|thrustmaster\s*tx/i,
  },
  {
    category: 'flight-stick',
    pattern: /flight|hotas|throttle|warthog|t\.?16000|airbus|joystick\s*(x|pro)?/i,
  },
  {
    category: 'arcade-stick',
    pattern: /arcade|fight\s*stick|hitbox|leverless|stickless|sanwa|hori\s*real|qanba|mayflash/i,
  },
  { category: 'gamepad', pattern: GAME_DEVICE_NAME },
]);

const SOURCE_PRECEDENCE = Object.freeze({
  'xinput-ffi': 0,
  'node-hid': 1,
  'chromium-gamepad-api': 2,
});

// -------------------- Helpers --------------------

function safeRequire(name) {
  try {
    return require(name);
  } catch {
    return null;
  }
}

let xinputModule = null;
let hidModule;
let hidLoaded = false;

/**
 * xinput-ffi é um pacote ESM: `require()` falha no Electron. O import é
 * dinâmico, resolvido uma única vez por processo.
 */
function loadXInput() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (!xinputModule) {
    xinputModule = import('xinput-ffi').catch(() => null);
  }
  return xinputModule;
}

function loadHID() {
  if (!hidLoaded) {
    hidLoaded = true;
    hidModule = safeRequire('node-hid');
  }
  return hidModule ?? null;
}

function withTimeout(promise, ms, fallback) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

/**
 * GUID determinístico (RFC 4122 v5-like) derivado de dados de hardware.
 * Estável enquanto o identificador físico (serial/porta) não mudar.
 */
function deterministicGuid(...parts) {
  const hash = crypto.createHash('sha1').update(parts.join(':')).digest('hex');
  const variant = ((parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `${variant}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}

function normalizeGuid(value) {
  const guid = String(value ?? '')
    .trim()
    .replace(/^\{|\}$/g, '')
    .toLowerCase();
  return GUID_PATTERN.test(guid) ? guid : null;
}

function normalizeName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function classifyCategory(productName) {
  const name = String(productName ?? '');
  if (!name) return 'gamepad';
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(name)) return rule.category;
  }
  return 'gamepad';
}

function isHidGameDevice(device) {
  if (!device || typeof device !== 'object') return false;
  if (device.usagePage === HID_USAGE_PAGE_GENERIC) {
    if ([HID_USAGE_JOYSTICK, HID_USAGE_GAMEPAD, HID_USAGE_MULTIAXIS].includes(device.usage)) {
      return true;
    }
  }
  return GAME_DEVICE_NAME.test(String(device.product ?? ''));
}

function countBy(items, key) {
  const result = {};
  for (const item of items) {
    const value = item?.[key] ?? 'unknown';
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}

function hexId(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number.toString(16).padStart(4, '0') : null;
}

// -------------------- Scanners --------------------

/** Porta USB do aparelho: remove o sufixo da coleção (`&colNN`) e a classe. */
function hidPathKey(device) {
  return String(device?.path ?? '')
    .replace(/&col\d+/gi, '')
    .replace(/\{[^}]*\}$/, '')
    .toLowerCase();
}

/**
 * Identidade física: serial quando existe, senão a porta USB. Todas as
 * coleções HID do mesmo aparelho compartilham esta chave — e dois controles
 * idênticos sem serial continuam distintos por ocuparem portas diferentes.
 */
function hidIdentity(device) {
  const vendor = Number(device?.vendorId) || 0;
  const product = Number(device?.productId) || 0;
  const serial = String(device?.serialNumber ?? '').trim();
  return `${vendor}:${product}:${
    serial || hidPathKey(device) || normalizeName(device?.product) || 'unknown'
  }`;
}

/** Chave de agrupamento das coleções HID (mesma identidade física). */
function hidGroupKey(device) {
  return hidIdentity(device);
}

/**
 * Agrupa as várias coleções HID do mesmo aparelho em um único dispositivo,
 * preferindo a coleção de gamepad e mantendo serial/porta como identidade.
 */
function scanHID(HID) {
  if (!HID || typeof HID.devices !== 'function') return [];
  let list;
  try {
    list = HID.devices();
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];

  const groups = new Map();
  for (const device of list) {
    if (!isHidGameDevice(device)) continue;
    const key = hidGroupKey(device);
    const priority = HID_USAGE_PRIORITY[device?.usage] ?? 9;
    const hasSerial = Boolean(String(device?.serialNumber ?? '').trim());
    const current = groups.get(key);
    if (!current) {
      groups.set(key, { device, priority, hasSerial });
      continue;
    }
    if (priority < current.priority || (!current.hasSerial && hasSerial)) {
      groups.set(key, { device, priority, hasSerial });
    }
  }

  return [...groups.values()].map(({ device, priority }) => {
    const productName = String(device?.product ?? '').trim();
    const vendorId = Number(device?.vendorId) || null;
    const productId = Number(device?.productId) || null;
    const fallbackName = `HID ${hexId(vendorId) ?? '0000'}:${hexId(productId) ?? '0000'}`;
    return {
      hidKey: hidIdentity(device),
      hidUsagePriority: priority,
      id: (productName || fallbackName).slice(0, 160),
      productName: productName || null,
      hardwareGuid: deterministicGuid('device', hidIdentity(device)),
      api: 'directinput',
      source: 'node-hid',
      category: classifyCategory(productName),
      bindable: true,
      realGuid: true,
      guidOrigin: 'hardware',
      vendorId,
      productId,
      manufacturer: device?.manufacturer ?? null,
      connected: true,
    };
  });
}

/**
 * `identify()` devolve GUIDs de *classe* (compartilhados entre dispositivos),
 * então eles não servem como identidade. Usamos vendor/produto + serial HID
 * (ou slot XInput quando não há serial) para derivar um GUID estável.
 */
async function scanXInput(XInput, hidDevices) {
  if (!XInput || typeof XInput.identify !== 'function') {
    return { devices: [], consumedHid: new Set() };
  }

  const [slotsResult, identifyResult] = await Promise.allSettled([
    typeof XInput.listConnected === 'function' ? XInput.listConnected() : Promise.resolve(null),
    withTimeout(XInput.identify({ XInputOnly: true }), 6000, []),
  ]);

  const identified = Array.isArray(identifyResult.value)
    ? identifyResult.value.filter((entry) => entry && entry.xinput !== false)
    : [];
  const slots = Array.isArray(slotsResult.value) ? slotsResult.value : [];

  const connectedSlots = [];
  slots.forEach((connected, slot) => {
    if (connected) connectedSlots.push(slot);
  });
  if (connectedSlots.length === 0 && identified.length > 0) {
    identified.forEach((_entry, slot) => connectedSlots.push(slot));
  }

  const usedInfo = new Set();
  const consumedHid = new Set();
  const usedHid = new Set();

  const devices = connectedSlots.map((slot) => {
    const entry =
      identified.find((candidate) => !usedInfo.has(candidate)) ??
      identified[slot % (identified.length || 1)] ??
      null;
    if (entry) usedInfo.add(entry);

    const vendorId = Number(entry?.vendorID) || null;
    const productId = Number(entry?.productID) || null;
    const entryName = String(entry?.name ?? '').trim();

    const hidMatch =
      (vendorId && productId
        ? hidDevices.find(
            (device) =>
              !usedHid.has(device.hidKey) && device.vendorId === vendorId && device.productId === productId,
          )
        : null) ??
      (entryName
        ? hidDevices.find(
            (device) =>
              !usedHid.has(device.hidKey) &&
              normalizeName(device.productName ?? '') === normalizeName(entryName),
          )
        : null);

    const device = {
      id: (entryName || 'Controle XInput').slice(0, 160),
      productName: entryName || null,
      hardwareGuid: deterministicGuid('device', `${vendorId ?? 0}:${productId ?? 0}:slot${slot}`),
      api: 'xinput',
      source: 'xinput-ffi',
      category: classifyCategory(entryName),
      bindable: true,
      realGuid: false,
      guidOrigin: 'slot',
      vendorId,
      productId,
      manufacturer: entry?.manufacturer ?? null,
      connected: true,
      slot,
      hidKey: null,
    };

    if (hidMatch) {
      usedHid.add(hidMatch.hidKey);
      consumedHid.add(hidMatch.hidKey);
      applyHidIdentity(device, hidMatch);
    }
    return device;
  });

  // `identify()` pode vir vazio (drivers antigos/terceiros) mesmo com slots
  // ativos. Sem vendor/produto, pareamos por ordem com os HIDs da interface
  // XInput (IG_00), que pertencem ao mesmo aparelho físico.
  const anonymous = devices.filter((device) => !device.hidKey);
  const xinputHid = hidDevices.filter(
    (device) => !consumedHid.has(device.hidKey) && isXInputHidCandidate(device),
  );
  if (anonymous.length > 0 && xinputHid.length === anonymous.length) {
    anonymous.forEach((device, position) => {
      const hidMatch = xinputHid[position];
      consumedHid.add(hidMatch.hidKey);
      applyHidIdentity(device, hidMatch);
    });
  }

  return { devices, consumedHid };
}

/** Extrai vendor/produto de IDs do Chromium ("045e-02fd-...", "Vendor: 045e"). */
function padVendorIds(rawId) {
  const text = String(rawId ?? '');
  const pair =
    text.match(/vendor[:\s]*([0-9a-f]{4}).*?product[:\s]*([0-9a-f]{4})/i) ??
    text.match(/^([0-9a-f]{4})-([0-9a-f]{4})-/i);
  if (!pair) return null;
  return { vendorId: parseInt(pair[1], 16), productId: parseInt(pair[2], 16) };
}

function cleanGamepadName(rawId) {
  return String(rawId ?? 'Controle')
    .replace(/\s*\([^)]*(?:standard gamepad|xinput|vendor:)[^)]*\)\s*$/i, '')
    .replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '')
    .trim()
    .slice(0, 160);
}

function matchesNative(hint, natives) {
  const ids = padVendorIds(hint.id);
  if (
    ids &&
    natives.some((device) => device.vendorId === ids.vendorId && device.productId === ids.productId)
  ) {
    return true;
  }
  const name = normalizeName(cleanGamepadName(hint.id));
  if (!name) return false;
  return natives.some((device) => {
    const nativeName = normalizeName(device.productName ?? device.id);
    return Boolean(nativeName && (name.includes(nativeName) || nativeName.includes(name)));
  });
}

/**
 * HID que representa a própria interface XInput (usado quando `identify()`
 * não devolve metadados e o pareamento por vendor/produto fica impossível).
 */
function isXInputHidCandidate(device) {
  if (
    String(device?.path ?? '')
      .toLowerCase()
      .includes('ig_00')
  )
    return true;
  return /xbox|xinput/i.test(String(device?.productName ?? ''));
}

/** Completa a identidade de um slot XInput com os dados do HID equivalente. */
function applyHidIdentity(device, hidMatch) {
  device.hidKey = hidMatch.hidKey;
  device.hardwareGuid = deterministicGuid('device', hidMatch.hidKey);
  device.guidOrigin = 'hardware';
  device.realGuid = true;
  device.vendorId = device.vendorId ?? hidMatch.vendorId;
  device.productId = device.productId ?? hidMatch.productId;
  device.manufacturer = device.manufacturer ?? hidMatch.manufacturer;
  if (!device.productName) {
    device.productName = hidMatch.productName;
    device.id = hidMatch.id;
  }
  device.category = classifyCategory(device.productName);
}

function scanGamepadApi(gamepads, natives) {
  if (!Array.isArray(gamepads)) return [];
  const hints = gamepads.filter((gamepad) => gamepad && typeof gamepad === 'object');
  const nativeGamepads = natives.filter((device) => device.category === 'gamepad');
  const allStandard = hints.every((gamepad) => (gamepad.mapping ?? 'standard') === 'standard');

  return hints
    .filter((gamepad) => {
      if (matchesNative(gamepad, natives)) return false;
      // No Windows o Chromium expõe o mesmo pad já lido via XInput/HID, sem
      // vendor id no `id`. Se a contagem bate, trata como duplicata.
      return !(allStandard && nativeGamepads.length > 0 && nativeGamepads.length >= hints.length);
    })
    .map((gamepad) => {
      const cleaned = cleanGamepadName(gamepad.id);
      const ids = padVendorIds(gamepad.id);
      const reportedGuid = normalizeGuid(gamepad.hardwareGuid);
      return {
        id: cleaned || 'Controle',
        productName: cleaned || null,
        hardwareGuid: reportedGuid,
        api: 'gamepad-api',
        source: 'chromium-gamepad-api',
        category: classifyCategory(cleaned),
        bindable: true,
        realGuid: Boolean(reportedGuid),
        guidOrigin: reportedGuid ? 'os' : 'derived',
        vendorId: ids?.vendorId ?? null,
        productId: ids?.productId ?? null,
        manufacturer: null,
        connected: Boolean(gamepad.connected),
        slot: Number(gamepad.index) || 0,
        mapping: gamepad.mapping ?? '',
        buttons: Number(gamepad.buttons) || 0,
        axes: Number(gamepad.axes) || 0,
      };
    });
}

// -------------------- Merge --------------------

function uniqueGuid(candidate, used) {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let attempt = 2;
  let guid = deterministicGuid(candidate, attempt);
  while (used.has(guid)) {
    attempt += 1;
    guid = deterministicGuid(candidate, attempt);
  }
  used.add(guid);
  return guid;
}

/**
 * Consolida as fontes, garante GUID único por dispositivo e atribui a chave
 * usada pela UI para vincular (nunca o índice, que colide entre fontes).
 */
function mergeDevices(devices) {
  const ordered = [...devices].sort(
    (a, b) => (SOURCE_PRECEDENCE[a.source] ?? 99) - (SOURCE_PRECEDENCE[b.source] ?? 99),
  );
  const usedGuids = new Set();
  const seen = new Set();
  const result = [];

  for (const device of ordered) {
    const derived =
      device.hardwareGuid ??
      deterministicGuid('device', device.source ?? 'unknown', normalizeName(device.id) || 'controle');
    const guid = uniqueGuid(derived, usedGuids);
    const key = `${device.source ?? 'unknown'}:${guid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      ...device,
      index: result.length,
      key,
      hardwareGuid: guid,
      bindable: true,
      guidOrigin: device.hardwareGuid ? (device.guidOrigin ?? 'derived') : 'derived',
    });
  }
  return result;
}

function buildGuidance(sources, devices) {
  if (sources.length === 0) {
    return 'Nenhuma fonte de detecção disponível. Instale node-hid e, no Windows, xinput-ffi para reconhecer controles sem precisar de driver extra.';
  }
  const tips = [];
  if (sources.includes('xinput-ffi')) {
    tips.push(
      'XInput ativo: slots lidos direto do driver da Microsoft; quando o driver não expõe nome/vendor, a identidade vem do HID correspondente.',
    );
  }
  if (sources.includes('node-hid')) {
    tips.push('HID/DirectInput: a identidade usa serial ou porta USB, estável entre sessões.');
  }
  if (sources.includes('chromium-gamepad-api')) {
    tips.push('Gamepad API cobre dispositivos sem driver nativo.');
  }
  if (devices.some((device) => device.guidOrigin === 'derived')) {
    tips.push(
      'Controles sem identificador do sistema recebem um GUID derivado do nome — o vínculo continua válido.',
    );
  }
  return tips.join(' ');
}

// -------------------- API pública --------------------

/**
 * Executa todos os scanners disponíveis e devolve o snapshot consolidado.
 *
 * @param {object} [options]
 * @param {string|null} [options.platformId]   Plataforma-alvo (metadado).
 * @param {number}      [options.maxPlayers]   Limite da plataforma (1-8).
 * @param {Array|null}  [options.gamepadHints] Lista de gamepads do Gamepad API (opcional).
 * @param {object|null} [options.xinput]       Módulo XInput injetado (testes).
 * @param {object|null} [options.hid]          Módulo HID injetado (testes).
 */
async function detectControllers({
  platformId = null,
  maxPlayers = 4,
  gamepadHints = null,
  xinput,
  hid,
} = {}) {
  const XInput = xinput === undefined ? await loadXInput() : xinput;
  const HID = hid === undefined ? loadHID() : hid;

  const hidDevices = scanHID(HID);
  const xinputScan = await scanXInput(XInput, hidDevices);
  const remainingHid = hidDevices.filter((device) => !xinputScan.consumedHid.has(device.hidKey));

  const nativeDevices = [...xinputScan.devices, ...remainingHid];
  const hintDevices = gamepadHints ? scanGamepadApi(gamepadHints, nativeDevices) : [];

  const sources = [];
  if (XInput) sources.push('xinput-ffi');
  if (HID) sources.push('node-hid');
  if (hintDevices.length > 0) sources.push('chromium-gamepad-api');

  const devices = mergeDevices([...nativeDevices, ...hintDevices]);

  return {
    platformId,
    maxPlayers: Math.max(1, Math.min(8, Number(maxPlayers) || 4)),
    sources,
    counts: {
      total: devices.length,
      verified: devices.filter((device) => device.guidOrigin !== 'derived').length,
      bindable: devices.length,
      byApi: countBy(devices, 'api'),
      byCategory: countBy(devices, 'category'),
    },
    devices,
    guidance: buildGuidance(sources, devices),
  };
}

/** Formata a detecção em texto legível (para logs ou diagnóstico no CLI). */
function summarize(detection) {
  if (!detection?.devices?.length) return 'Nenhum controle detectado.';
  const lines = detection.devices.map((device, i) => {
    const source = device.source ?? 'desconhecido';
    return `  ${i + 1}. ${device.id} [${device.category}, ${device.api}, ${source}, ${device.guidOrigin}]`;
  });
  return [`${detection.devices.length} controle(s) detectado(s):`, ...lines].join('\n');
}

module.exports = {
  detectControllers,
  summarize,
  normalizeGuid,
  deterministicGuid,
  classifyCategory,
  isHidGameDevice,
  cleanGamepadName,
  KEYBOARD_GUID,
  loadXInput,
  loadHID,
};
