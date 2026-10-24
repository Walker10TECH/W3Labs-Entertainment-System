'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { HardwareService, isHardwareDevice } = require('../src/main/services/hardware-service');
const { silentLogger } = require('./helpers');

const amdAndBasic = {
  gpuDevice: [
    {
      active: false,
      deviceId: 28639,
      deviceString: 'AMD Radeon RX590 GME',
      driverVersion: '31.0.21925.1001',
      vendorId: 4098,
    },
    {
      active: false,
      deviceId: 140,
      deviceString: 'Microsoft Basic Render Driver',
      driverVersion: '10.0.26100.9711',
      vendorId: 5140,
    },
  ],
};

const basicOnly = {
  gpuDevice: [
    {
      active: false,
      deviceId: 140,
      deviceString: 'Microsoft Basic Render Driver',
      vendorId: 5140,
    },
  ],
};

test('não trata o fallback Microsoft Basic Render como renderização por software quando há GPU AMD', async () => {
  const service = new HardwareService({
    getGpuInfo: async () => amdAndBasic,
    logger: silentLogger,
  });
  const info = await service.info();
  assert.equal(info.dedicatedGpu, true);
  assert.equal(info.softwareRendering, false);
  assert.equal(info.softwareFallbackPresent, true);
  assert.equal(info.gpuName, 'AMD Radeon RX590 GME');
  assert.equal(isHardwareDevice({ vendorId: 4098, device: 'AMD Radeon RX590 GME' }), true);

  const assessment = await service.assess('ps2');
  assert.equal(assessment.info.dedicatedGpu, true);
  assert.ok(!assessment.warnings.some((warning) => /GPU dedicada|software/i.test(warning)));
});

test('mantém o aviso quando só existe o renderizador de software', async () => {
  const service = new HardwareService({
    getGpuInfo: async () => basicOnly,
    logger: silentLogger,
  });
  const assessment = await service.assess('ps2');
  assert.equal(assessment.requiresWarning, true);
  assert.ok(assessment.warnings.some((warning) => /GPU dedicada/.test(warning)));
  assert.ok(assessment.warnings.some((warning) => /software/.test(warning)));
});
