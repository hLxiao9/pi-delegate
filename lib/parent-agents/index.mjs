import * as codex from './codex.mjs';
import * as claudeCode from './claude-code.mjs';
import * as trae from './trae.mjs';
import * as cursor from './cursor.mjs';
import * as cli from './cli.mjs';

const BACKENDS = {
  codex,
  'claude-code': claudeCode,
  trae,
  cursor,
  cli,
};

const DEFAULT_BACKEND = 'codex';

export function selectBackend(env = process.env) {
  const raw = env.PARENT_AGENT ?? env.PI_WORKER_CALLER ?? DEFAULT_BACKEND;
  const lower = typeof raw === 'string' ? raw.toLowerCase().trim() : '';
  return BACKENDS[lower] ?? cli;
}

export function listBackends() {
  return Object.keys(BACKENDS);
}
