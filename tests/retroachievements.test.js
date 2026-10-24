'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { CryptoVault } = require('../src/main/lib/crypto-vault');
const { RateLimiter } = require('../src/main/lib/rate-limiter');
const { SettingsService } = require('../src/main/services/settings-service');
const { RetroAchievementsService } = require('../src/main/services/retroachievements-service');
const { createTestEnvironment, silentLogger } = require('./helpers');

function makeService(env, fetchImpl) {
  const vault = new CryptoVault({ keyPath: path.join(env.paths.storage, 'secret.key') });
  const settings = new SettingsService({ db: env.db, defaults: {}, vault });
  const service = new RetroAchievementsService({
    settings,
    db: env.db,
    logger: silentLogger,
    fetchImpl,
    limiter: new RateLimiter({ maxRequests: 100, windowMs: 60_000, minIntervalMs: 0 }),
  });
  return { settings, service, vault };
}

const profileResponse = () =>
  new Response(
    JSON.stringify({
      User: 'PlayerOne',
      Motto: 'Test',
      TotalPoints: 120,
      TotalTruePoints: 30,
      UserPic: '/UserPic/PlayerOne.png',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

test('conecta via API, cifra chave e bloqueia Save States no Hardcore', async () => {
  const env = createTestEnvironment();
  try {
    const key = 'A'.repeat(32);
    const { settings, service } = makeService(env, async () => profileResponse());
    const connected = await service.connect({ username: 'PlayerOne', apiKey: key });
    assert.equal(connected.connected, true);
    assert.equal(connected.hardcore, false);
    const stored = env.db.get("SELECT ciphertext FROM secret_store WHERE name = 'retroachievements.apiKey'");
    assert.ok(stored.ciphertext.startsWith('v1:'));
    assert.ok(!stored.ciphertext.includes(key));

    const hardcore = await service.setHardcore(true);
    assert.equal(hardcore.hardcore, true);
    assert.equal(service.isHardcoreActive(), true);
    assert.throws(
      () => service.assertSaveStatesAllowed(),
      (error) => error.code === 'HARDCORE_LOCKED',
    );

    await service.setHardcore(false);
    assert.doesNotThrow(() => service.assertSaveStatesAllowed());
    assert.equal(settings.get('retroachievements.hardcore'), false);

    const disconnected = service.disconnect();
    assert.equal(disconnected.connected, false);
    assert.equal(disconnected.hardcore, false);
  } finally {
    env.db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('não ativa Hardcore sem conexão ativa', async () => {
  const env = createTestEnvironment();
  try {
    const { service } = makeService(env, async () => {
      throw new Error('offline');
    });
    await assert.rejects(service.setHardcore(true), (error) => error.code === 'RA_NOT_CONNECTED');

    const { service: offlineService } = makeService(env, async () => {
      throw new Error('offline');
    });
    await assert.rejects(
      offlineService.connect({ username: 'PlayerOne', apiKey: 'B'.repeat(32) }),
      (error) => error.code === 'RA_OFFLINE',
    );
  } finally {
    env.db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});
