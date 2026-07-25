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
