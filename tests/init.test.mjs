/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { initCommand } from '../lib/init.mjs';
import { loadConfig, resolveWorkerPaths } from '../lib/config.mjs';
import { makeTempDir } from './helpers.mjs';

// Minimal in-memory IO that captures stdout output and answers yes/no
// prompts deterministically. Defaults to non-TTY stdin (the same behavior
// as running init from CI / a non-interactive parent process) so tests
// do not block waiting for input. When `tty` is true, the fake stdin
// emits the next entry from `yesAnswers` immediately when a 'data'
// listener is registered, so promptYesNo can resolve without a real TTY.
function makeIo({ tty = false, yesAnswers = [] } = {}) {
  const writes = [];
  const answers = [...yesAnswers];
  let dataListener = null;
  let endListener = null;
  const stdin = {
  isTTY: tty,
  on: (event, handler) => {
  if (event === 'data') {
  dataListener = handler;
  // Emit the next answer on the next microtask so the listener is
  // registered before the data event fires (mirrors real stdin).
  const next = answers.shift();
  if (next !== undefined) {
  Promise.resolve().then(() => dataListener(next ? 'y\n' : 'n\n'));
  }
  }
  if (event === 'end' && endListener) endListener();
  return stdin;
  },
  off: () => stdin,
  once: (event, handler) => {
  if (event === 'end') endListener = handler;
  return stdin;
  },
  };
  // stdout.write must invoke its callback so promptYesNo's
  // `await new Promise((resolve) => stdout.write(question, resolve))` resolves.
  const stdout = {
  write: (chunk, cb) => {
  writes.push(String(chunk));
  if (typeof cb === 'function') cb();
  return true;
  },
  };
  const io = { stdin, stdout };
  io._writes = writes;
  return io;
}

function getOutput(io) {
  return io._writes.join('');
}

test('initCommand installs the default config when none exists', async () => {
  const home = await makeTempDir('init-install-');
  const paths = resolveWorkerPaths({}, home);
  const env = { HOME: home, PATH: '' };
  const io = makeIo();

  const result = await initCommand({}, { env, paths, io });

  assert.equal(result.ok, true);
  assert.equal(result.command, 'init');
  assert.equal(result.configInstalled, true);
  // config.json now exists and is valid
  const config = await loadConfig(paths);
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.defaultProfile, 'volcengine');
  // models.json was also installed
  const models = JSON.parse(await readFile(paths.modelsFile, 'utf8'));
  assert.ok(models.providers['volcengine-plan']);
  // Output mentions the install path
  const out = getOutput(io);
  assert.match(out, /Installed default config/);
  assert.match(out, /Installed Volcengine provider/);
});

test('initCommand merges with an existing config and preserves user edits', async () => {
  const home = await makeTempDir('init-merge-');
  const paths = resolveWorkerPaths({}, home);
  // Pre-create a minimal config with a user marker that must survive merge.
  await mkdir(path.dirname(paths.configFile), { recursive: true });
  await writeFile(paths.configFile, JSON.stringify({
  schemaVersion: 1,
  marker: 'keep-me',
  limits: { piTimeoutSeconds: 9999 },
  profiles: {},
  }) + '\n');
  const env = { HOME: home, PATH: '' };
  const io = makeIo();

  const result = await initCommand({}, { env, paths, io });

  assert.equal(result.configInstalled, false);
  const raw = JSON.parse(await readFile(paths.configFile, 'utf8'));
  assert.equal(raw.marker, 'keep-me');
  assert.equal(raw.limits.piTimeoutSeconds, 9999);
  // Default profiles are merged in (volcengine must exist now)
  assert.ok(raw.profiles.volcengine);
  const out = getOutput(io);
  assert.match(out, /Merged default config/);
});

test('initCommand reports a profile configured when its env var is present', async () => {
  const home = await makeTempDir('init-env-cred-');
  const paths = resolveWorkerPaths({}, home);
  const env = {
  HOME: home,
  PATH: '',
  VOLCENGINE_API_KEY: 'sk-test-not-real',
  };
  const io = makeIo();

  const result = await initCommand({}, { env, paths, io });

  assert.equal(result.defaultProfile, 'volcengine');
  assert.equal(result.defaultCredentialConfigured, true);
  assert.ok(result.configuredCount >= 1);
  const out = getOutput(io);
  // volcengine profile line shows 'configured'
  assert.match(out, /volcengine\s+\(default\).*configured/);
  // No 'export VOLCENGINE_API_KEY=YOUR_KEY_HERE' hint for the configured profile
  assert.ok(!/export VOLCENGINE_API_KEY=YOUR_KEY_HERE/.test(out));
});

test('initCommand reports a profile not configured when env var is missing', async () => {
  const home = await makeTempDir('init-missing-cred-');
  const paths = resolveWorkerPaths({}, home);
  const env = { HOME: home, PATH: '' };
  const io = makeIo();

  const result = await initCommand({}, { env, paths, io });

  assert.equal(result.defaultCredentialConfigured, false);
  const out = getOutput(io);
  assert.match(out, /VOLCENGINE_API_KEY\s+→\s+not configured/);
  assert.match(out, /export VOLCENGINE_API_KEY=YOUR_KEY_HERE/);
  // Summary section calls out the missing credential
  assert.match(out, /credential:[^\n]*NOT configured/);
  // Next step tells the user to add the export line and run doctor
  assert.match(out, /add the export line above to ~\/\.zshrc/);
});

test('initCommand detects credentials stored in the shell profile', async () => {
  const home = await makeTempDir('init-shell-cred-');
  const paths = resolveWorkerPaths({}, home);
  // Write a .zshrc that exports VOLCENGINE_API_KEY (process.env does NOT have it)
  await writeFile(path.join(home, '.zshrc'), 'export VOLCENGINE_API_KEY=sk-from-zshrc\n');
  const env = { HOME: home, PATH: '' };
  const io = makeIo();

  const result = await initCommand({}, { env, paths, io });

  assert.equal(result.defaultCredentialConfigured, true);
  const out = getOutput(io);
  assert.match(out, /volcengine\s+\(default\).*configured/);
});

test('initCommand is non-interactive when stdin is not a TTY', async () => {
  const home = await makeTempDir('init-notty-');
  const paths = resolveWorkerPaths({}, home);
  // Default profile unconfigured + another profile unconfigured: even if the
  // switch-default branch would normally prompt, non-TTY stdin must skip it.
  const env = { HOME: home, PATH: '' };
  const io = makeIo({ tty: false });

  const result = await initCommand({}, { env, paths, io });

  assert.equal(result.switchedDefault, false);
  assert.equal(result.defaultProfile, 'volcengine'); // unchanged
});

test('initCommand switches default when default is unconfigured and another profile is configured (TTY yes)', async () => {
  const home = await makeTempDir('init-switch-default-');
  const paths = resolveWorkerPaths({}, home);
  // Default (volcengine) unconfigured; kimi configured via env
  const env = { HOME: home, PATH: '', KIMI_API_KEY: 'sk-kimi-test' };
  // TTY stdin that answers 'y' to the switch-default prompt.
  const io = makeIo({ tty: true, yesAnswers: [true] });

  const result = await initCommand({}, { env, paths, io });

  assert.equal(result.switchedDefault, true);
  assert.equal(result.defaultProfile, 'kimi');
  // Persisted to disk
  const raw = JSON.parse(await readFile(paths.configFile, 'utf8'));
  assert.equal(raw.defaultProfile, 'kimi');
  const out = getOutput(io);
  assert.match(out, /defaultProfile is now 'kimi'/);
});

test('initCommand keeps the default when the user declines the switch (TTY no)', async () => {
  const home = await makeTempDir('init-switch-no-');
  const paths = resolveWorkerPaths({}, home);
  const env = { HOME: home, PATH: '', KIMI_API_KEY: 'sk-kimi-test' };
  const io = makeIo({ tty: true, yesAnswers: [false] });

  const result = await initCommand({}, { env, paths, io });

  assert.equal(result.switchedDefault, false);
  assert.equal(result.defaultProfile, 'volcengine'); // unchanged
  const raw = JSON.parse(await readFile(paths.configFile, 'utf8'));
  assert.equal(raw.defaultProfile, 'volcengine');
});

test('initCommand prints the export hint for every unconfigured env-based profile', async () => {
  const home = await makeTempDir('init-export-hints-');
  const paths = resolveWorkerPaths({}, home);
  const env = { HOME: home, PATH: '' };
  const io = makeIo();

  await initCommand({}, { env, paths, io });

  const out = getOutput(io);
  // Several profiles in the default config use env-based credentials and
  // must each get a copy-paste export line.
  assert.match(out, /export VOLCENGINE_API_KEY=YOUR_KEY_HERE/);
  assert.match(out, /export DEEPSEEK_API_KEY=YOUR_KEY_HERE/);
  assert.match(out, /export KIMI_API_KEY=YOUR_KEY_HERE/);
});

test('initCommand lists all default profiles with adapter/provider/model metadata', async () => {
  const home = await makeTempDir('init-list-');
  const paths = resolveWorkerPaths({}, home);
  const env = { HOME: home, PATH: '' };
  const io = makeIo();

  const result = await initCommand({}, { env, paths, io });

  // The default config has 9 profiles (volcengine, deepseek, kimi,
  // minimax-m3, gemini-vision, gpt-image, kimi-cli, trae-cli, qoder-cli)
  assert.ok(result.profileCount >= 9);
  const out = getOutput(io);
  // Each profile name appears with its adapter / provider / model line
  for (const name of ['volcengine', 'deepseek', 'kimi', 'kimi-cli', 'trae-cli']) {
  assert.match(out, new RegExp(`\\b${name}\\b`));
  }
});

test('initCommand summary ends with a doctor recommendation when default is configured', async () => {
  const home = await makeTempDir('init-summary-cred-');
  const paths = resolveWorkerPaths({}, home);
  const env = { HOME: home, PATH: '', VOLCENGINE_API_KEY: 'sk-test' };
  const io = makeIo();

  await initCommand({}, { env, paths, io });

  const out = getOutput(io);
  assert.match(out, /next step:\s+pi-worker doctor/);
});

test('loadConfig auto-installs default config on ENOENT (Fix 9)', async () => {
  const home = await makeTempDir('init-loadcfg-autoinstall-');
  const paths = resolveWorkerPaths({}, home);
  // No config.json exists yet. loadConfig must auto-install rather than throw.
  const config = await loadConfig(paths);
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.defaultProfile, 'volcengine');
  assert.ok(config.profiles.volcengine);
  // The file is now persisted on disk so a second loadConfig succeeds normally.
  const raw = JSON.parse(await readFile(paths.configFile, 'utf8'));
  assert.equal(raw.schemaVersion, 1);
  // models.json is also installed as a side effect of installDefaultConfiguration
  const models = JSON.parse(await readFile(paths.modelsFile, 'utf8'));
  assert.ok(models.providers['volcengine-plan']);
});

test('loadConfig still throws CONFIG_INVALID on a corrupt (non-ENOENT) config', async () => {
  const home = await makeTempDir('init-loadcfg-corrupt-');
  const paths = resolveWorkerPaths({}, home);
  await mkdir(path.dirname(paths.configFile), { recursive: true });
  await writeFile(paths.configFile, '{ not valid json');
  await assert.rejects(() => loadConfig(paths), (error) => {
  assert.equal(error.code, 'CONFIG_INVALID');
  return true;
  });
});
