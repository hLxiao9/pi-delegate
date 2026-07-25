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
