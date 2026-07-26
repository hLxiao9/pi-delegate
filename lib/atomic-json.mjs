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
  // 加入随机后缀避免同毫秒并发的临时文件名碰撞
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  try {
    await writeFile(temporary, text, { mode });
    await rename(temporary, file);
  } catch (error) {
    // 失败时清理临时文件,避免孤儿文件积累
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
