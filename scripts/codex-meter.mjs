#!/usr/bin/env node
import path from 'node:path';
import { writeJsonAtomic } from '../lib/atomic-json.mjs';
import { snapshotCodexUsage } from '../lib/codex-usage.mjs';
import { WorkerError, serializeError } from '../lib/errors.mjs';

try {
  const [flag, output] = process.argv.slice(2);
  if (flag !== '--output' || !output || !path.isAbsolute(output)) {
    throw new WorkerError('CLI_USAGE', 'Usage: codex-meter --output <absolute-json-path>', {}, 2);
  }
  const snapshot = await snapshotCodexUsage({ home: process.env.HOME, threadId: process.env.CODEX_THREAD_ID });
  await writeJsonAtomic(output, snapshot);
  process.stdout.write(`${JSON.stringify({ ok: true, output, available: snapshot.available })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify(serializeError(error))}\n`);
  process.exitCode = error instanceof WorkerError ? error.exitCode : 1;
}
