#!/usr/bin/env node
// Deprecated alias for parent-meter.mjs.
// Kept for backward compatibility with existing Codex workflows that call `codex-meter`.
// Reads CODEX_THREAD_ID (or PARENT_THREAD_ID) and snapshots Codex (or other configured parent) usage.
import path from 'node:path';
import { writeJsonAtomic } from '../lib/atomic-json.mjs';
import { snapshotCodexUsage } from '../lib/codex-usage.mjs';
import { snapshotParentUsage } from '../lib/parent-usage.mjs';
import { WorkerError, serializeError } from '../lib/errors.mjs';

try {
  const [flag, output] = process.argv.slice(2);
  if (flag !== '--output' || !output || !path.isAbsolute(output)) {
    throw new WorkerError('CLI_USAGE', 'Usage: codex-meter --output <absolute-json-path> (deprecated alias for parent-meter)', {}, 2);
  }
  // If PARENT_AGENT is set to a non-codex backend, honor it; otherwise use the legacy Codex snapshot.
  const parentAgent = process.env.PARENT_AGENT ?? process.env.PI_WORKER_CALLER ?? '';
  const snapshot = parentAgent && parentAgent.toLowerCase() !== 'codex'
    ? await snapshotParentUsage({ home: process.env.HOME, env: process.env })
    : await snapshotCodexUsage({ home: process.env.HOME, threadId: process.env.PARENT_THREAD_ID ?? process.env.CODEX_THREAD_ID });
  await writeJsonAtomic(output, snapshot);
  process.stdout.write(`${JSON.stringify({ ok: true, output, available: snapshot.available, backend: snapshot.backend ?? 'codex' })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify(serializeError(error))}\n`);
  process.exitCode = error instanceof WorkerError ? error.exitCode : 1;
}
