/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { git, sourceUnchanged } from './git-worker.mjs';

function matches(relative, patterns) {
  return patterns.some((pattern) => path.matchesGlob(relative, pattern));
}

function parseNumstat(output) {
  return output.split('\0').filter(Boolean).map((record) => {
    const [added, deleted, ...pathParts] = record.split('\t');
    return { added, deleted, path: pathParts.join('\t') };
  });
}

function isPlaceholderValue(value) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!normalized) return false;
  const words = new Set(['dummy', 'example', 'fake', 'key', 'leak', 'not', 'placeholder', 'real', 'redacted', 'secret', 'should', 'super', 'test', 'token', 'value']);
  const parts = normalized.split('-');
  return parts.length <= 5 && parts.every((part) => words.has(part));
}

function genericSecretAssignment(line) {
  const match = line.match(/\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*["']([^$"']{11,})["']/i);
  return Boolean(match && !isPlaceholderValue(match[2]));
}

function secretIssues(diff) {
  const added = diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).map((line) => line.slice(1));
  const patterns = [
    /AKIA[0-9A-Z]{16}/,
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
  ];
  return added.some((line) => patterns.some((pattern) => pattern.test(line)) || genericSecretAssignment(line))
    ? [{ code: 'SECRET_DETECTED', message: 'Added lines contain a probable credential' }]
    : [];
}

export async function scanWorkerDelta({ paths, state, task, config, env = process.env }) {
  await git(paths, state.worktreePath, ['add', '-N', '--', '.'], { env });
  const limit = config.limits.maxDiffBytes + 1;
  const namesResult = await git(paths, state.worktreePath, ['diff', '--name-only', '-z', '--no-renames', state.workerBaseRevision], { env, maxCaptureChars: limit, allowTruncated: true });
  const changedFiles = namesResult.stdout.split('\0').filter(Boolean);
  const issues = [];
  if (namesResult.stdoutTruncated) issues.push({ code: 'DIFF_TOO_LARGE', message: 'Worker diff metadata exceeds configured maximum size' });
  if (changedFiles.length === 0) issues.push({ code: 'NO_CHANGES', message: 'Pi produced no implementation diff' });
  if (changedFiles.length > config.limits.maxChangedFiles) issues.push({ code: 'TOO_MANY_FILES', message: `Changed ${changedFiles.length} files`, limit: config.limits.maxChangedFiles });
  const forbidden = [...config.alwaysForbiddenPaths, ...task.forbiddenPaths];
  for (const relative of changedFiles) {
    if (path.isAbsolute(relative) || relative.split('/').includes('..') || !matches(relative, task.allowedPaths) || matches(relative, forbidden)) {
      issues.push({ code: 'PATH_OUT_OF_SCOPE', path: relative, message: 'Changed path is outside the task allowlist or matches a deny rule' });
      continue;
    }
    try {
      const info = await lstat(path.join(state.worktreePath, relative));
      if (info.isSymbolicLink()) issues.push({ code: 'SYMLINK_CHANGE', path: relative, message: 'Changed symbolic links are not allowed in v1' });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const numstatResult = await git(paths, state.worktreePath, ['diff', '--numstat', '-z', '--no-renames', state.workerBaseRevision], { env, maxCaptureChars: limit, allowTruncated: true });
  if (numstatResult.stdoutTruncated) issues.push({ code: 'DIFF_TOO_LARGE', message: 'Worker diff statistics exceed configured maximum size' });
  const stats = parseNumstat(numstatResult.stdout);
  let addedLines = 0;
  let deletedLines = 0;
  for (const entry of stats) {
    if (entry.added === '-' || entry.deleted === '-') issues.push({ code: 'BINARY_CHANGE', path: entry.path, message: 'Binary changes are not delegated in v1' });
    else {
      addedLines += Number(entry.added);
      deletedLines += Number(entry.deleted);
    }
  }
  const denominator = addedLines + deletedLines;
  const deletionRatio = denominator === 0 ? 0 : deletedLines / denominator;
  if (deletionRatio > config.limits.maxDeletedLineRatio) issues.push({ code: 'EXCESSIVE_DELETION', message: `Deletion ratio ${deletionRatio.toFixed(3)} exceeds limit`, deletionRatio });
  const diffResult = await git(paths, state.worktreePath, ['diff', '--unified=0', '--no-ext-diff', '--no-renames', state.workerBaseRevision], { env, maxCaptureChars: limit, allowTruncated: true });
  issues.push(...secretIssues(diffResult.stdout));
  if (diffResult.stdoutTruncated || Buffer.byteLength(diffResult.stdout) > config.limits.maxDiffBytes) issues.push({ code: 'DIFF_TOO_LARGE', message: 'Worker diff exceeds configured maximum size' });
  if (!(await sourceUnchanged(paths, state, env))) issues.push({ code: 'SOURCE_CHANGED', message: 'Source HEAD, index, worktree, or untracked content changed during the run' });
  return {
    passed: issues.length === 0,
    issues,
    changedFiles,
    addedLines,
    deletedLines,
    deletionRatio,
    diffBytes: Buffer.byteLength(diffResult.stdout),
    diffSha256: createHash('sha256').update(diffResult.stdout).digest('hex'),
  };
}
