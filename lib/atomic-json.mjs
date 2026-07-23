import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(directory) {
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function writeJsonAtomic(file, value) {
  await ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export async function appendJsonLine(file, value) {
  await ensureDir(path.dirname(file));
  await appendFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
