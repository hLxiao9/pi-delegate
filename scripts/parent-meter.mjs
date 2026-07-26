#!/usr/bin/env node
/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import path from 'node:path';
import { writeJsonAtomic } from '../lib/atomic-json.mjs';
import { WorkerError, serializeError } from '../lib/errors.mjs';
import { snapshotParentUsage } from '../lib/parent-usage.mjs';

try {
  const [flag, output] = process.argv.slice(2);
  if (flag !== '--output' || !output || !path.isAbsolute(output)) {
    throw new WorkerError('CLI_USAGE', 'Usage: parent-meter --output <absolute-json-path>\n\nReads PARENT_AGENT (codex|claude-code|trae|cursor|cli) and PARENT_THREAD_ID / CODEX_THREAD_ID to snapshot the parent agent usage.', {}, 2);
  }
  const snapshot = await snapshotParentUsage({ home: process.env.HOME, env: process.env });
  await writeJsonAtomic(output, snapshot);
  process.stdout.write(`${JSON.stringify({ ok: true, output, available: snapshot.available, backend: snapshot.backend ?? null })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify(serializeError(error))}\n`);
  process.exitCode = error instanceof WorkerError ? error.exitCode : 1;
}
