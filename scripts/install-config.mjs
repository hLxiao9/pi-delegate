#!/usr/bin/env node
/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { installDefaultConfiguration } from '../lib/config.mjs';
import { serializeError } from '../lib/errors.mjs';

try {
  const result = await installDefaultConfiguration();
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify(serializeError(error))}\n`);
  process.exitCode = 1;
}
