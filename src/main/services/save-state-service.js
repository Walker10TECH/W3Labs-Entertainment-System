'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../lib/errors');

function publicState(row, activeSession = null) {
  return {
    id: row.id,
    gameId: row.game_id,
    slot: Number(row.slot),
    statePath: row.state_path,
    sizeBytes: Number(row.size_bytes),
    coreId: row.core_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    active: Boolean(activeSession && activeSession.gameId === row.game_id),
  };
}

class SaveStateService {
  constructor({ db, paths, emulation, logger }) {
    this.db = db;
    this.paths = paths;
    this.emulation = emulation;
    this.logger = logger;
  }

  setRetroAchievementsService(service) {
    this.raService = service;
  }

  list(gameId) {
    const rows = this.db.all('SELECT * FROM save_states WHERE game_id = ? ORDER BY slot, updated_at DESC', [
      gameId,
    ]);
    const active = this.emulation.active;
    return rows.map((row) => publicState(row, active));
  }

  async save(gameId, slot) {
    this.#assertHardcore();
    const context = this.#context(gameId, slot);
    this.#assertBootGuard(context.active);
    if (!context.active.capabilities.saveState) {
      throw new AppError(
        'CORE_STATE_UNSUPPORTED',
        'O núcleo em uso não expõe Save State gerenciável. Configure um bridge em cores.json.',
      );
    }
    const { directory, filePath } = context.paths;
    fs.mkdirSync(directory, { recursive: true });

    this.logger?.info('save-state', 'Gravando estado.', {
      gameId,
      slot,
      path: filePath,
      hardcore: false,
    });
    const result = await this.emulation.coreManager.request(context.active.id, 'save-state', {
      slot: context.slot,
      statePath: filePath,
    });
    // Se o Hardcore foi ativado durante a escrita, o estado é descartado.
    try {
      this.#assertHardcore();
    } catch (error) {
      fs.promises.unlink(filePath).catch(() => {});
      throw error;
    }
    if (!fs.existsSync(filePath)) {
      throw new AppError('STATE_NOT_WRITTEN', 'O núcleo não criou o arquivo de estado.');
    }
    const stat = fs.statSync(filePath);
    if (stat.size <= 0) throw new AppError('STATE_EMPTY', 'O arquivo de estado ficou vazio.');
    const existing = this.db.get('SELECT id FROM save_states WHERE game_id = ? AND slot = ?', [
      gameId,
      context.slot,
    ]);
    const id = existing?.id ?? crypto.randomUUID();
    this.db.run(
      `INSERT INTO save_states (
         id, game_id, slot, state_path, size_bytes, core_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_id, slot) DO UPDATE SET
         state_path = excluded.state_path,
         size_bytes = excluded.size_bytes,
         core_id = excluded.core_id,
         updated_at = excluded.updated_at`,
      [
        id,
        gameId,
        context.slot,
        filePath,
        stat.size,
        context.active.coreId,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    this.logger?.info('save-state', 'Estado gravado.', { gameId, slot, size: stat.size });
    return {
      slot: context.slot,
      statePath: filePath,
      sizeBytes: stat.size,
      coreId: context.active.coreId,
      coreResult: result ?? null,
    };
  }

  async load(gameId, slot) {
    this.#assertHardcore();
    const context = this.#context(gameId, slot);
    this.#assertBootGuard(context.active);
    if (!context.active.capabilities.loadState) {
      throw new AppError(
        'CORE_STATE_UNSUPPORTED',
        'O núcleo em uso não expõe Load State gerenciável. Configure um bridge em cores.json.',
      );
    }
    const row = this.db.get('SELECT * FROM save_states WHERE game_id = ? AND slot = ?', [
      gameId,
      context.slot,
    ]);
    if (!row) throw new AppError('STATE_NOT_FOUND', 'Save state não encontrado neste slot.');
    const expected = context.paths.filePath;
    if (path.resolve(row.state_path) !== path.resolve(expected)) {
      throw new AppError(
        'STATE_PATH_MISMATCH',
        'O caminho registrado não corresponde à regra de armazenamento.',
      );
    }
    this.paths.assertSavePath(expected);
    if (!fs.existsSync(expected)) {
      this.db.run('DELETE FROM save_states WHERE id = ?', [row.id]);
      throw new AppError('STATE_FILE_MISSING', 'O arquivo de estado foi removido do disco.');
    }
    await this.emulation.coreManager.request(context.active.id, 'load-state', {
      slot: context.slot,
      statePath: expected,
    });
    this.logger?.info('save-state', 'Estado carregado.', { gameId, slot });
    return { slot: context.slot, statePath: expected };
  }

  remove(gameId, slot) {
    const parsed = this.#slot(slot);
    const row = this.db.get('SELECT * FROM save_states WHERE game_id = ? AND slot = ?', [gameId, parsed]);
    if (!row) throw new AppError('STATE_NOT_FOUND', 'Save state não encontrado neste slot.');
    this.paths.assertSavePath(row.state_path);
    try {
      fs.unlinkSync(row.state_path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.db.run('DELETE FROM save_states WHERE id = ?', [row.id]);
    this.logger?.info('save-state', 'Save state excluído.', { gameId, slot: parsed });
    return { deleted: true, slot: parsed };
  }

  #context(gameId, slot) {
    const active = this.emulation.active;
    if (!active || active.gameId !== gameId) {
      throw new AppError('GAME_NOT_ACTIVE', 'O jogo precisa estar em execução para usar save states.');
    }
    const parsed = this.#slot(slot);
    const savePath = this.paths.saveStatePath(active.platformId, active.game.romHash, parsed);
    this.paths.assertSavePath(savePath.filePath);
    return { active, slot: parsed, paths: savePath };
  }

  #slot(slot) {
    const parsed = Number(slot);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 99) {
      throw new AppError('INVALID_SAVE_SLOT', 'Slot deve ser um inteiro entre 0 e 99.');
    }
    return parsed;
  }

  #assertHardcore() {
    if (this.raService?.isHardcoreActive()) {
      throw new AppError(
        'HARDCORE_LOCKED',
        'Save States estão desabilitados pelo modo Hardcore do RetroAchievements.',
      );
    }
  }

  #assertBootGuard(active) {
    const guard = this.emulation.getBootGuard(active);
    if (guard.active) {
      throw new AppError(
        'BOOT_GUARD_ACTIVE',
        `Aguarde o boot da BIOS (${guard.remainingSeconds}s restantes) antes de usar save states.`,
        guard,
      );
    }
  }
}

module.exports = { SaveStateService };
