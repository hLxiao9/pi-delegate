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

export const name = 'claude-code';

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
    else if (entry.isFile() && entry.name.endsWith('.jsonl') && (entry.name.includes(threadId) || entry.name === `${threadId}.jsonl`)) matches.push(absolute);
  }
  return matches;
}

export async function snapshotUsage({ home = os.homedir(), threadId } = {}) {
  if (!threadId) return { available: false, reason: 'PARENT_THREAD_ID is unavailable for claude-code', at: new Date().toISOString() };
  const projectsRoot = path.join(home, '.claude', 'projects');
  const files = await findSessionFiles(projectsRoot, threadId);
  if (files.length !== 1) return { available: false, reason: `Expected one claude-code session for ${threadId}; found ${files.length}`, threadId, at: new Date().toISOString() };
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
  const lines = readline.createInterface({ input: createReadStream(files[0], { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'assistant' && event.message?.usage) {
        const usage = event.message.usage;
        inputTokens += usage.input_tokens ?? 0;
        outputTokens += usage.output_tokens ?? 0;
        cacheReadTokens += usage.cache_read_input_tokens ?? 0;
        cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
      }
    } catch {}
  }
  if (inputTokens === 0 && outputTokens === 0) return { available: false, reason: 'No assistant usage events found in claude-code session', threadId, sessionFile: files[0], at: new Date().toISOString() };
  return {
    available: true,
    backend: name,
    threadId,
    sessionFile: files[0],
    inputTokens,
    cachedInputTokens: cacheReadTokens,
    cacheWriteInputTokens: cacheWriteTokens,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    at: new Date().toISOString(),
  };
}
