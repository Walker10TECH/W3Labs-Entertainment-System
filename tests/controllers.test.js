'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ControllerService,
  normalizeGuid,
  KEYBOARD_GUID,
} = require('../src/main/services/controller-service');
const { createTestEnvironment, silentLogger } = require('./helpers');

test('identifica qualquer controle automaticamente, mesmo sem GUID do SO', () => {
  const env = createTestEnvironment();
  const service = new ControllerService({ db: env.db, logger: silentLogger });
  try {
    assert.equal(
      normalizeGuid('{A1B2C3D4-E5F6-0718-192A-2B3C4D5E6F70}'),
      'a1b2c3d4-e5f6-0718-192a-2b3c4d5e6f70',
    );
    assert.equal(normalizeGuid('xbox controller'), null);

    // Sem GUID do SO → gera GUID derivado e aceita o vínculo.
    const semGuid = service.saveProfile({
      playerIndex: 1,
      name: 'Sem GUID',
      api: 'xinput',
      hardwareGuid: null,
      productName: 'Generic USB Gamepad',
    });
    assert.equal(semGuid.playerIndex, 1);
    assert.match(
      semGuid.hardwareGuid,
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // Mesmo controle físico em outro slot → continua sendo o mesmo GUID.
    assert.throws(
      () =>
        service.saveProfile({
          playerIndex: 2,
          name: 'Sem GUID',
          api: 'xinput',
          hardwareGuid: null,
          productName: 'Generic USB Gamepad',
        }),
      (error) => error.code === 'CONTROLLER_ALREADY_BOUND',
    );

    // GUID real do SO continua sendo respeitado.
    const profile = service.saveProfile({
      playerIndex: 2,
      name: 'Xbox Series',
      api: 'xinput',
      hardwareGuid: '{A1B2C3D4-E5F6-0718-192A-2B3C4D5E6F70}',
      productName: 'Xbox Wireless Controller',
    });
    assert.equal(profile.api, 'xinput');
    assert.equal(profile.mapping.south, 'A');

    assert.throws(
      () =>
        service.saveProfile({
          playerIndex: 3,
          name: 'Duplicado',
          api: 'xinput',
          hardwareGuid: 'a1b2c3d4-e5f6-0718-192a-2b3c4d5e6f70',
        }),
      (error) => error.code === 'CONTROLLER_ALREADY_BOUND',
    );

    const keyboard = service.saveProfile({
      playerIndex: 3,
      name: 'Teclado',
      api: 'keyboard',
      hardwareGuid: null,
    });
    assert.equal(keyboard.hardwareGuid, KEYBOARD_GUID);
    assert.equal(keyboard.mapping.up, 'KeyW');

    const mapped = service.setMapping(profile.id, { south: 'Space', start: 'Enter' });
    assert.equal(mapped.mapping.south, 'Space');
  } finally {
    env.db.close();
    require('node:fs').rmSync(env.root, { recursive: true, force: true });
  }
});

test('diagnóstico marca todo controle como vinculável automaticamente', () => {
  const env = createTestEnvironment();
  const service = new ControllerService({ db: env.db, logger: silentLogger });
  try {
    const result = service.inspectDetected(
      [
        {
          index: 0,
          id: 'Xbox Controller',
          mapping: 'standard',
          connected: true,
          buttons: 17,
          axes: 4,
          hardwareGuid: null, // sem GUID do SO
        },
        {
          index: 1,
          id: 'DualShock',
          mapping: '',
          connected: true,
          buttons: 18,
          axes: 4,
          hardwareGuid: '11111111-2222-3333-4444-555555555555',
        },
      ],
      'ps2',
    );
    assert.equal(result.maxPlayers, 2);
    // Antes (v1): false quando hardwareGuid era null.
    // Agora (v2): qualquer controle ganha GUID derivado → bindable.
    assert.equal(result.devices[0].bindable, true);
    assert.ok(result.devices[0].hardwareGuid);
    assert.equal(result.devices[0].productName, 'Xbox Controller');
    assert.equal(result.devices[1].bindable, true);
  } finally {
    env.db.close();
    require('node:fs').rmSync(env.root, { recursive: true, force: true });
  }
});
