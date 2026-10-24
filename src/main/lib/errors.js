'use strict';

class AppError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

function asAppError(error, fallbackCode = 'INTERNAL_ERROR') {
  if (error instanceof AppError) return error;
  const wrapped = new AppError(
    error?.code && typeof error.code === 'string' ? error.code : fallbackCode,
    error?.message || 'Erro interno inesperado.',
  );
  wrapped.cause = error;
  return wrapped;
}

function publicError(error) {
  return {
    code: error?.code || 'INTERNAL_ERROR',
    message: error?.message || 'Erro interno inesperado.',
    ...(error?.details ? { details: error.details } : {}),
  };
}

module.exports = { AppError, asAppError, publicError };
