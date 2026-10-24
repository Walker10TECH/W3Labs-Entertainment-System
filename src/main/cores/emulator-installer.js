'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { AppError } = require('../lib/errors');
const { hashFile } = require('../lib/hash');
const { assertInside } = require('../lib/paths');

const execFileAsync = promisify(execFile);
const USER_AGENT = 'W3Labs-Entertainment-System/1.0';
const GITHUB_API = 'https://api.github.com';

const AUTO_CORES = Object.freeze({
  duckstation: {
    coreId: 'duckstation',
    label: 'DuckStation',
    repo: 'stenzek/duckstation',
    site: 'https://www.duckstation.org/',
    asset: /duckstation-windows-x64-release\.zip$/i,
    executables: [
      'duckstation-qt-x64-ReleaseLTCG.exe',
      'duckstation-qt.exe',
      'duckstation-qt-x64-Release.exe',
    ],
    platforms: ['ps1'],
  },
  pcsx2: {
    coreId: 'pcsx2',
    label: 'PCSX2',
    repo: 'PCSX2/pcsx2',
    site: 'https://pcsx2.net/downloads/',
    asset: /windows-x64-Qt\.7z$/i,
    executables: ['pcsx2-qt.exe'],
    platforms: ['ps2'],
  },
  rpcs3: {
    coreId: 'rpcs3',
    label: 'RPCS3',
    repo: 'RPCS3/rpcs3-binaries-win',
    site: 'https://rpcs3.net/download',
    asset: /win64_msvc\.7z$/i,
    executables: ['rpcs3.exe'],
    platforms: ['ps3'],
  },
  xemu: {
    coreId: 'xemu',
    label: 'xemu',
    repo: 'xemu-project/xemu',
    site: 'https://xemu.app/download/',
    asset: /xemu-win-x86_64-release\.zip$/i,
    executables: ['xemu.exe'],
    platforms: ['xbox'],
  },
  xenia: {
    coreId: 'xenia',
    label: 'Xenia Canary',
    repo: 'xenia-canary/xenia-canary',
    site: 'https://xenia.jp/download/',
    asset: /xenia_canary_windows\.7z$/i,
    executables: ['xenia_canary.exe', 'xenia.exe'],
    platforms: ['xbox360'],
  },
});

function chooseAsset(assets, pattern) {
  return (Array.isArray(assets) ? assets : []).find(
    (asset) => pattern.test(asset.name) && !/symbols|pdb|debug/i.test(asset.name),
  );
}

function safeArchiveEntry(entry) {
  const value = String(entry).replace(/\\/g, '/').trim();
  if (!value) return true;
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return false;
  return !value.split('/').includes('..');
}

async function findExecutable(root, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.shift();
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(fullPath);
      else if (entry.isFile() && wanted.has(entry.name.toLowerCase())) return fullPath;
    }
  }
  return null;
}

class EmulatorInstaller extends EventEmitter {
  constructor({ managedRoot, cacheDir, logger, fetchImpl = globalThis.fetch, tarPath = null }) {
    super();
    this.managedRoot = path.resolve(managedRoot);
    this.cacheDir = path.resolve(cacheDir);
    this.downloadDir = path.join(this.cacheDir, 'downloads');
    this.logger = logger;
    this.fetch = fetchImpl;
    this.tarPath =
      tarPath ||
      (process.platform === 'win32' &&
      fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'))
        ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar');
    this.releaseCache = new Map();
    this.jobs = new Map();
    fs.mkdirSync(this.managedRoot, { recursive: true });
    fs.mkdirSync(this.downloadDir, { recursive: true });
  }

  getSourceUrl(coreId) {
    const spec = AUTO_CORES[coreId];
    return spec ? spec.site : null;
  }

  getReleasePage(coreId) {
    const spec = AUTO_CORES[coreId];
    return spec ? `https://github.com/${spec.repo}/releases` : null;
  }

  status(coreId) {
    const spec = AUTO_CORES[coreId];
    if (!spec) throw new AppError('CORE_INSTALL_UNKNOWN', 'Núcleo sem instalador automático.');
    const manifestPath = path.join(this.managedRoot, spec.coreId, 'manifest.json');
    let manifest = null;
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch {
        manifest = null;
      }
    }
    const executable = manifest ? path.join(this.managedRoot, spec.coreId, manifest.executable) : null;
    const installed = Boolean(executable && fs.existsSync(executable));
    return {
      coreId: spec.coreId,
      label: spec.label,
      platforms: spec.platforms,
      repo: spec.repo,
      site: spec.site,
      releasePage: this.getReleasePage(spec.coreId),
      installed,
      managed: installed,
      version: installed ? manifest.version : null,
      executable: installed ? executable : null,
      installedAt: installed ? manifest.installedAt : null,
    };
  }

  catalog() {
    return Object.keys(AUTO_CORES).map((coreId) => this.status(coreId));
  }

  async install(coreId) {
    const spec = AUTO_CORES[coreId];
    if (!spec) throw new AppError('CORE_INSTALL_UNKNOWN', 'Núcleo sem instalador automático.');
    if (this.jobs.has(coreId)) return this.jobs.get(coreId);
    const job = this.#install(spec).finally(() => this.jobs.delete(coreId));
    this.jobs.set(coreId, job);
    return job;
  }

  async #install(spec) {
    if (process.platform !== 'win32') {
      throw new AppError(
        'CORE_INSTALL_PLATFORM_UNSUPPORTED',
        'A instalação automática está disponível apenas no Windows nesta versão.',
      );
    }
    this.emitProgress(spec.coreId, { phase: 'release', percent: 0 });
    const release = await this.#latestRelease(spec.repo);
    const asset = chooseAsset(release.assets, spec.asset);
    if (!asset) {
      throw new AppError(
        'CORE_INSTALL_ASSET_NOT_FOUND',
        `Nenhum pacote Windows compatível foi encontrado na release ${release.tag_name} do ${spec.label}.`,
      );
    }

    const current = this.status(spec.coreId);
    if (current.installed && current.version === release.tag_name) {
      this.emitProgress(spec.coreId, { phase: 'done', percent: 100, upToDate: true });
      return { ...current, upToDate: true };
    }

    const archivePath = path.join(this.downloadDir, `${spec.coreId}-${release.tag_name}-${asset.name}`);
    const checksum = await this.#downloadAsset(spec, asset, archivePath);
    const staging = path.join(this.managedRoot, `.staging-${spec.coreId}-${crypto.randomUUID()}`);
    let backup = null;
    try {
      await this.#verifyArchive(archivePath);
      this.emitProgress(spec.coreId, { phase: 'extract', percent: 0 });
      fs.mkdirSync(staging, { recursive: true });
      await execFileAsync(this.tarPath, ['-xf', archivePath, '-C', staging], {
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
      const executable = await findExecutable(staging, spec.executables);
      if (!executable) {
        throw new AppError(
          'CORE_INSTALL_EXECUTABLE_NOT_FOUND',
          `O pacote do ${spec.label} não contém ${spec.executables.join(' ou ')}.`,
        );
      }

      const relativeExecutable = path.relative(staging, executable);
      const manifest = {
        coreId: spec.coreId,
        label: spec.label,
        version: release.tag_name,
        asset: asset.name,
        executable: relativeExecutable,
        sha256: checksum,
        source: release.html_url,
        installedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

      const destination = path.join(this.managedRoot, spec.coreId);
      assertInside(this.managedRoot, destination, 'núcleo');
      if (fs.existsSync(destination)) {
        backup = path.join(this.managedRoot, `.backup-${spec.coreId}-${crypto.randomUUID()}`);
        await fs.promises.rename(destination, backup);
      }
      try {
        await fs.promises.rename(staging, destination);
      } catch (error) {
        if (backup && fs.existsSync(backup)) {
          await fs.promises.rename(backup, destination).catch(() => {});
        }
        throw error;
      }
      if (backup) await fs.promises.rm(backup, { recursive: true, force: true });
      await fs.promises.rm(archivePath, { force: true }).catch(() => {});

      const installed = this.status(spec.coreId);
      this.logger?.info('cores', 'Núcleo instalado automaticamente.', {
        coreId: spec.coreId,
        version: release.tag_name,
        source: release.html_url,
      });
      this.emitProgress(spec.coreId, {
        phase: 'done',
        percent: 100,
        version: release.tag_name,
      });
      return { ...installed, upToDate: false };
    } finally {
      await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
      if (backup && fs.existsSync(backup) && !fs.existsSync(path.join(this.managedRoot, spec.coreId))) {
        await fs.promises.rename(backup, path.join(this.managedRoot, spec.coreId)).catch(() => {});
      }
    }
  }

  async #latestRelease(repo) {
    const cached = this.releaseCache.get(repo);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.release;
    let response;
    try {
      response = await this.fetch(`${GITHUB_API}/repos/${repo}/releases/latest`, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': USER_AGENT,
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new AppError('CORE_INSTALL_OFFLINE', 'Não foi possível consultar a release oficial.', {
        reason: error.message,
      });
    }
    if (!response.ok) {
      throw new AppError(
        'CORE_INSTALL_RELEASE_ERROR',
        `GitHub respondeu HTTP ${response.status} ao consultar ${repo}.`,
      );
    }
    const release = await response.json();
    if (!release?.tag_name || !Array.isArray(release.assets)) {
      throw new AppError('CORE_INSTALL_RELEASE_INVALID', 'Release oficial inválida.');
    }
    this.releaseCache.set(repo, { release, at: Date.now() });
    return release;
  }

  async #downloadAsset(spec, asset, archivePath) {
    if (fs.existsSync(archivePath) && fs.statSync(archivePath).size === asset.size) {
      this.emitProgress(spec.coreId, { phase: 'verify', percent: 100, cached: true });
    } else {
      this.emitProgress(spec.coreId, {
        phase: 'download',
        percent: 0,
        receivedBytes: 0,
        totalBytes: asset.size,
      });
      let response;
      try {
        response = await this.fetch(asset.browser_download_url, {
          headers: { 'user-agent': USER_AGENT },
          redirect: 'follow',
          signal: AbortSignal.timeout(10 * 60_000),
        });
      } catch (error) {
        throw new AppError('CORE_INSTALL_DOWNLOAD_FAILED', 'Falha ao baixar o emulador.', {
          reason: error.message,
        });
      }
      if (!response.ok || !response.body) {
        throw new AppError(
          'CORE_INSTALL_DOWNLOAD_FAILED',
          `Download oficial respondeu HTTP ${response.status}.`,
        );
      }
      const total = Number(response.headers.get('content-length')) || asset.size || 0;
      const partial = `${archivePath}.part`;
      let received = 0;
      let lastEmit = 0;
      const tracker = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          if (Date.now() - lastEmit > 180) {
            lastEmit = Date.now();
            this.push(chunk);
            this.emit('progress', { received, total });
          } else {
            this.push(chunk);
          }
          callback();
        },
      });
      tracker.on('progress', ({ received: bytes, total: totalBytes }) => {
        this.emitProgress(spec.coreId, {
          phase: 'download',
          percent: totalBytes ? Math.min(99, Math.round((bytes / totalBytes) * 100)) : 0,
          receivedBytes: bytes,
          totalBytes,
        });
      });
      await pipeline(Readable.fromWeb(response.body), tracker, fs.createWriteStream(partial));
      await fs.promises.rename(partial, archivePath);
      this.emitProgress(spec.coreId, {
        phase: 'download',
        percent: 100,
        receivedBytes: received,
        totalBytes: total || received,
      });
    }

    this.emitProgress(spec.coreId, { phase: 'verify', percent: 0 });
    let expected = null;
    if (asset.digest?.startsWith('sha256:')) expected = asset.digest.slice(7).toLowerCase();
    if (!expected) expected = await this.#sidecarChecksum(spec, asset);
    const actual = (await hashFile(archivePath, { algorithms: ['sha256'] })).sha256;
    if (expected && expected !== actual) {
      await fs.promises.rm(archivePath, { force: true }).catch(() => {});
      throw new AppError('CORE_INSTALL_CHECKSUM_MISMATCH', 'O SHA-256 do download não confere.');
    }
    if (!expected) {
      this.logger?.warn('cores', 'Release sem checksum publicado; hash calculado localmente.', {
        coreId: spec.coreId,
        asset: asset.name,
        sha256: actual,
      });
    }
    this.emitProgress(spec.coreId, { phase: 'verify', percent: 100 });
    return actual;
  }

  async #sidecarChecksum(spec, asset) {
    try {
      const release = this.releaseCache.get(spec.repo)?.release;
      const checksumAsset = release?.assets?.find(
        (entry) => entry.name === `${asset.name}.sha256` || entry.name === `${asset.name}.sha256sum`,
      );
      if (!checksumAsset) return null;
      const response = await this.fetch(checksumAsset.browser_download_url, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return null;
      const text = await response.text();
      const match = text.match(/[a-f0-9]{64}/i);
      return match ? match[0].toLowerCase() : null;
    } catch {
      return null;
    }
  }

  async #verifyArchive(archivePath) {
    let stdout;
    try {
      ({ stdout } = await execFileAsync(this.tarPath, ['-tf', archivePath], {
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch (error) {
      throw new AppError('CORE_INSTALL_ARCHIVE_INVALID', 'Pacote do emulador inválido.', {
        reason: error.message,
      });
    }
    for (const entry of stdout.split(/\r?\n/)) {
      if (!safeArchiveEntry(entry)) {
        throw new AppError('CORE_INSTALL_UNSAFE_ARCHIVE', 'O pacote contém caminho inseguro.');
      }
    }
  }

  emitProgress(coreId, payload) {
    this.emit('progress', {
      coreId,
      percent: payload.percent ?? 0,
      ...payload,
      at: new Date().toISOString(),
    });
  }
}

module.exports = {
  EmulatorInstaller,
  AUTO_CORES,
  chooseAsset,
  safeArchiveEntry,
  findExecutable,
};
