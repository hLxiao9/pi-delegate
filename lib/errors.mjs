export class WorkerError extends Error {
  constructor(code, message, details = {}, exitCode = 1) {
    super(message);
    this.name = 'WorkerError';
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

export function invariant(condition, code, message, details = {}, exitCode = 1) {
  if (!condition) throw new WorkerError(code, message, details, exitCode);
}

export function serializeError(error) {
  const workerError = error instanceof WorkerError
    ? error
    : new WorkerError('INTERNAL', error instanceof Error ? error.message : String(error));
  return {
    ok: false,
    error: {
      code: workerError.code,
      message: workerError.message,
      details: workerError.details,
    },
  };
}
