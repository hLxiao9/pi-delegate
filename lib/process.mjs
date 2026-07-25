import { spawn } from 'node:child_process';

const activeProcesses = new Map();

function keepTail(current, chunk, limit) {
  const combined = current + chunk;
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}

export function terminateProcessTree(child) {
  if (!child.pid || child.exitCode !== null) return null;
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      killer.unref();
      return null;
    } else {
      process.kill(-child.pid, 'SIGTERM');
      const force = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }, 1000);
      force.unref();
      return force;
    }
  } catch {
    try { child.kill('SIGKILL'); } catch {}
    return null;
  }
}

/**
 * Stop every process currently owned by this worker process.
 *
 * The CLI installs a SIGINT/SIGTERM handler which calls this function instead
 * of letting Node exit immediately.  That gives the command handler a chance
 * to persist a recoverable run state and release its lock.
 */
export function abortActiveProcesses(reason = 'interrupted') {
  let aborted = 0;
  for (const entry of activeProcesses.values()) {
    if (entry.child.exitCode !== null) continue;
    entry.interrupted = true;
    entry.interruptionReason = reason;
    entry.forceTimer = terminateProcessTree(entry.child);
    aborted += 1;
  }
  return aborted;
}

export async function runProcess(command, argv = [], options = {}) {
  const startedAt = Date.now();
  const maxCaptureChars = options.maxCaptureChars ?? 12000;
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let timer;
    let settled = false;
    const entry = { child, interrupted: false, interruptionReason: null };
    activeProcesses.set(child, entry);

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (entry.forceTimer) clearTimeout(entry.forceTimer);
      activeProcesses.delete(child);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length + chunk.length > maxCaptureChars) stdoutTruncated = true;
      stdout = keepTail(stdout, chunk, maxCaptureChars);
      if (options.onStdoutLine) {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) options.onStdoutLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length + chunk.length > maxCaptureChars) stderrTruncated = true;
      stderr = keepTail(stderr, chunk, maxCaptureChars);
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (options.onStdoutLine && stdoutBuffer.length > 0) options.onStdoutLine(stdoutBuffer);
      resolve({
        command,
        argv: [...argv],
        code,
        signal,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        interrupted: entry.interrupted,
        interruptionReason: entry.interruptionReason,
        durationMs: Date.now() - startedAt,
      });
    });
    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        entry.forceTimer = terminateProcessTree(child);
      }, options.timeoutMs);
      timer.unref();
    }
    child.stdin.end(options.input ?? '');
  });
}
