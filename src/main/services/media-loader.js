'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../lib/errors');
const { readHeader } = require('../lib/hash');
const { getPlatform } = require('../../../config/platforms');

const TWO_GIB = 2 * 1024 * 1024 * 1024;

/**
 * Inspeciona mídia de disco sem carregá-la na RAM. O núcleo recebe apenas o
 * caminho; streams são usados para hash e para leitura de cabeçalho.
 */
class MediaLoader {
  constructor({ logger } = {}) {
    this.logger = logger;
  }

  async inspect(game) {
    if (!game?.filePath || !game?.platformId) {
      throw new AppError('MEDIA_INVALID', 'Jogo sem caminho ou plataforma.');
    }
    const platform = getPlatform(game.platformId);
    const extension = path.extname(game.filePath).toLowerCase();
    if (!platform.extensions.includes(extension)) {
      throw new AppError(
        'MEDIA_EXTENSION_UNSUPPORTED',
        `Extensão ${extension || '(sem extensão)'} não suportada para ${platform.shortName}.`,
      );
    }

    let stat;
    try {
      stat = await fs.promises.stat(game.filePath);
    } catch {
      throw new AppError('MEDIA_NOT_FOUND', 'O arquivo de mídia não está disponível.');
    }
    if (!stat.isFile()) throw new AppError('MEDIA_NOT_FILE', 'A mídia deve ser um arquivo regular.');

    const header = await readHeader(game.filePath, 64 * 1024);
    const result = {
      path: game.filePath,
      platformId: platform.id,
      mediaType: platform.mediaType,
      extension,
      sizeBytes: stat.size,
      headerBytes: header.length,
      readStrategy: 'stream-on-disk',
      largeFile: stat.size > TWO_GIB,
      // O núcleo externo abre o arquivo diretamente; não há buffer integral.
      loadedInMemory: false,
    };
    this.logger?.debug('media', 'Mídia inspecionada em disco.', {
      path: game.filePath,
      platform: platform.id,
      size: stat.size,
      largeFile: result.largeFile,
    });
    return result;
  }

  async loadRom(romGame) {
    return this.inspect(romGame);
  }

  async loadIso(isoGame) {
    return this.inspect(isoGame);
  }

  openStream(game, options = {}) {
    const { start = 0, end = undefined, highWaterMark = 1024 * 1024 } = options;
    return fs.createReadStream(game.filePath, { start, end, highWaterMark });
  }
}

module.exports = { MediaLoader, TWO_GIB };
