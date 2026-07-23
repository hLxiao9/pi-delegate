import { spawn } from 'node:child_process';

function keepTail(current, chunk, limit) {
  const combined = current + chunk;
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}

export function terminateProcessTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      killer.unref();
    } else {
      process.kill(-child.pid, 'SIGTERM');
      const force = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }, 1000);
      force.unref();
    }
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
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
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
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
        durationMs: Date.now() - startedAt,
      });
    });
    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child);
      }, options.timeoutMs);
      timer.unref();
    }
    child.stdin.end(options.input ?? '');
  });
}
