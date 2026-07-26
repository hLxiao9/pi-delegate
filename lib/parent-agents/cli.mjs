/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

export const name = 'cli';

export async function snapshotUsage({ threadId } = {}) {
  return {
    available: false,
    backend: name,
    reason: 'cli invocation has no parent-agent session to meter',
    threadId: threadId ?? null,
    at: new Date().toISOString(),
  };
}
