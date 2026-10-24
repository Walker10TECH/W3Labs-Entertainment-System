'use strict';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Janela deslizante com espaçamento mínimo. Serializa a saída para nunca
 * exceder N requisições em 60 s, mesmo com chamadas concorrentes.
 */
class RateLimiter {
  constructor({
    maxRequests = 50,
    windowMs = 60_000,
    minIntervalMs = Math.ceil(windowMs / maxRequests),
    now = Date.now,
    sleep = defaultSleep,
  } = {}) {
    if (!Number.isInteger(maxRequests) || maxRequests <= 0) {
      throw new TypeError('maxRequests deve ser um inteiro positivo.');
    }
    if (!Number.isInteger(windowMs) || windowMs <= 0) {
      throw new TypeError('windowMs deve ser um inteiro positivo.');
    }
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.minIntervalMs = Math.max(0, minIntervalMs);
    this.now = now;
    this.sleep = sleep;
    this.timestamps = [];
    this.queue = [];
    this.processing = false;
    this.destroyed = false;
  }

  acquire() {
    if (this.destroyed) {
      return Promise.reject(Object.assign(new Error('Rate limiter encerrado.'), { code: 'LIMITER_CLOSED' }));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      void this.#drain();
    });
  }

  async run(task) {
    await this.acquire();
    return task();
  }

  async #drain() {
    if (this.processing || this.destroyed) return;
    this.processing = true;
    try {
      while (this.queue.length > 0 && !this.destroyed) {
        const now = this.now();
        this.timestamps = this.timestamps.filter((ts) => now - ts < this.windowMs);

        let waitMs = 0;
        if (this.timestamps.length >= this.maxRequests) {
          waitMs = this.timestamps[0] + this.windowMs - now + 1;
        } else if (this.timestamps.length > 0 && this.minIntervalMs > 0) {
          const last = this.timestamps[this.timestamps.length - 1];
          waitMs = Math.max(0, last + this.minIntervalMs - now);
        }

        if (waitMs > 0) {
          await this.sleep(waitMs);
          continue;
        }

        const next = this.queue.shift();
        const startedAt = this.now();
        this.timestamps.push(startedAt);
        next.resolve({
          startedAt,
          remaining: Math.max(0, this.maxRequests - this.timestamps.length),
        });
      }
    } finally {
      this.processing = false;
      if (this.queue.length > 0 && !this.destroyed) setImmediate(() => void this.#drain());
    }
  }

  get pending() {
    return this.queue.length;
  }

  destroy(reason = 'Rate limiter encerrado.') {
    this.destroyed = true;
    const error = Object.assign(new Error(reason), { code: 'LIMITER_CLOSED' });
    while (this.queue.length > 0) this.queue.shift().reject(error);
  }
}

module.exports = { RateLimiter };
