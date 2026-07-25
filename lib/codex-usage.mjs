import { snapshotUsage as snapshotCodexBackend } from './parent-agents/codex.mjs';
import { usageDelta as parentUsageDelta } from './parent-usage.mjs';

export async function snapshotCodexUsage({ home, threadId = process.env.CODEX_THREAD_ID } = {}) {
  return snapshotCodexBackend({ home, threadId });
}

export const usageDelta = parentUsageDelta;
