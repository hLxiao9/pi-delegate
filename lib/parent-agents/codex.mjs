/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export const name = 'codex';

async function findSessionFiles(directory, threadId, matches = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return matches;
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await findSessionFiles(absolute, threadId, matches);
    else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) matches.push(absolute);
  }
  return matches;
}

export async function snapshotUsage({ home = os.homedir(), threadId } = {}) {
  if (!threadId) return { available: false, reason: 'CODEX_THREAD_ID is unavailable', at: new Date().toISOString() };
  const files = await findSessionFiles(path.join(home, '.codex', 'sessions'), threadId);
  if (files.length !== 1) return { available: false, reason: `Expected one Codex session for ${threadId}; found ${files.length}`, threadId, at: new Date().toISOString() };
  let usage = null;
  const lines = readline.createInterface({ input: createReadStream(files[0], { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const event = JSON.parse(line);
      const total = event.type === 'event_msg' && event.payload?.type === 'token_count'
        ? event.payload.info?.total_token_usage
        : null;
      if (total) usage = total;
    } catch {}
  }
  if (!usage) return { available: false, reason: 'No cumulative token_count event exists', threadId, sessionFile: files[0], at: new Date().toISOString() };
  return {
    available: true,
    backend: name,
    threadId,
    sessionFile: files[0],
    inputTokens: usage.input_tokens ?? 0,
    cachedInputTokens: usage.cached_input_tokens ?? 0,
    cacheWriteInputTokens: usage.cache_write_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    reasoningOutputTokens: usage.reasoning_output_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    at: new Date().toISOString(),
  };
}
