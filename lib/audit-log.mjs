import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolveWorkerPaths } from './config.mjs';

// 全局审计日志:记录所有 CLI 命令调用,用于调试 skill bug 和优化 skill 本身。
// 日志文件位于 paths.stateRoot/audit.jsonl,每行一个 JSON 对象。
// 并发安全:使用 appendFileSync(mode 0o600)原子追加。

function resolveAuditLogPath(paths = resolveWorkerPaths()) {
  return path.join(paths.stateRoot, 'audit.jsonl');
}

export function appendAuditLog(paths, entry) {
  const logPath = resolveAuditLogPath(paths);
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    const record = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? { at: new Date().toISOString(), ...entry }
      : { at: new Date().toISOString() };
    const line = `${JSON.stringify(record)}\n`;
    appendFileSync(logPath, line, { mode: 0o600 });
  } catch {
    // 审计日志失败不应阻塞主流程;静默丢弃。
  }
}

// 便捷包装:记录一次命令调用的开始和结束(含耗时和结果)。
export async function withAuditLog(paths, { command, runId, caller, args }, fn) {
  const startedAt = Date.now();
  const baseEntry = { command, runId: runId ?? null, caller: caller ?? null, args };
  appendAuditLog(paths, { ...baseEntry, phase: 'start' });
  try {
    const result = await fn();
    appendAuditLog(paths, {
      ...baseEntry,
      phase: 'end',
      ok: true,
      durationMs: Date.now() - startedAt,
      result: result ? { status: result.status ?? null, runId: result.runId ?? null } : null,
    });
    return result;
  } catch (error) {
    appendAuditLog(paths, {
      ...baseEntry,
      phase: 'end',
      ok: false,
      durationMs: Date.now() - startedAt,
      error: {
        code: error.code ?? 'INTERNAL',
        message: error.message,
        category: error.details?.category ?? null,
      },
    });
    throw error;
  }
}

// 读取审计日志(用于 dashboard / 调试)。返回最新 N 条记录。
export async function readAuditLog(paths = resolveWorkerPaths(), limit = 100) {
  const { readFile } = await import('node:fs/promises');
  const logPath = resolveAuditLogPath(paths);
  try {
    const content = await readFile(logPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    const recent = lines.slice(-limit);
    return recent.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
