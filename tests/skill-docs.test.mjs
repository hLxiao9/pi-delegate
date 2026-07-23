import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(new URL('..', import.meta.url).pathname);

test('SKILL frontmatter is discoverable and contains only name and description', async () => {
  const source = await readFile(path.join(root, 'SKILL.md'), 'utf8');
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, 'frontmatter missing');
  const keys = match[1].split('\n').filter(Boolean).map((line) => line.split(':', 1)[0]);
  assert.deepEqual(keys, ['name', 'description']);
  assert.match(match[1], /^name: pi-delegate$/m);
  assert.match(match[1], /^description: Use when /m);
});

test('SKILL encodes the complete safe loop and stays concise', async () => {
  const source = await readFile(path.join(root, 'SKILL.md'), 'utf8');
  for (const phrase of [
    'doctor', 'prepare', 'run', 'verify', 'revise', 'approve', 'integrate', 'report', 'cleanup',
    'vision-input', 'image-output', 'P0', 'P1', 'P2', 'Never push', 'Do not ask the user to review code'
  ]) assert.ok(source.includes(phrase), phrase);
  assert.ok(source.split('\n').length < 500);
  const forbiddenDraftMarkers = ['TO' + 'DO', 'T' + 'BD', 'fill' + ' in', 'implement' + ' later'];
  for (const marker of forbiddenDraftMarkers) assert.ok(!source.toLowerCase().includes(marker.toLowerCase()), marker);
});

test('all direct references and disabled pre-release UI metadata are present', async () => {
  const source = await readFile(path.join(root, 'SKILL.md'), 'utf8');
  for (const relative of ['references/review-policy.md', 'references/provider-configuration.md', 'schemas/task-contract.schema.json', 'schemas/review-result.schema.json']) {
    assert.ok(source.includes(relative), relative);
    await readFile(path.join(root, relative), 'utf8');
  }
  const metadata = await readFile(path.join(root, 'agents', 'openai.yaml'), 'utf8');
  assert.match(metadata, /default_prompt: "Use \$pi-delegate/);
  assert.match(metadata, /allow_implicit_invocation: false/);
});
