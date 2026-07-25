import os from 'node:os';
import { selectBackend } from './parent-agents/index.mjs';

export async function snapshotParentUsage({ home = os.homedir(), threadId, env = process.env } = {}) {
  const backend = selectBackend(env);
  const resolvedThreadId = threadId ?? env.PARENT_THREAD_ID ?? env.CODEX_THREAD_ID;
  const snapshot = await backend.snapshotUsage({ home, threadId: resolvedThreadId });
  if (!snapshot.backend) snapshot.backend = backend.name;
  return snapshot;
}

export function usageDelta(start, end) {
  if (!start?.available || !end?.available) return { available: false, reason: start?.reason ?? end?.reason ?? 'Parent usage snapshot unavailable' };
  const field = (name) => Math.max(0, (end[name] ?? 0) - (start[name] ?? 0));
  return {
    available: true,
    backend: end.backend ?? start.backend ?? 'unknown',
    inputTokens: field('inputTokens'),
    cachedInputTokens: field('cachedInputTokens'),
    cacheWriteInputTokens: field('cacheWriteInputTokens'),
    outputTokens: field('outputTokens'),
    reasoningOutputTokens: field('reasoningOutputTokens'),
    totalTokens: field('totalTokens'),
    startAt: start.at,
    endAt: end.at,
  };
}
