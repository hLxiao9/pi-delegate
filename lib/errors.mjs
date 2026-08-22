/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

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

const SAFE_DIAGNOSTIC_KEYS = new Set(['causeCode', 'command', 'exitCode', 'runId', 'timedOut']);

export function redactDiagnostic(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  return Object.fromEntries(Object.entries(details).flatMap(([key, value]) => {
    if (key === 'issues' && Array.isArray(value)) {
      return [[key, value
        .filter((issue) => issue && typeof issue.code === 'string')
        .map((issue) => ({ code: issue.code, ...(issue.path ? { path: issue.path } : {}) }))]];
    }
    if (!SAFE_DIAGNOSTIC_KEYS.has(key)) return [];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [[key, value]];
    return [];
  }));
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
      details: redactDiagnostic(workerError.details),
    },
  };
}
