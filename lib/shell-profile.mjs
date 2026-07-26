/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Shell profile files scanned for `export NAME=value` lines, in the order
// zsh users typically hit first, then bash, then a generic fallback.
export const SHELL_PROFILE_FILES = ['.zshrc', '.bash_profile', '.bashrc', '.profile'];

// Placeholder values that should not be treated as a real credential.
const PLACEHOLDER_MARKERS = ['YOUR_KEY_HERE', 'your-key', 'YOUR_KEY', 'your_key_here'];

function isPlaceholderValue(value) {
  if (typeof value !== 'string' || value.length === 0) return true;
  for (const marker of PLACEHOLDER_MARKERS) {
    if (value.includes(marker)) return true;
  }
  return false;
}

// Parse a single `export NAME=value` line and return { name, value } or null.
// Accepts single-quoted, double-quoted, and unquoted values. Trailing comments
// after unquoted values are stripped. Returns null for malformed lines.
function parseExportLine(line) {
  const m = line.match(/^\s*export\s+([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (!m) return null;
  const name = m[1];
  let value = m[2].trim();
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    value = value.slice(1, -1);
  } else if (value.length > 0) {
    // strip trailing ` # comment` from unquoted values
    const hashIndex = value.indexOf(' #');
    if (hashIndex >= 0) value = value.slice(0, hashIndex).trimEnd();
  }
  return { name, value };
}

// Read all export lines from the user's shell profile files into a map of
// { name: value }. Skips placeholders and ENOENT/SyntaxError files. Internal
// helper used by both loadShellProfileEnv and findSimilarEnvVarNames.
async function readAllExports(options = {}) {
  const home = options.home || os.homedir();
  const exports = {};
  for (const file of SHELL_PROFILE_FILES) {
    const fullPath = path.join(home, file);
    let content;
    try {
      content = await readFile(fullPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    for (const line of content.split('\n')) {
      const parsed = parseExportLine(line);
      if (!parsed) continue;
      if (isPlaceholderValue(parsed.value)) continue;
      // first file wins; later files do not override earlier exports
      if (!Object.prototype.hasOwnProperty.call(exports, parsed.name)) {
        exports[parsed.name] = parsed.value;
      }
    }
  }
  return exports;
}

// Read the user's shell profile files (~/.zshrc, ~/.bash_profile, ~/.bashrc,
// ~/.profile) and return only the requested env var names. This is the
// dashboard / doctor / runner fallback for credential detection when the
// process env does not inherit them (e.g., GUI launch, non-login shell).
// Returns { [envVarName]: value } only for names in envVarNames; never leaks
// other variables. Placeholder values (YOUR_KEY_HERE, empty, your-key) are
// skipped. ENOENT and SyntaxError files are silently skipped.
export async function loadShellProfileEnv(envVarNames, options = {}) {
  if (!Array.isArray(envVarNames) || envVarNames.length === 0) return {};
  const wanted = new Set(envVarNames.filter((n) => typeof n === 'string' && n.length > 0));
  if (wanted.size === 0) return {};
  const allExports = await readAllExports(options);
  const result = {};
  for (const name of wanted) {
    if (Object.prototype.hasOwnProperty.call(allExports, name)) {
      result[name] = allExports[name];
    }
  }
  return result;
}

// Heuristic: does `candidate` look similar to `configured`?
// Returns true when candidate is not itself in the configured set, and either
// (a) shares a `_KEY` / `_API_KEY` / `_TOKEN` suffix with configured, or
// (b) shares a non-trivial substring (3+ chars) with configured.
// Used to surface the "user wrote API_KEY but config expects
// VOLCENGINE_API_KEY" trap.
function looksSimilar(candidate, configured) {
  if (candidate === configured) return false;
  const suffixes = ['_KEY', '_API_KEY', '_TOKEN'];
  for (const suffix of suffixes) {
    if (candidate.endsWith(suffix) && configured.endsWith(suffix)) return true;
  }
  // shared provider prefix (e.g., "VOLCENGINE" in both names)
  const min = 3;
  for (let i = 0; i <= configured.length - min; i += 1) {
    const sub = configured.slice(i, i + min);
    if (sub.includes('_')) continue;
    if (candidate.includes(sub)) return true;
  }
  return false;
}

// Scan the user's shell profile files and return a map of
// { configuredName: similarNameFound } for each configured env var that has
// NO direct export in the profile but DOES have a similar-looking export that
// the user might have intended. Helps detect the "user wrote API_KEY but the
// config expects VOLCENGINE_API_KEY" trap.
export async function findSimilarEnvVarNames(envVarNames, options = {}) {
  if (!Array.isArray(envVarNames) || envVarNames.length === 0) return {};
  const wanted = envVarNames.filter((n) => typeof n === 'string' && n.length > 0);
  if (wanted.length === 0) return {};
  const wantedSet = new Set(wanted);
  const allExports = await readAllExports(options);
  const exportedNames = Object.keys(allExports);
  const result = {};
  for (const configured of wanted) {
    if (wantedSet.has(configured) && Object.prototype.hasOwnProperty.call(allExports, configured)) {
      // configured name is already exported; no hint needed
      continue;
    }
    const match = exportedNames.find((candidate) => looksSimilar(candidate, configured));
    if (match) result[configured] = match;
  }
  return result;
}

// Build the most actionable single-string hint for a missing provider
// credential. Used by doctor, pi-runner, and prepare so they all surface the
// same recovery instructions. Returns a string (no trailing newline).
//
// Decision tree:
//   1. Found in shell profile but not in process env → tell the user to start
//      from a login shell or `source ~/.zshrc` so the export is inherited.
//   2. A similar env var name is exported in the profile → tell the user the
//      likely-intended name to rename.
//   3. Nothing similar anywhere → tell the user the exact `export` line to
//      add and the next command to verify.
export async function buildCredentialHint(apiKeyEnv, options = {}) {
  const profileEnv = await loadShellProfileEnv([apiKeyEnv], options);
  if (Object.prototype.hasOwnProperty.call(profileEnv, apiKeyEnv)) {
    return `Credential '${apiKeyEnv}' found in shell profile but not inherited by this process. Start from a login shell or use 'source ~/.zshrc' before running pi-worker.`;
  }
  const similar = await findSimilarEnvVarNames([apiKeyEnv], options);
  const similarName = similar[apiKeyEnv];
  if (similarName) {
    return `Missing provider credential: ${apiKeyEnv}. Found a similar export '${similarName}' in your shell profile — did you mean to name it '${apiKeyEnv}'?`;
  }
  return `Missing provider credential: ${apiKeyEnv}. Add to your shell profile: export ${apiKeyEnv}=YOUR_KEY_HERE  Then run: source ~/.zshrc && pi-worker doctor`;
}
