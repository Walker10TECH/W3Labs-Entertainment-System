'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ControllerService,
  normalizeGuid,
  KEYBOARD_GUID,
} = require('../src/main/services/controller-service');
const { createTestEnvironment, silentLogger } = require('./helpers');

test('valida GUID e rejeita vínculo físico sem identificador do SO', () => {
  const env = createTestEnvironment();
  const service = new ControllerService({ db: env.db, logger: silentLogger });
  try {
    assert.equal(
      normalizeGuid('{A1B2C3D4-E5F6-0718-192A-2B3C4D5E6F70}'),
      'a1b2c3d4-e5f6-0718-192a-2b3c4d5e6f70',
    );
    assert.equal(normalizeGuid('xbox controller'), null);

    assert.throws(
      () =>
        service.saveProfile({
          playerIndex: 1,
          name: 'Sem GUID',
          api: 'xinput',
          hardwareGuid: null,
        }),
      (error) => error.code === 'CONTROLLER_GUID_INVALID',
    );

    const profile = service.saveProfile({
      playerIndex: 1,
      name: 'Xbox Series',
      api: 'xinput',
      hardwareGuid: 'a1b2c3d4-e5f6-0718-192a-2b3c4d5e6f70',
      productName: 'Xbox Wireless Controller',
    });
    assert.equal(profile.playerIndex, 1);
    assert.equal(profile.api, 'xinput');
    assert.equal(profile.mapping.south, 'A');

    assert.throws(
      () =>
        service.saveProfile({
          playerIndex: 2,
          name: 'Duplicado',
          api: 'xinput',
          hardwareGuid: 'a1b2c3d4-e5f6-0718-192a-2b3c4d5e6f70',
        }),
      (error) => error.code === 'CONTROLLER_ALREADY_BOUND',
    );

    const keyboard = service.saveProfile({
      playerIndex: 2,
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

test('diagnóstico só marca dispositivo como vinculável se houver GUID', () => {
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
          hardwareGuid: null,
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
    assert.equal(result.devices[0].bindable, false);
    assert.equal(result.devices[1].bindable, true);
  } finally {
    env.db.close();
    require('node:fs').rmSync(env.root, { recursive: true, force: true });
  }
});
