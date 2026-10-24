/*
 * spotworkers - Delegate bounded coding tasks to cheap agent workers
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { git, sourceUnchanged } from './git-worker.mjs';

// Allow-list matching: git always reports relative paths with forward
// slashes and allowedPaths patterns also use '/', so path.matchesGlob
// works correctly on every platform without normalization. The deny-list
// needs the extra fail-closed layers in matchesForbidden() below because
// a missed deny is a security hole, whereas a missed allow is merely a
// false-positive block (safe direction).
function matches(relative, patterns) {
  return patterns.some((pattern) => path.matchesGlob(relative, pattern));
}

// Deny-list matching must be fail-closed: when in doubt, deny. Git always
// reports relative paths with forward slashes, but path.matchesGlob on
// Windows interprets backslashes, causing silent mismatches that let
// sensitive dotfiles (.env, *credential*, *secret*) slip through. We
// normalize both sides to '/' and use POSIX glob semantics, plus
// exact-path and basename checks, so sensitive files are caught on
// every platform.
function matchesForbidden(relative, patterns) {
  const normalized = relative.replace(/\\/g, '/');
  const basename = normalized.split('/').pop();
  const matchGlob = typeof path.posix.matchesGlob === 'function' ? path.posix.matchesGlob : path.matchesGlob;
  return patterns.some((pattern) => {
    const np = pattern.replace(/\\/g, '/');
    // 1. Exact full-path match (pattern '.env' catches relative '.env')
    if (normalized === np) return true;
    // 2. Basename exact match (pattern '.env' catches 'config/.env')
    if (basename === np) return true;
    // 3. Glob match with POSIX (forward-slash) semantics
    if (matchGlob(normalized, np)) return true;
    // 4. For patterns without a path separator, also match against basename
    //    so '.env.*' catches 'config/.env.local'
    if (!np.includes('/') && matchGlob(basename, np)) return true;
    return false;
  });
}

function parseNumstat(output) {
  return output.split('\0').filter(Boolean).map((record) => {
    const [added, deleted, ...pathParts] = record.split('\t');
    return { added, deleted, path: pathParts.join('\t') };
  });
}

// Verification-integrity guard.
//
// A path allowlist can say "the worker may edit src/** and tests/**", but it
// cannot say "the worker may edit the implementation and not the assertion it
// is graded against". Without that distinction a worker can rewrite the test,
// or point the `test` script at `exit 0`, and the wrapper will faithfully run
// the contract argv and record a pass — a self-certification, not a
// verification.
//
// Three layers close that hole:
//   1. contract.lockedPaths      parent-authored acceptance files (per task)
//   2. config.alwaysLockedPaths  runner/CI config that shapes how argv behaves
//   3. package.json semantics    execution-defining keys are frozen, while
//                                dependencies stay editable so a legitimate
//                                feature can still add a package.
const VERIFICATION_KEYS = ['scripts', 'jest', 'vitest', 'mocha', 'ava', 'nyc', 'c8', 'workspaces', 'packageManager'];
const UNPARSABLE = '__unparsable__';

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

// Reduce a package.json to the keys that decide what `npm test` actually does.
// `dependencies` / `devDependencies` are deliberately excluded: adding a
// package is implementation work, rewriting the script that grades it is not.
function verificationSlice(text) {
  if (text === null || text === undefined) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { [UNPARSABLE]: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { [UNPARSABLE]: true };
  const slice = {};
  for (const key of VERIFICATION_KEYS) {
    if (parsed[key] !== undefined) slice[key] = canonicalValue(parsed[key]);
  }
  return slice;
}

async function readRevisionText({ paths, worktree, revision, relative, env, maxCaptureChars }) {
  const result = await git(paths, worktree, ['show', `${revision}:${relative}`], {
    env,
    maxCaptureChars,
    allowTruncated: true,
    allowFailure: true,
  });
  return result.code === 0 ? result.stdout : null;
}

async function lockedPathIssues({ paths, worktree, baseRevision, headRevision, changedFiles, task, config, env, limit, label }) {
  const locked = [...(config.alwaysLockedPaths ?? []), ...(task.lockedPaths ?? [])];
  const issues = [];
  const alreadyReported = new Set();
  for (const relative of changedFiles) {
    if (!matchesForbidden(relative, locked)) continue;
    alreadyReported.add(relative);
    issues.push({
      code: 'LOCKED_PATH_CHANGED',
      path: relative,
      message: `${label} changed a path that is locked by the contract or the config`,
    });
  }
  // Frozen package.json keys. A package.json that is already locked is fatal on
  // its own, so it is skipped here instead of being reported twice.
  for (const relative of changedFiles) {
    if (alreadyReported.has(relative)) continue;
    if (path.posix.basename(relative) !== 'package.json') continue;
    const baseText = await readRevisionText({ paths, worktree, revision: baseRevision, relative, env, maxCaptureChars: limit });
    const headText = headRevision
      ? await readRevisionText({ paths, worktree, revision: headRevision, relative, env, maxCaptureChars: limit })
      : await readFile(path.join(worktree, relative), 'utf8').catch(() => null);
    const before = verificationSlice(baseText);
    const after = verificationSlice(headText);
    const changedKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    if (changedKeys.length > 0) {
      issues.push({
        code: 'VERIFICATION_SCRIPT_CHANGED',
        path: relative,
        changedKeys,
        message: 'Changed package.json keys that define how the verification commands execute',
      });
    }
  }
  return issues;
}

// `git diff --numstat` reports how many lines were added/deleted but says nothing
// about how large the edited file was. That missing denominator is why the
// original formula — `deleted / (added + deleted)` — blocked every pure edit:
// rewriting one line of a 12-line file scores 1/(1+1) = 0.5, immediately over the
// 0.35 limit, even though 11 of 12 lines were untouched. Fixing a single bug is
// the most common delegation shape, so that formula made the guardrail useless.
//
// The question worth asking is "how much of the base file did the worker
// delete?", so the base revision's line count is the denominator. Pure additions
// score 0; deleting a whole file scores 1.0.
async function baseLineCount({ paths, worktree, revision, relative, env, maxCaptureChars }) {
  const result = await git(paths, worktree, ['show', `${revision}:${relative}`], {
    env,
    maxCaptureChars,
    allowTruncated: true,
    // A path absent from the base revision is a brand-new file: zero base lines,
    // so its additions cannot dilute the ratio for the files that did shrink.
    allowFailure: true,
  });
  if (result.code !== 0 || !result.stdout) return 0;
  const lines = result.stdout.split('\n').length;
  return result.stdout.endsWith('\n') ? lines - 1 : lines;
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
  issues.push(...await lockedPathIssues({
  paths,
  worktree: state.worktreePath,
  baseRevision: state.workerBaseRevision,
  headRevision: null,
  changedFiles,
  task,
  config,
  env,
  limit,
  label: 'Worker',
  }));
  for (const relative of changedFiles) {
    if (path.isAbsolute(relative) || relative.split('/').includes('..') || !matches(relative, task.allowedPaths) || matchesForbidden(relative, forbidden)) {
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
  let baseLines = 0;
  for (const entry of stats) {
    if (entry.added === '-' || entry.deleted === '-') issues.push({ code: 'BINARY_CHANGE', path: entry.path, message: 'Binary changes are not delegated in v1' });
    else {
      addedLines += Number(entry.added);
      deletedLines += Number(entry.deleted);
      // Only files that actually shrank need a denominator; counting untouched
      // files would let a large untouched tree hide a deleted one.
      if (Number(entry.deleted) > 0) {
        baseLines += await baseLineCount({
          paths,
          worktree: state.worktreePath,
          revision: state.workerBaseRevision,
          relative: entry.path,
          env,
          maxCaptureChars: limit,
        });
      }
    }
  }
  // Ratio against the base file size, not against the size of the diff.
  const deletionRatio = baseLines === 0 ? 0 : deletedLines / baseLines;
  if (deletionRatio > config.limits.maxDeletedLineRatio) {
    issues.push({
      code: 'EXCESSIVE_DELETION',
      message: `Deletion ratio ${deletionRatio.toFixed(3)} of the edited file(s) exceeds limit`,
      deletionRatio,
      deletedLines,
      baseLines,
    });
  }
  // A ratio alone cannot catch "small percentage, enormous damage" — deleting
  // 3000 lines out of a 10000-line file is 0.30, under the default limit, and
  // still not something to wave through.
  const maxDeletedLines = Number.isInteger(config.limits.maxDeletedLines) ? config.limits.maxDeletedLines : 300;
  if (deletedLines > maxDeletedLines) {
    issues.push({
      code: 'EXCESSIVE_DELETION',
      message: `Deleted ${deletedLines} lines, above the absolute ceiling of ${maxDeletedLines}`,
      deletedLines,
      maxDeletedLines,
    });
  }
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

// Scan the diff between two commits (baseRevision..headCommit) for security issues.
// Used by approve recovery path to ensure a recovered HEAD commit matches what was
// scanned in the worktree, closing the TOCTOU window between scanWorkerDelta and
// recoverApprovedCommit reading HEAD (issue #1 P1-2).
export async function scanCommitDelta({ paths, state, task, config, headCommit, env = process.env }) {
  const baseRevision = state.workerBaseRevision;
  const limit = config.limits.maxDiffBytes + 1;
  // Verify the commit range is exactly one commit (recovery invariant)
  const countResult = await git(paths, state.worktreePath, ['rev-list', '--count', `${baseRevision}..${headCommit}`], { env });
  if (countResult.stdout.trim() !== '1') {
    return { passed: false, issues: [{ code: 'MULTIPLE_COMMITS', message: 'Recovered range spans multiple commits' }], diffSha256: null };
  }
  const namesResult = await git(paths, state.worktreePath, ['diff', '--name-only', '-z', '--no-renames', `${baseRevision}..${headCommit}`], { env, maxCaptureChars: limit, allowTruncated: true });
  const changedFiles = namesResult.stdout.split('\0').filter(Boolean);
  const issues = [];
  if (namesResult.stdoutTruncated) issues.push({ code: 'DIFF_TOO_LARGE', message: 'Commit diff metadata exceeds configured maximum size' });
  if (changedFiles.length > config.limits.maxChangedFiles) issues.push({ code: 'TOO_MANY_FILES', message: `Changed ${changedFiles.length} files`, limit: config.limits.maxChangedFiles });
  const forbidden = [...config.alwaysForbiddenPaths, ...task.forbiddenPaths];
  issues.push(...await lockedPathIssues({
  paths,
  worktree: state.worktreePath,
  baseRevision,
  headRevision: headCommit,
  changedFiles,
  task,
  config,
  env,
  limit,
  label: 'Recovered commit',
  }));
  for (const relative of changedFiles) {
    if (path.isAbsolute(relative) || relative.split('/').includes('..') || !matches(relative, task.allowedPaths) || matchesForbidden(relative, forbidden)) {
      issues.push({ code: 'PATH_OUT_OF_SCOPE', path: relative, message: 'Recovered commit changed path outside the task allowlist or matching a deny rule' });
    }
  }
  const diffResult = await git(paths, state.worktreePath, ['diff', '--unified=0', '--no-ext-diff', '--no-renames', `${baseRevision}..${headCommit}`], { env, maxCaptureChars: limit, allowTruncated: true });
  issues.push(...secretIssues(diffResult.stdout));
  if (diffResult.stdoutTruncated || Buffer.byteLength(diffResult.stdout) > config.limits.maxDiffBytes) issues.push({ code: 'DIFF_TOO_LARGE', message: 'Recovered commit diff exceeds configured maximum size' });
  return {
    passed: issues.length === 0,
    issues,
    changedFiles,
    diffSha256: createHash('sha256').update(diffResult.stdout).digest('hex'),
  };
}
