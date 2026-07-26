/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  buildCredentialHint,
  findSimilarEnvVarNames,
  loadShellProfileEnv,
} from '../lib/shell-profile.mjs';
import { makeTempDir } from './helpers.mjs';

async function writeProfile(home, file, content) {
  await mkdir(path.dirname(path.join(home, file)), { recursive: true });
  await writeFile(path.join(home, file), content);
}

test('loadShellProfileEnv reads export lines from .zshrc (single, double, unquoted)', async () => {
  const home = await makeTempDir('shell-profile-zshrc-');
  await writeProfile(home, '.zshrc', [
    'export VOLCENGINE_API_KEY=\'single-quoted-key\'',
    'export KIMI_API_KEY="double-quoted-key"',
    'export DEEPSEEK_API_KEY=unquoted-key',
    'export OPENAI_API_KEY=sk-1234 # trailing comment',
    'export NOT_A_REAL_VAR=ignored',
    '# export COMMENTED_OUT=should-not-load',
  ].join('\n') + '\n');
  const result = await loadShellProfileEnv(
    ['VOLCENGINE_API_KEY', 'KIMI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'],
    { home },
  );
  assert.equal(result.VOLCENGINE_API_KEY, 'single-quoted-key');
  assert.equal(result.KIMI_API_KEY, 'double-quoted-key');
  assert.equal(result.DEEPSEEK_API_KEY, 'unquoted-key');
  assert.equal(result.OPENAI_API_KEY, 'sk-1234');
  assert.ok(!('NOT_A_REAL_VAR' in result), 'should only return requested names');
  assert.ok(!('COMMENTED_OUT' in result), 'should skip commented exports');
});

test('loadShellProfileEnv skips placeholder and empty values', async () => {
  const home = await makeTempDir('shell-profile-placeholder-');
  await writeProfile(home, '.zshrc', [
    'export VOLCENGINE_API_KEY=YOUR_KEY_HERE',
    'export KIMI_API_KEY=your-key',
    'export DEEPSEEK_API_KEY=',
    'export OPENAI_API_KEY=sk-real-key',
  ].join('\n') + '\n');
  const result = await loadShellProfileEnv(
    ['VOLCENGINE_API_KEY', 'KIMI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'],
    { home },
  );
  assert.ok(!('VOLCENGINE_API_KEY' in result), 'YOUR_KEY_HERE must be skipped');
  assert.ok(!('KIMI_API_KEY' in result), 'your-key must be skipped');
  assert.ok(!('DEEPSEEK_API_KEY' in result), 'empty value must be skipped');
  assert.equal(result.OPENAI_API_KEY, 'sk-real-key');
});

test('loadShellProfileEnv returns empty object when no profile files exist', async () => {
  const home = await makeTempDir('shell-profile-empty-');
  const result = await loadShellProfileEnv(['VOLCENGINE_API_KEY'], { home });
  assert.deepEqual(result, {});
});

test('loadShellProfileEnv returns empty object for empty input array', async () => {
  const home = await makeTempDir('shell-profile-noinput-');
  await writeProfile(home, '.zshrc', 'export VOLCENGINE_API_KEY=whatever\n');
  const result = await loadShellProfileEnv([], { home });
  assert.deepEqual(result, {});
});

test('loadShellProfileEnv merges across files with first-file-wins semantics', async () => {
  const home = await makeTempDir('shell-profile-merge-');
  await writeProfile(home, '.zshrc', 'export VOLCENGINE_API_KEY=from-zshrc\n');
  await writeProfile(home, '.bash_profile', 'export VOLCENGINE_API_KEY=from-bash\nexport KIMI_API_KEY=kimi-key\n');
  const result = await loadShellProfileEnv(['VOLCENGINE_API_KEY', 'KIMI_API_KEY'], { home });
  assert.equal(result.VOLCENGINE_API_KEY, 'from-zshrc', 'first file wins');
  assert.equal(result.KIMI_API_KEY, 'kimi-key');
});

test('findSimilarEnvVarNames detects API_KEY when configured is VOLCENGINE_API_KEY', async () => {
  const home = await makeTempDir('shell-profile-similar-');
  await writeProfile(home, '.zshrc', 'export API_KEY=sk-some-key\n');
  const result = await findSimilarEnvVarNames(['VOLCENGINE_API_KEY', 'KIMI_API_KEY'], { home });
  assert.equal(result.VOLCENGINE_API_KEY, 'API_KEY');
  assert.equal(result.KIMI_API_KEY, 'API_KEY');
});

test('findSimilarEnvVarNames returns empty when all configured names are present', async () => {
  const home = await makeTempDir('shell-profile-already-configured-');
  await writeProfile(home, '.zshrc', [
    'export VOLCENGINE_API_KEY=sk-real',
    'export KIMI_API_KEY=kimi-real',
  ].join('\n') + '\n');
  const result = await findSimilarEnvVarNames(['VOLCENGINE_API_KEY', 'KIMI_API_KEY'], { home });
  assert.deepEqual(result, {});
});

test('findSimilarEnvVarNames detects _TOKEN vs _API_KEY suffix mismatch', async () => {
  const home = await makeTempDir('shell-profile-token-');
  await writeProfile(home, '.zshrc', 'export TRAE_TOKEN=some-token\n');
  const result = await findSimilarEnvVarNames(['TRAE_CLI_TOKEN'], { home });
  assert.equal(result.TRAE_CLI_TOKEN, 'TRAE_TOKEN');
});

test('findSimilarEnvVarNames matches shared provider prefix', async () => {
  const home = await makeTempDir('shell-profile-prefix-');
  await writeProfile(home, '.zshrc', 'export VOLCENGINE_SECRET_KEY=sk\n');
  const result = await findSimilarEnvVarNames(['VOLCENGINE_API_KEY'], { home });
  assert.equal(result.VOLCENGINE_API_KEY, 'VOLCENGINE_SECRET_KEY');
});

test('buildCredentialHint suggests source ~/.zshrc when key is in profile but not env', async () => {
  const home = await makeTempDir('shell-profile-hint-inherit-');
  await writeProfile(home, '.zshrc', 'export VOLCENGINE_API_KEY=sk-real\n');
  const hint = await buildCredentialHint('VOLCENGINE_API_KEY', { home });
  assert.match(hint, /found in shell profile but not inherited/);
  assert.match(hint, /source ~\/\.zshrc/);
});

test('buildCredentialHint suggests rename when a similar name is exported', async () => {
  const home = await makeTempDir('shell-profile-hint-rename-');
  await writeProfile(home, '.zshrc', 'export API_KEY=sk-real\n');
  const hint = await buildCredentialHint('VOLCENGINE_API_KEY', { home });
  assert.match(hint, /Found a similar export 'API_KEY'/);
  assert.match(hint, /did you mean to name it 'VOLCENGINE_API_KEY'/);
});

test('buildCredentialHint suggests the export line when nothing is configured', async () => {
  const home = await makeTempDir('shell-profile-hint-empty-');
  const hint = await buildCredentialHint('VOLCENGINE_API_KEY', { home });
  assert.match(hint, /Missing provider credential: VOLCENGINE_API_KEY/);
  assert.match(hint, /export VOLCENGINE_API_KEY=YOUR_KEY_HERE/);
  assert.match(hint, /pi-worker doctor/);
});
