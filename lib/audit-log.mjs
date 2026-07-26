/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolveWorkerPaths } from './config.mjs';

// global audit log:records all CLI command invocations,for debugging skill bug and optimization skill itself.
// log file located at paths.stateRoot/audit.jsonl,one per line JSON object.
// concurrency-safe:use appendFileSync(mode 0o600)atomic append.

function resolveAuditLogPath(paths = resolveWorkerPaths()) {
  return path.join(paths.stateRoot, 'audit.jsonl');
}

export function appendAuditLog(paths, entry) {
  const logPath = resolveAuditLogPath(paths);
  try {
  mkdirSync(path.dirname(logPath), { recursive: true });
  const record = entry && typeof entry === 'object' && !Array.isArray(entry)
  ? { at: new Date().toISOString(), ...entry }
  : { at: new Date().toISOString() };
  const line = `${JSON.stringify(record)}\n`;
  appendFileSync(logPath, line, { mode: 0o600 });
  } catch {
  // audit log failure should not block main flow;silently discarded.
  }
}

// convenience wrapper:records the start and end of a command invocation(includes duration and result).
export async function withAuditLog(paths, { command, runId, caller, args }, fn) {
  const startedAt = Date.now();
  const baseEntry = { command, runId: runId ?? null, caller: caller ?? null, args };
  appendAuditLog(paths, { ...baseEntry, phase: 'start' });
  try {
  const result = await fn();
  appendAuditLog(paths, {
  ...baseEntry,
  phase: 'end',
  ok: true,
  durationMs: Date.now() - startedAt,
  result: result ? { status: result.status ?? null, runId: result.runId ?? null } : null,
  });
  return result;
  } catch (error) {
  appendAuditLog(paths, {
  ...baseEntry,
  phase: 'end',
  ok: false,
  durationMs: Date.now() - startedAt,
  error: {
  code: error.code ?? 'INTERNAL',
  message: error.message,
  category: error.details?.category ?? null,
  },
  });
  throw error;
  }
}

// read audit log(for dashboard / debugging).returns the latest N records.
export async function readAuditLog(paths = resolveWorkerPaths(), limit = 100) {
  const { readFile } = await import('node:fs/promises');
  const logPath = resolveAuditLogPath(paths);
  try {
  const content = await readFile(logPath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  const recent = lines.slice(-limit);
  return recent.map((line) => {
  try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  } catch (error) {
  if (error.code === 'ENOENT') return [];
  throw error;
  }
}
