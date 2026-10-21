/*
 * spotworkers - Delegate bounded coding tasks to cheap agent workers
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

export const name = 'cursor';

export async function snapshotUsage({ threadId } = {}) {
  return {
    available: false,
    backend: name,
    reason: 'cursor session usage reading is not yet implemented; set PARENT_AGENT=codex or claude-code for usage tracking',
    threadId: threadId ?? null,
    at: new Date().toISOString(),
  };
}
