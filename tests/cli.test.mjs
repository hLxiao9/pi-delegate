import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runNode } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'scripts', 'pi-worker.mjs');

test('--help exposes the stable subcommand surface', async () => {
  const result = await runNode(cli, ['--help']);
  assert.equal(result.code, 0, result.stderr);
  for (const command of ['doctor', 'prepare', 'run', 'revise', 'verify', 'approve', 'integrate', 'report', 'cleanup']) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
});

test('unknown commands return structured JSON errors', async () => {
  const result = await runNode(cli, ['unknown']);
  assert.equal(result.code, 2);
  const error = JSON.parse(result.stderr);
  assert.equal(error.ok, false);
  assert.equal(error.error.code, 'CLI_USAGE');
});
