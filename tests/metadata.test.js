'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { MetadataService } = require('../src/main/services/metadata-service');
const { createTestEnvironment, insertGame, silentLogger } = require('./helpers');

function createSettings() {
  return {
    get: (key) => (key === 'metadata.provider' ? 'screenscraper' : null),
    getSecret: () => null,
  };
}

function createService(env, fetchImpl) {
  return new MetadataService({
    db: env.db,
    paths: env.paths,
    settings: createSettings(),
    logger: silentLogger,
    config: {
      metadata: {
        requestsPerWindow: 50,
        windowMs: 60_000,
        cacheMinutes: 60,
        timeoutMs: 5_000,
      },
    },
    fetchImpl,
  });
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name === 'content-type' ? 'application/json' : null) },
    json: async () => payload,
  };
}

function imageResponse(bytes) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name === 'content-type' ? 'image/jpeg' : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function wikipediaPayload(title, { extract, categories, cover } = {}) {
  return {
    query: {
      pages: [
        {
          title,
          extract,
          fullurl: `https://pt.wikipedia.org/wiki/${encodeURIComponent(title)}`,
          thumbnail: cover ? { source: cover } : undefined,
          pageprops: {},
          categories: (categories ?? []).map((category) => ({ title: category })),
        },
      ],
    },
  };
}

test('escolhe artigo de jogo, baixa capa e grava procedência', async () => {
  const env = createTestEnvironment();
  const game = insertGame(env.db, { title: 'Chrono Trigger', platformId: 'nes' });
  const calls = [];
  let downloaded = false;
  const fetchImpl = async (url) => {
    const text = String(url);
    calls.push(text);
    if (text.includes('upload.wikimedia.org')) {
      downloaded = true;
      return imageResponse(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
    return jsonResponse({
      query: {
        pages: [
          {
            title: 'Chrono Trigger (filme)',
            extract: 'Chrono Trigger é um filme experimental de 1995 dirigido por um coletivo.',
            fullurl: 'https://pt.wikipedia.org/wiki/Chrono_Trigger_(filme)',
            pageprops: {},
            categories: [{ title: 'Filmes de 1995' }],
          },
          {
            title: 'Chrono Trigger',
            extract:
              'Chrono Trigger é um jogo eletrônico de RPG desenvolvido pela Square para o Super Nintendo Entertainment System, lançado em 1995.',
            fullurl: 'https://pt.wikipedia.org/wiki/Chrono_Trigger',
            thumbnail: { source: 'https://upload.wikimedia.org/wikipedia/en/chrono-trigger.jpg' },
            pageprops: {},
            categories: [{ title: 'Jogos eletrônicos de 1995' }],
          },
        ],
      },
    });
  };
  try {
    const service = createService(env, fetchImpl);
    const result = await service.wikipediaGame(game.id);
    assert.equal(result.found, true);
    assert.equal(result.article, 'Chrono Trigger');
    assert.equal(result.language, 'pt');
    assert.equal(result.coverUpdated, true);
    assert.equal(result.synopsisUpdated, true);
    assert.equal(downloaded, true);

    const row = env.db.get('SELECT * FROM games WHERE id = ?', [game.id]);
    assert.match(row.synopsis, /jogo eletrônico de RPG/);
    assert.equal(row.metadata_source, 'wikipedia');
    assert.match(row.metadata_url, /pt\.wikipedia\.org/);
    assert.ok(row.cover_file && fs.existsSync(row.cover_file));

    const afterFirst = calls.length;
    const cached = await service.wikipediaGame(game.id, { overwrite: false });
    assert.equal(cached.cached, true);
    assert.equal(calls.length, afterFirst, 'lookup em cache não deve refazer requisições');
  } finally {
    env.db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('usa Wikipédia em inglês quando o artigo em português não existe', async () => {
  const env = createTestEnvironment();
  const game = insertGame(env.db, { title: 'Rare Obscure Game', platformId: 'ps1' });
  const fetchImpl = async (url) => {
    if (String(url).includes('upload.wikimedia.org')) {
      return imageResponse(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
    if (String(url).includes('pt.wikipedia.org')) return jsonResponse({ query: { pages: [] } });
    return jsonResponse(
      wikipediaPayload('Rare Obscure Game', {
        extract:
          'Rare Obscure Game is a video game developed for the PlayStation and released in 1998 by an independent studio.',
        categories: ['Video games developed in Japan', 'PlayStation games'],
        cover: 'https://upload.wikimedia.org/wikipedia/en/rare.jpg',
      }),
    );
  };
  try {
    const service = createService(env, fetchImpl);
    const result = await service.wikipediaGame(game.id);
    assert.equal(result.found, true);
    assert.equal(result.language, 'en');
    assert.equal(result.coverUpdated, true);
  } finally {
    env.db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('ignora capa de domínio não permitido e mantém a sinopse', async () => {
  const env = createTestEnvironment();
  const game = insertGame(env.db, { title: 'Safe Cover Test', platformId: 'gb' });
  const fetchImpl = async (url) => {
    assert.ok(!String(url).includes('evil.example'), 'host não permitido não pode ser buscado');
    return jsonResponse(
      wikipediaPayload('Safe Cover Test', {
        extract: 'Safe Cover Test é um jogo eletrônico de plataforma lançado para o Game Boy em 1996.',
        categories: ['Jogos eletrônicos de 1996'],
        cover: 'https://evil.example/cover.jpg',
      }),
    );
  };
  try {
    const service = createService(env, fetchImpl);
    const result = await service.wikipediaGame(game.id);
    assert.equal(result.found, true);
    assert.equal(result.coverUpdated, false);
    const row = env.db.get('SELECT * FROM games WHERE id = ?', [game.id]);
    assert.match(row.synopsis, /Game Boy/);
    assert.equal(row.cover_file, null);
  } finally {
    env.db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('enriquecimento em lote considera apenas jogos sem capa ou sinopse', async () => {
  const env = createTestEnvironment();
  const missing = insertGame(env.db, { title: 'Missing Data Game', platformId: 'nes' });
  const complete = insertGame(env.db, { title: 'Complete Game', platformId: 'nes' });
  env.db.run('UPDATE games SET synopsis = ?, cover_file = ? WHERE id = ?', [
    'Sinopse já existente.',
    'C:/covers/complete.jpg',
    complete.id,
  ]);
  const fetchImpl = async () =>
    jsonResponse(
      wikipediaPayload('Missing Data Game', {
        extract: 'Missing Data Game é um jogo eletrônico de ação desenvolvido para o NES e lançado em 1990.',
        categories: ['Jogos eletrônicos de 1990'],
      }),
    );
  try {
    const service = createService(env, fetchImpl);
    const progress = [];
    const summary = await service.wikipediaBulk({
      limit: 10,
      onProgress: (event) => progress.push(event),
    });
    assert.equal(summary.processed, 1);
    assert.equal(summary.enriched, 1);
    assert.equal(progress.at(-1).phase, 'done');
    const row = env.db.get('SELECT synopsis FROM games WHERE id = ?', [missing.id]);
    assert.match(row.synopsis, /jogo eletrônico de ação/);
    assert.equal(
      env.db.get('SELECT synopsis FROM games WHERE id = ?', [complete.id]).synopsis,
      'Sinopse já existente.',
    );
  } finally {
    env.db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});
