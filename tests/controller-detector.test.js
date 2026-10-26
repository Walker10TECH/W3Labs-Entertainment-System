'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  detectControllers,
  deterministicGuid,
  cleanGamepadName,
  classifyCategory,
} = require('../src/main/services/controller-detector');

const V5_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function hidCollection(overrides = {}) {
  return {
    vendorId: 0x045e,
    productId: 0x0b13,
    product: 'Xbox Wireless Controller',
    manufacturer: 'Microsoft',
    serialNumber: 'ABC123',
    usagePage: 0x01,
    usage: 0x05,
    path: '\\\\?\\hid#vid_045e&pid_0b13&col01',
    ...overrides,
  };
}

test('GUID derivado tem forma RFC 4122 v5 e é estável', () => {
  const guid = deterministicGuid('device', '1118:045e:ABC123');
  assert.match(guid, V5_GUID);
  assert.equal(guid, deterministicGuid('device', '1118:045e:ABC123'));
  assert.notEqual(guid, deterministicGuid('device', '1118:045e:ABC124'));
  assert.equal(deterministicGuid('a'), deterministicGuid('a'));
});

test('identify() assíncrono do XInput é aguardado e absorve a coleção HID', async () => {
  const xinput = {
    listConnected: () => [true, false, false, false],
    identify: async () => [
      {
        name: 'Xbox Wireless Controller',
        manufacturer: 'Microsoft',
        vendorID: 0x045e,
        productID: 0x0b13,
        xinput: true,
        // GUID de classe: compartilhado, não serve como identidade.
        guid: ['11111111-1111-1111-1111-111111111111'],
      },
    ],
  };
  const hid = {
    devices: () => [hidCollection({ usage: 0x04 }), hidCollection({ usage: 0x05 })],
  };

  const result = await detectControllers({ xinput, hid, platformId: 'pc', maxPlayers: 4 });

  assert.equal(result.devices.length, 1);
  const [device] = result.devices;
  assert.equal(device.source, 'xinput-ffi');
  assert.equal(device.api, 'xinput');
  assert.equal(device.slot, 0);
  assert.equal(device.guidOrigin, 'hardware');
  assert.equal(device.realGuid, true);
  assert.match(device.hardwareGuid, V5_GUID);
  assert.notEqual(device.hardwareGuid, '11111111-1111-1111-1111-111111111111');
  assert.deepEqual(result.counts.byApi, { xinput: 1 });
  assert.equal(result.counts.verified, 1);
  assert.equal(result.counts.bindable, 1);
  assert.deepEqual(result.sources, ['xinput-ffi', 'node-hid']);
});

test('dois controles XInput idênticos recebem GUIDs distintos', async () => {
  const pad = {
    name: 'Xbox 360 Controller',
    manufacturer: 'Microsoft',
    vendorID: 0x045e,
    productID: 0x028e,
    xinput: true,
    guid: [],
  };
  const xinput = {
    listConnected: () => [true, true, false, false],
    identify: async () => [pad, { ...pad }],
  };

  const result = await detectControllers({ xinput, hid: { devices: () => [] } });

  assert.equal(result.devices.length, 2);
  assert.equal(new Set(result.devices.map((device) => device.hardwareGuid)).size, 2);
  assert.equal(new Set(result.devices.map((device) => device.key)).size, 2);
  assert.deepEqual(
    result.devices.map((device) => device.guidOrigin),
    ['slot', 'slot'],
  );
});

test('identify() sem listConnected usa os índices identificados', async () => {
  const xinput = {
    identify: async () => [
      { name: 'DualSense Wireless Controller', vendorID: 0x054c, productID: 0x0ce6, xinput: true },
    ],
  };

  const result = await detectControllers({ xinput, hid: null });

  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].productName, 'DualSense Wireless Controller');
  assert.equal(result.devices[0].guidOrigin, 'slot');
});

test('múltiplas coleções HID do mesmo aparelho viram um único dispositivo', async () => {
  const hid = {
    devices: () => [
      hidCollection({ usage: 0x04, path: '\\\\?\\hid#vid_045e&pid_0b13&col01' }),
      hidCollection({ usage: 0x05, path: '\\\\?\\hid#vid_045e&pid_0b13&col02' }),
      hidCollection({ product: 'USB Keyboard', usage: 0x06, usagePage: 0x01 }),
    ],
  };

  const result = await detectControllers({ xinput: null, hid });

  assert.equal(result.devices.length, 1);
  const [device] = result.devices;
  assert.equal(device.source, 'node-hid');
  assert.equal(device.api, 'directinput');
  assert.equal(device.productName, 'Xbox Wireless Controller');
  assert.equal(device.category, 'gamepad');
  assert.equal(device.guidOrigin, 'hardware');
  assert.match(device.hardwareGuid, V5_GUID);
});

test('dispositivos HID idênticos sem serial usam a porta USB como identidade', async () => {
  const hid = {
    devices: () => [
      hidCollection({ serialNumber: '', path: '\\\\?\\hid#vid_045e&pid_0b13&col01' }),
      hidCollection({
        serialNumber: '',
        product: 'Xbox Wireless Controller',
        path: '\\\\?\\hid#vid_045e&pid_0b13&mi_00&col01',
      }),
    ],
  };

  const result = await detectControllers({ xinput: null, hid });

  assert.equal(result.devices.length, 2);
  assert.equal(new Set(result.devices.map((device) => device.hardwareGuid)).size, 2);
});

test('slot XInput sem metadados é pareado com o HID da interface XInput', async () => {
  const xinput = {
    listConnected: async () => [true, false, false, false],
    identify: async () => [],
  };
  const hidDevices = [
    hidCollection({
      vendorId: 0x3537,
      productId: 0x100b,
      product: 'Controller (Xbox 360 Controller for Windows)',
      serialNumber: '00006F64096B22E7',
      path: '\\\\?\\HID#VID_3537&PID_100B&IG_00#9&24264982&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}',
    }),
  ];
  const hid = { devices: () => hidDevices };

  const withXInput = await detectControllers({ xinput, hid });
  const hidOnly = await detectControllers({ xinput: null, hid });

  assert.equal(withXInput.devices.length, 1);
  const [device] = withXInput.devices;
  assert.equal(device.source, 'xinput-ffi');
  assert.equal(device.api, 'xinput');
  assert.equal(device.guidOrigin, 'hardware');
  assert.equal(device.realGuid, true);
  assert.equal(device.productName, 'Controller (Xbox 360 Controller for Windows)');
  assert.equal(device.vendorId, 0x3537);
  // Mesmo GUID que a detecção puramente HID: o vínculo existente continua válido.
  assert.equal(device.hardwareGuid, hidOnly.devices[0].hardwareGuid);
});

test('não funde slot XInput sem metadados com HID não relacionado', async () => {
  const xinput = {
    listConnected: async () => [true, false, false, false],
    identify: async () => [],
  };
  const hid = {
    devices: () => [
      hidCollection({
        vendorId: 0x044f,
        productId: 0x0404,
        product: 'Thrustmaster HOTAS Warthog',
        manufacturer: 'Thrustmaster',
        serialNumber: 'HOTAS1',
        path: '\\\\?\\HID#VID_044F&PID_0404&MI_00#8&1&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}',
      }),
    ],
  };

  const result = await detectControllers({ xinput, hid });

  assert.equal(result.devices.length, 2);
  const pad = result.devices.find((device) => device.source === 'xinput-ffi');
  const stick = result.devices.find((device) => device.source === 'node-hid');
  assert.equal(pad.guidOrigin, 'slot');
  assert.equal(stick.category, 'flight-stick');
  assert.equal(stick.guidOrigin, 'hardware');
});

test('hint do Chromium duplicando controle nativo é descartado', async () => {
  const xinput = {
    listConnected: () => [true, false, false, false],
    identify: async () => [
      { name: 'DualShock 4', vendorID: 0x054c, productID: 0x09cc, xinput: true, guid: [] },
    ],
  };
  const gamepadHints = [
    {
      index: 0,
      id: '054c-09cc-DualShock 4 (STANDARD GAMEPAD Vendor: 054c Product: 09cc)',
      mapping: 'standard',
      connected: true,
      buttons: 18,
      axes: 4,
    },
  ];

  const result = await detectControllers({ xinput, hid: null, gamepadHints });

  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].source, 'xinput-ffi');
  assert.equal(result.sources.includes('chromium-gamepad-api'), false);
});

test('hint sem correspondência nativa vira controle com GUID derivado', async () => {
  const gamepadHints = [
    {
      index: 0,
      id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)',
      mapping: 'standard',
      connected: true,
      buttons: 17,
      axes: 4,
    },
  ];

  const result = await detectControllers({ xinput: null, hid: null, gamepadHints });

  assert.equal(result.devices.length, 1);
  const [device] = result.devices;
  assert.equal(device.source, 'chromium-gamepad-api');
  assert.equal(device.api, 'gamepad-api');
  assert.equal(device.guidOrigin, 'derived');
  assert.match(device.hardwareGuid, V5_GUID);
  assert.equal(result.counts.verified, 0);
  assert.equal(result.counts.total, 1);
  assert.deepEqual(result.sources, ['chromium-gamepad-api']);
  assert.match(result.guidance, /GUID derivado/i);
  assert.equal(result.maxPlayers, 4);
});

test('helpers classificam e limpam nomes de controles', () => {
  assert.equal(classifyCategory('Logitech G29 Driving Force'), 'wheel');
  assert.equal(classifyCategory('Thrustmaster HOTAS Warthog'), 'flight-stick');
  assert.equal(classifyCategory('Hori Real Arcade Pro'), 'arcade-stick');
  assert.equal(classifyCategory('Xbox Wireless Controller'), 'gamepad');
  assert.equal(classifyCategory(''), 'gamepad');
  assert.equal(cleanGamepadName('Xbox 360 Controller (XInput STANDARD GAMEPAD)'), 'Xbox 360 Controller');
  assert.equal(
    cleanGamepadName('054c-09cc-DualShock 4 (STANDARD GAMEPAD Vendor: 054c Product: 09cc)'),
    'DualShock 4',
  );
});
