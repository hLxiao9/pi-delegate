import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export async function makeTempDir(prefix = 'pi-delegate-') {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function runNode(script, args = [], options = {}) {
  return runProcess(process.execPath, [script, ...args], options);
}

export async function runProcess(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(options.input ?? '');
  });
}

export async function writeExecutable(file, source) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, source, { mode: 0o755 });
}

export async function initGitRepo(root) {
  await mkdir(root, { recursive: true });
  await runProcess('git', ['init', '-b', 'main'], { cwd: root });
  await runProcess('git', ['config', 'user.name', 'Pi Worker Test'], { cwd: root });
  await runProcess('git', ['config', 'user.email', 'pi-worker@example.invalid'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# fixture\n');
  await runProcess('git', ['add', 'README.md'], { cwd: root });
  await runProcess('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-m', 'test: initial fixture'], { cwd: root });
  return root;
}
