/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { snapshotUsage as snapshotCodexBackend } from './parent-agents/codex.mjs';
import { usageDelta as parentUsageDelta } from './parent-usage.mjs';

export async function snapshotCodexUsage({ home, threadId = process.env.CODEX_THREAD_ID } = {}) {
  return snapshotCodexBackend({ home, threadId });
}

export const usageDelta = parentUsageDelta;
