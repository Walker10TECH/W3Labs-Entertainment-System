'use strict';

const os = require('node:os');
const { getPlatform } = require('../../../config/platforms');

const SOFTWARE_GPU = /swiftshader|llvmpipe|software|basic render|microsoft basic|remote display/i;
const DEDICATED_GPU = /nvidia|geforce|radeon|amd|intel arc|arc\(tm\)/i;
const SOFTWARE_VENDOR_IDS = new Set([0x1414, 5140]); // Microsoft Basic Render / WARP
const HARDWARE_VENDOR_IDS = new Set([
  0x10de, // NVIDIA
  0x1002, // AMD
  0x1022, // AMD
  0x8086, // Intel
]);

function numericVendorId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!text) return null;
  const parsed = text.startsWith('0x') ? Number.parseInt(text, 16) : Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSoftwareDevice(device) {
  const vendorId = numericVendorId(device.vendorId);
  return (
    SOFTWARE_VENDOR_IDS.has(vendorId) ||
    SOFTWARE_GPU.test(`${device.vendor ?? ''} ${device.device ?? ''}`.trim())
  );
}

function isHardwareDevice(device) {
  if (isSoftwareDevice(device)) return false;
  const vendorId = numericVendorId(device.vendorId);
  return (
    HARDWARE_VENDOR_IDS.has(vendorId) || DEDICATED_GPU.test(`${device.vendor ?? ''} ${device.device ?? ''}`)
  );
}

class HardwareService {
  constructor({ getGpuInfo, logger }) {
    this.getGpuInfo = getGpuInfo;
    this.logger = logger;
    this.cached = null;
    this.cachedAt = 0;
  }

  async info() {
    if (this.cached && Date.now() - this.cachedAt < 60_000) return this.cached;
    let gpu = { devices: [], raw: null };
    try {
      const info = await this.getGpuInfo('basic');
      const devices = Array.isArray(info?.gpuDevice)
        ? info.gpuDevice.map((device) => ({
            vendorId: device.vendorId ?? null,
            deviceId: device.deviceId ?? null,
            vendor: device.driverVendor ?? device.vendorString ?? '',
            device: device.deviceString ?? '',
            active: Boolean(device.active),
          }))
        : [];
      gpu = { devices, raw: info };
    } catch (error) {
      this.logger?.warn('hardware', 'Não foi possível consultar a GPU.', { error: error.message });
    }

    const hardwareDevices = gpu.devices.filter(isHardwareDevice);
    const softwareDevices = gpu.devices.filter(isSoftwareDevice);
    const dedicated = hardwareDevices.some((device) => {
      const name = `${device.vendor} ${device.device}`;
      return DEDICATED_GPU.test(name) || HARDWARE_VENDOR_IDS.has(numericVendorId(device.vendorId));
    });
    // O Windows pode expor "Microsoft Basic Render Driver" ao lado da GPU real.
    // Isso não significa que o jogo rodará por software: só sinalizamos quando
    // não existe nenhum dispositivo de hardware identificado.
    const softwareRendering = hardwareDevices.length === 0 && softwareDevices.length > 0;
    const totalRamGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;

    this.cached = {
      gpu: gpu.devices,
      hardwareGpu: dedicated,
      dedicatedGpu: dedicated,
      softwareRendering,
      softwareFallbackPresent: softwareDevices.length > 0,
      gpuName: hardwareDevices[0] ? hardwareDevices[0].device || hardwareDevices[0].vendor : null,
      totalRamGb,
      cpu: os.cpus()?.[0]?.model ?? 'Desconhecido',
      platform: process.platform,
      arch: process.arch,
    };
    this.logger?.info('hardware', 'Diagnóstico de GPU.', {
      gpu: this.cached.gpuName,
      dedicated: this.cached.dedicatedGpu,
      softwareRendering: this.cached.softwareRendering,
      softwareFallbackPresent: this.cached.softwareFallbackPresent,
      devices: this.cached.gpu.map((device) => ({
        vendorId: device.vendorId,
        device: device.device,
      })),
    });
    this.cachedAt = Date.now();
    return this.cached;
  }

  async assess(platformId) {
    const platform = getPlatform(platformId);
    if (!platform.hardwareWarning) {
      return {
        platformId,
        requiresWarning: false,
        canProceed: true,
        warnings: [],
        info: await this.info(),
      };
    }
    const info = await this.info();
    const warnings = [];
    if (!info.dedicatedGpu) {
      warnings.push(
        'Nenhuma GPU dedicada foi identificada. O desempenho pode ficar abaixo do necessário; você pode continuar por sua conta e risco.',
      );
    }
    if (info.softwareRendering) {
      warnings.push('Renderização por software detectada. Vulkan/DirectX 12 podem não estar disponíveis.');
    }
    if (info.totalRamGb < 8) {
      warnings.push(`Memória RAM total de ${info.totalRamGb} GB; recomendamos ao menos 8 GB.`);
    }
    return {
      platformId,
      platformName: platform.shortName,
      requiresWarning: warnings.length > 0,
      canProceed: true,
      warnings,
      info,
    };
  }
}

module.exports = { HardwareService, isHardwareDevice, isSoftwareDevice, numericVendorId };
