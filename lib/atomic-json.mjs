/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(directory) {
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function writeTextAtomic(file, text, mode = 0o600) {
  await ensureDir(path.dirname(file));
  // adds random suffix to avoid temp filename collisions from same-millisecond concurrency
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  try {
  await writeFile(temporary, text, { mode });
  await rename(temporary, file);
  } catch (error) {
  // cleans up temp files on failure,avoids orphan file accumulation
  await unlink(temporary).catch(() => {});
  throw error;
  }
}

export async function writeJsonAtomic(file, value) {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function appendJsonLine(file, value) {
  await ensureDir(path.dirname(file));
  await appendFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
