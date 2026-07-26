/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getAdapter, listAdapters, resolveBin } from './adapters/index.mjs';
import { readJson, writeTextAtomic } from './atomic-json.mjs';
import { resolveWorkerPaths } from './config.mjs';
import { invariant } from './errors.mjs';
import { readPiUsage } from './metrics.mjs';
import { runProcess } from './process.mjs';
import { loadRun, runFiles } from './state.mjs';

const DEFAULT_CALLER = 'unknown';

function callerOrDefault(value) {
  return typeof value === 'string' && value.length > 0 ? value : DEFAULT_CALLER;
}

async function readOptionalJson(file) {
  try { return await readJson(file); } catch (error) { if (error.code === 'ENOENT') return null; if (error instanceof SyntaxError) return null; throw error; }
}

export async function listRunStates(paths) {
  const runsRoot = path.join(paths.stateRoot, 'runs');
  let entries = [];
  try { entries = await readdir(runsRoot, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const states = [];
  for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const state = await readOptionalJson(path.join(runsRoot, entry.name, 'state.json'));
  if (state && state.runId) states.push(state);
  }
  states.sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''));
  return states;
}

export function summarizeState(state) {
  return {
  runId: state.runId,
  status: state.status,
  caller: callerOrDefault(state.caller),
  provider: state.provider,
  model: state.model,
  profile: state.profile,
  createdAt: state.createdAt,
  updatedAt: state.updatedAt,
  revisionRound: state.revisionRound ?? 0,
  fallbackUsed: Boolean(state.fallbackUsed),
  implementationCommit: state.implementationCommit ?? null,
  integratedCommit: state.integratedCommit ?? null,
  sourceBranch: state.sourceBranch ?? null,
  workerBranch: state.workerBranch ?? null,
  };
}

export async function listCommand(options = {}, runtime = {}) {
  const env = runtime.env ?? process.env;
  const paths = runtime.paths ?? resolveWorkerPaths(env);
  let states = await listRunStates(paths);
  if (options.status) states = states.filter((state) => state.status === options.status);
  if (options.caller) states = states.filter((state) => callerOrDefault(state.caller) === options.caller);
  if (options.running) states = states.filter((state) => ['prepared', 'running', 'verifying', 'reviewing', 'revising'].includes(state.status));
  return { runs: states.map(summarizeState), count: states.length };
}

export async function inspectCommand(options = {}, runtime = {}) {
  invariant(options.id, 'CLI_USAGE', 'inspect requires --id', {}, 2);
  const env = runtime.env ?? process.env;
  const paths = runtime.paths ?? resolveWorkerPaths(env);
  const loaded = await loadRun(paths, options.id);
  const metrics = await readOptionalJson(loaded.files.metrics);
  const verification = await readOptionalJson(loaded.files.verification);
  const review = await readOptionalJson(loaded.files.review);
  const piUsage = await readPiUsage(loaded.files.events);
  return {
  state: loaded.state,
  task: { runId: loaded.task.runId, goal: loaded.task.goal, risk: loaded.task.risk, allowedPaths: loaded.task.allowedPaths },
  metrics,
  verification,
  review,
  piUsage,
  };
}

export async function dashboardCommand(options = {}, runtime = {}) {
  const env = runtime.env ?? process.env;
  const paths = runtime.paths ?? resolveWorkerPaths(env);
  const states = await listRunStates(paths);
  const metricsList = await Promise.all(states.map(async (state) => readOptionalJson(runFiles(paths, state.runId).metrics)));
  const dashboardFile = options.output ?? path.join(paths.stateRoot, 'dashboard.html');
  const generatedAt = new Date().toISOString();
  const connections = await buildConnectionsPayload({ env, paths });
  await writeTextAtomic(dashboardFile, renderDashboardHtml(states, metricsList, generatedAt, { connections }));
  return { dashboardFile, runCount: states.length };
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) {
  const value = item[key] ?? DEFAULT_CALLER;
  counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function formatLocal(iso) {
  try { const d = new Date(iso); const pad = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); } catch { return iso; }
}

function formatTimestamp(iso) {
  if (!iso) return '—';
  return escapeHtml(formatLocal(iso));
}

function formatTokens(n) {
  if (!Number.isFinite(n) || n === 0) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatPercent(rate) {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms === 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

function statusBadgeClass(status) {
  if (status === 'integrated') return 'badge green';
  if (status === 'failed') return 'badge red';
  if (status === 'blocked') return 'badge orange';
  if (status === 'approved' || status === 'committed') return 'badge blue';
  return 'badge gray';
}

function callerBadgeClass(caller) {
  if (caller === 'trae') return 'badge blue';
  if (caller === 'codex') return 'badge green';
  if (caller === 'claude-code') return 'badge purple';
  if (caller === 'cursor') return 'badge cyan';
  if (caller === 'pi-recursive') return 'badge orange';
  if (caller === 'cli') return 'badge gray';
  return 'badge light';
}

function buildSummary(states, metricsList) {
  const summaries = states.map(summarizeState);
  let totalPiInput = 0, totalPiOutput = 0, totalPiDurationMs = 0, totalPiRequests = 0;
  let totalDisplacedCredits = 0, totalActualCredits = 0, savingRateSum = 0, savingRateCount = 0;
  let totalEquivalentCredits = 0, totalSubscriptionPortion = 0, subscriptionPortionCount = 0;
  let subscriptionAllowance = null, subscriptionAllowanceCredits = null;
  for (const metrics of metricsList) {
  if (!metrics) continue;
  totalPiInput += metrics.pi?.usage?.inputTokens ?? 0;
  totalPiOutput += metrics.pi?.usage?.outputTokens ?? 0;
  totalPiDurationMs += metrics.pi?.usage?.durationMs ?? 0;
  totalPiRequests += metrics.pi?.usage?.requests ?? 0;
  totalDisplacedCredits += metrics.counterfactual?.estimatedDisplacedParentCredits ?? metrics.counterfactual?.estimatedDisplacedSolCredits ?? 0;
  totalActualCredits += (metrics.parent ?? metrics.codex)?.actualCredits ?? 0;
  const rate = metrics.counterfactual?.estimatedCreditSavingRate;
  if (Number.isFinite(rate)) { savingRateSum += rate; savingRateCount += 1; }
  const equiv = metrics.counterfactual?.estimatedEquivalentCredits;
  if (Number.isFinite(equiv)) totalEquivalentCredits += equiv;
  const portion = metrics.counterfactual?.estimatedSubscriptionPortion;
  if (Number.isFinite(portion)) { totalSubscriptionPortion += portion; subscriptionPortionCount += 1; }
  if (!subscriptionAllowance) subscriptionAllowance = metrics.counterfactual?.subscriptionAllowance ?? null;
  if (!subscriptionAllowanceCredits) subscriptionAllowanceCredits = metrics.counterfactual?.subscriptionAllowanceCredits ?? null;
  }
  return {
  total: summaries.length,
  byCaller: countBy(summaries, 'caller'),
  byStatus: countBy(summaries, 'status'),
  totalPiInput,
  totalPiOutput,
  totalPiDurationMs,
  totalPiRequests,
  totalDisplacedCredits,
  totalActualCredits,
  totalEquivalentCredits,
  totalSubscriptionPortion: subscriptionPortionCount > 0 ? totalSubscriptionPortion : null,
  subscriptionAllowance,
  subscriptionAllowanceCredits,
  meanSavingRate: savingRateCount > 0 ? savingRateSum / savingRateCount : null,
  };
}

function buildRow(state, metrics) {
  const summary = summarizeState(state);
  return {
  ...summary,
  piInput: metrics?.pi?.usage?.inputTokens ?? 0,
  piOutput: metrics?.pi?.usage?.outputTokens ?? 0,
  piCached: metrics?.pi?.usage?.cachedInputTokens ?? 0,
  piDuration: metrics?.pi?.usage?.durationMs ?? 0,
  piRequests: metrics?.pi?.usage?.requests ?? 0,
  savingRate: metrics?.counterfactual?.estimatedCreditSavingRate ?? null,
  actualCredits: (metrics?.parent ?? metrics?.codex)?.actualCredits ?? null,
  displacedCredits: metrics?.counterfactual?.estimatedDisplacedParentCredits ?? metrics?.counterfactual?.estimatedDisplacedSolCredits ?? null,
  equivalentCredits: metrics?.counterfactual?.estimatedEquivalentCredits ?? null,
  subscriptionPortion: metrics?.counterfactual?.estimatedSubscriptionPortion ?? null,
  subscriptionAllowance: metrics?.counterfactual?.subscriptionAllowance ?? null,
  subscriptionAllowanceCredits: metrics?.counterfactual?.subscriptionAllowanceCredits ?? null,
  piBalanceAvailable: metrics?.pi?.balance?.available ?? false,
  piBalance: metrics?.pi?.balance?.balance ?? null,
  piBalanceCurrency: metrics?.pi?.balance?.currency ?? null,
  piBalanceQuota: metrics?.pi?.balance?.quota ?? null,
  piBalanceReason: metrics?.pi?.balance?.reason ?? null,
  revisionRounds: metrics?.quality?.revisionRounds ?? summary.revisionRound,
  verificationPassed: metrics?.quality?.finalVerificationPassed ?? null,
  fallbackUsed: summary.fallbackUsed,
  commit: summary.implementationCommit ?? summary.integratedCommit,
  transitions: state.transitions ?? [],
  };
}

function renderSummaryCards(summary) {
  const callerBadges = Object.entries(summary.byCaller)
  .sort((a, b) => b[1] - a[1])
  .map(([caller, count]) => `<span class="${callerBadgeClass(caller)}">${escapeHtml(caller)}: ${count}</span>`).join(' ');
  const statusBadges = Object.entries(summary.byStatus)
  .sort((a, b) => b[1] - a[1])
  .map(([status, count]) => `<span class="${statusBadgeClass(status)}">${escapeHtml(status)}: ${count}</span>`).join(' ');
  return `
  <section class="cards">
  <div class="card"><div class="card-label">Total Runs</div><div class="card-value">${summary.total}</div></div>
  <div class="card"><div class="card-label">Pi call count</div><div class="card-value">${summary.totalPiRequests}</div><div class="card-sub">duration ${formatDuration(summary.totalPiDurationMs)}</div></div>
  <div class="card"><div class="card-label">Pi token total</div><div class="card-value">${formatTokens(summary.totalPiInput + summary.totalPiOutput)}</div><div class="card-sub">in ${formatTokens(summary.totalPiInput)} / out ${formatTokens(summary.totalPiOutput)}</div></div>
  <div class="card"><div class="card-label">mean saving rate</div><div class="card-value">${formatPercent(summary.meanSavingRate)}</div><div class="card-sub">estimated displacement ${summary.totalDisplacedCredits.toFixed(4)} credits</div></div>
  <div class="card"><div class="card-label">Equivalent parent-side credits</div><div class="card-value">${summary.totalEquivalentCredits.toFixed(2)}</div><div class="card-sub">Pi tokens converted at parent rate card</div></div>
  <div class="card"><div class="card-label">Portion of ${summary.subscriptionAllowance === 'weekly' ? 'weekly' : 'subscription'} allowance</div><div class="card-value">${formatPercent(summary.totalSubscriptionPortion)}</div><div class="card-sub">allowance ${summary.subscriptionAllowanceCredits ?? '—'} credits(community estimate)</div></div>
  <div class="card"><div class="card-label">call source</div><div class="card-badges">${callerBadges || '<span class="badge light">None</span>'}</div></div>
  <div class="card"><div class="card-label">Status distribution</div><div class="card-badges">${statusBadges || '<span class="badge light">None</span>'}</div></div>
  </section>`;
}

function renderRow(row) {
  const commitCell = row.commit ? `<code title="${escapeHtml(row.commit)}">${escapeHtml(row.commit.slice(0, 8))}</code>` : '<span class="muted">—</span>';
  const savingCell = row.savingRate !== null ? formatPercent(row.savingRate) : '<span class="muted">—</span>';
  const verificationCell = row.verificationPassed === null ? '<span class="muted">—</span>' : row.verificationPassed ? '<span class="ok">pass</span>' : '<span class="warn">Fail</span>';
  const transitions = row.transitions.length > 0
  ? `<div class="detail-block"><div class="detail-label">Status transitions</div><table class="mini-table"><tr><th>from</th><th>to</th><th>Time</th><th>Reason</th></tr>${row.transitions.map((t) => `<tr><td>${escapeHtml(t.from)}</td><td>${escapeHtml(t.to)}</td><td>${escapeHtml(formatLocal(t.at))}</td><td>${escapeHtml(t.reason ?? '—')}</td></tr>`).join('')}</table></div>`
  : '';
  const metrics = row.piRequests > 0
  ? `<div class="detail-block"><div class="detail-label">Pi usage</div><table class="mini-table"><tr><th>Call count</th><th>duration</th><th>Input tokens</th><th>cache read</th><th>Output tokens</th></tr><tr><td>${row.piRequests}</td><td>${formatDuration(row.piDuration)}</td><td>${formatTokens(row.piInput)}</td><td>${formatTokens(row.piCached)}</td><td>${formatTokens(row.piOutput)}</td></tr></table></div>`
  : '';
  const credits = row.actualCredits !== null || row.displacedCredits !== null
  ? `<div class="detail-block"><div class="detail-label">Cost and savings</div><table class="mini-table"><tr><th>Actual parent-side credits</th><th>Estimated displacement credits</th><th>saving rate</th><th>Rework rounds</th></tr><tr><td>${escapeHtml(String(row.actualCredits ?? '—'))}</td><td>${escapeHtml(String(row.displacedCredits ?? '—'))}</td><td>${formatPercent(row.savingRate)}</td><td>${escapeHtml(String(row.revisionRounds))}</td></tr></table></div>`
  : '';
  return `
  <tr class="row" data-run="${escapeHtml(row.runId)}" data-caller="${escapeHtml(row.caller)}" data-status="${escapeHtml(row.status)}">
  <td><code>${escapeHtml(row.runId)}</code></td>
  <td>${escapeHtml(formatTimestamp(row.createdAt))}</td>
  <td><span class="${callerBadgeClass(row.caller)}">${escapeHtml(row.caller)}</span></td>
  <td><span class="${statusBadgeClass(row.status)}">${escapeHtml(row.status)}</span></td>
  <td>${escapeHtml(row.provider)}<span class="muted"> / </span>${escapeHtml(row.model)}</td>
  <td>${formatTokens(row.piInput + row.piOutput)}</td>
  <td>${formatDuration(row.piDuration)}</td>
  <td>${row.equivalentCredits !== null ? row.equivalentCredits.toFixed(2) : '<span class="muted">—</span>'}</td>
  <td>${row.subscriptionPortion !== null ? formatPercent(row.subscriptionPortion) : '<span class="muted">—</span>'}</td>
  <td>${savingCell}</td>
  <td>${verificationCell}</td>
  <td>${row.piBalanceAvailable && row.piBalance !== null ? escapeHtml(String(row.piBalance)) + (row.piBalanceCurrency ? ' ' + escapeHtml(row.piBalanceCurrency) : '') + (row.piBalanceQuota !== null ? ' / ' + escapeHtml(String(row.piBalanceQuota)) : '') : '<span class="muted" title="' + escapeHtml(row.piBalanceReason || 'No adapter') + '">—</span>'}</td>
  <td>${commitCell}</td>
  </tr>
  <tr class="detail" data-run-detail="${escapeHtml(row.runId)}">
  <td colspan="13">
  ${metrics}
  ${credits}
  ${transitions}
  ${!metrics && !credits && !transitions ? '<div class="muted">No more details.run `pi-worker report --id ' + escapeHtml(row.runId) + '` generate metrics.</div>' : ''}
  </td>
  </tr>`;
}

// Probe a single CLI adapter's binary via its versionCommand.
// Never throws — every failure (spawn error, non-zero exit, timeout) is
// captured and returned as available:false with a reason snippet.
// Only env-var names and adapter names appear in the output; no api key values.
async function probeAdapterCli(env, adapter) {
  let bin = null;
  let argv = ['--version'];
  try {
  bin = resolveBin(adapter, env);
  const versionSpec = adapter.versionCommand();
  if (versionSpec && Array.isArray(versionSpec.argv) && versionSpec.argv.length > 0) argv = [...versionSpec.argv];
  } catch (err) {
  return {
  name: adapter.name,
  available: false,
  version: null,
  stderr: '',
  bin: null,
  reason: err && err.message ? err.message : 'adapter resolution failed',
  };
  }
  const childEnv = {
  PATH: typeof env.PATH === 'string' ? env.PATH : '',
  HOME: typeof env.HOME === 'string' ? env.HOME : '',
  };
  try {
  const result = await runProcess(bin, argv, { env: childEnv, timeoutMs: 5000, maxCaptureChars: 4000 });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const semverMatch = stdout.match(/\d+\.\d+\.\d+/);
  let version = null;
  if (semverMatch) version = semverMatch[0];
  else {
  const firstLine = stdout.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
  if (firstLine) version = firstLine.slice(0, 64);
  }
  let reason = null;
  if (result.timedOut) reason = 'timeout';
  else if (result.code !== 0) reason = 'exit ' + result.code;
  return {
  name: adapter.name,
  available: result.code === 0 && !result.timedOut,
  version,
  stderr: stderr.length > 200 ? stderr.slice(-200) : stderr,
  bin,
  reason,
  };
  } catch (error) {
  const code = error && (error.code ?? error.message);
  return {
  name: adapter.name,
  available: false,
  version: null,
  stderr: '',
  bin,
  reason: code ? String(code) : 'spawn failed',
  };
  }
}

// Probe all known adapters in parallel. Never throws; returns an array
// with one entry per registered adapter.
export async function probeAllAdapters(runtime = {}) {
  const env = runtime.env ?? process.env;
  const list = listAdapters();
  const results = await Promise.all(list.map(async (meta) => {
  try {
  const adapter = getAdapter(meta.name);
  return await probeAdapterCli(env, adapter);
  } catch (err) {
  return {
  name: meta.name,
  available: false,
  version: null,
  stderr: '',
  bin: null,
  reason: err && err.message ? err.message : 'probe failed',
  };
  }
  }));
  return results;
}

// Build the per-profile connection state derived from the user's config
// and the dashboard's process env. No API key values are copied into the
// output; only env-var names and placeholder hints.
export function buildConnectionsList(env, rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object' || !rawConfig.profiles || typeof rawConfig.profiles !== 'object') return [];
  const profiles = [];
  for (const [name, profile] of Object.entries(rawConfig.profiles)) {
  if (!profile || typeof profile !== 'object') continue;
  const apiKeyEnv = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : '';
  const provider = typeof profile.provider === 'string' ? profile.provider : '';
  const model = typeof profile.model === 'string' ? profile.model : '';
  const adapter = typeof profile.adapter === 'string' && profile.adapter.length > 0 ? profile.adapter : 'pi';
  const credentialAvailable = apiKeyEnv.length > 0 && Boolean(env[apiKeyEnv]);
  let hint = null;
  let hintType = 'none';
  if (!credentialAvailable) {
  if (adapter === 'trae') {
  hintType = 'oauth';
  hint = 'Run `traecli` once interactively to complete enterprise login.';
  } else if (apiKeyEnv.length > 0) {
  hintType = 'env';
  hint = `export ${apiKeyEnv}=YOUR_KEY_HERE`;
  }
  }
  profiles.push({ name, provider, model, adapter, apiKeyEnv, credentialAvailable, hint, hintType });
  }
  return profiles;
}

// Resolve the set of profile names the connections panel should surface.
// A profile is relevant when ANY of these hold:
//  (a) its apiKeyEnv is set in the supplied env
//  (b) it is the config.defaultProfile
//  (c) it appears as state.profile in some past run's state.json
//  (d) it is listed in fallbackProfiles of any profile already deemed relevant
// This prevents the panel from pestering users with export-<KEY>=YOUR_KEY_HERE
// hints for profiles the user has not configured and has never dispatched to.
export async function computeRelevantProfileNames(paths, rawConfig, env) {
  const names = new Set();
  if (!rawConfig || typeof rawConfig !== 'object') return names;
  const profiles = rawConfig.profiles && typeof rawConfig.profiles === 'object' && !Array.isArray(rawConfig.profiles)
  ? rawConfig.profiles : {};
  // (a) profiles whose apiKeyEnv is currently set
  if (env && typeof env === 'object') {
  for (const [name, profile] of Object.entries(profiles)) {
  if (!profile || typeof profile !== 'object') continue;
  const apiKeyEnv = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : '';
  if (apiKeyEnv.length > 0 && Boolean(env[apiKeyEnv])) names.add(name);
  }
  }
  // (b) the configured default profile
  const defaultProfile = typeof rawConfig.defaultProfile === 'string' ? rawConfig.defaultProfile : '';
  if (defaultProfile.length > 0 && profiles[defaultProfile]) names.add(defaultProfile);
  // (c) profile names that appear in past run state.json files
  if (paths && typeof paths.stateRoot === 'string' && paths.stateRoot.length > 0) {
  const runsRoot = path.join(paths.stateRoot, 'runs');
  let entries = [];
  try { entries = await readdir(runsRoot, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const state = await readOptionalJson(path.join(runsRoot, entry.name, 'state.json'));
  if (state && typeof state.profile === 'string' && state.profile.length > 0) names.add(state.profile);
  }
  }
  // (d) BFS over fallbackProfiles of already-relevant profiles (cycle-safe)
  const visited = new Set();
  const queue = Array.from(names);
  while (queue.length > 0) {
  const name = queue.shift();
  if (visited.has(name)) continue;
  visited.add(name);
  const profile = profiles[name];
  if (!profile || typeof profile !== 'object') continue;
  const fallbacks = profile.fallbackProfiles;
  if (!Array.isArray(fallbacks)) continue;
  for (const fb of fallbacks) {
  if (typeof fb === 'string' && fb.length > 0 && !visited.has(fb)) {
  names.add(fb);
  queue.push(fb);
  }
  }
  }
  return names;
}

// from user shell profile (~/.zshrc, ~/.bash_profile etc.) parse export statement,
// returns the value of the specified environment variable.for dashboard fallback for credential status detection:
// when server process env when variable missing(e.g., from GUI/non-interactive shell start),
// try from user shell profile read,avoid false positives"not configured".
// only returns requested variable names,does not leak other variables;does not log key value to log.
const SHELL_PROFILE_FILES = ['.zshrc', '.bash_profile', '.bashrc', '.profile'];
async function loadShellProfileEnv(envVarNames, options = {}) {
  if (!Array.isArray(envVarNames) || envVarNames.length === 0) return {};
  const wanted = new Set(envVarNames.filter((n) => typeof n === 'string' && n.length > 0));
  if (wanted.size === 0) return {};
  const home = options.home || os.homedir();
  const result = {};
  for (const file of SHELL_PROFILE_FILES) {
  const fullPath = path.join(home, file);
  let content;
  try { content = await readFile(fullPath, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; if (error instanceof SyntaxError) continue; throw error; }
  for (const line of content.split('\n')) {
  // match export NAME='value' / export NAME="value" / export NAME=value
  const m = line.match(/^\s*export\s+([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (!m) continue;
  const name = m[1];
  if (!wanted.has(name)) continue;
  let value = m[2].trim();
  // strip quotes(single or double quotes)
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
  value = value.slice(1, -1);
  }
  // skip placeholders and empty values
  if (value.length === 0 || value.includes('YOUR_KEY_HERE') || value.includes('your-key')) continue;
  result[name] = value;
  }
  }
  return result;
}

// Compose the full /api/connections payload from probing + config.
export async function buildConnectionsPayload(runtime = {}) {
  const env = runtime.env ?? process.env;
  const paths = runtime.paths ?? resolveWorkerPaths(env);
  const adapters = await probeAllAdapters({ env });
  const rawConfig = await readOptionalJson(paths.configFile);
  // fallback:merges user shell profile in env.process.env preferred(runtime-injected values are more trustworthy),
  // shell profile as fallback(solves server from GUI/non-interactive shell startup missing API key issue).
  const allApiKeyEnvs = rawConfig?.profiles && typeof rawConfig.profiles === 'object'
  ? Object.values(rawConfig.profiles)
  .map((p) => p && typeof p === 'object' && typeof p.apiKeyEnv === 'string' ? p.apiKeyEnv : '')
  .filter((n) => n.length > 0)
  : [];
  const profileEnv = allApiKeyEnvs.length > 0 ? await loadShellProfileEnv(allApiKeyEnvs, { home: env.HOME }) : {};
  const mergedEnv = { ...profileEnv, ...env };
  const allProfiles = buildConnectionsList(mergedEnv, rawConfig);
  const relevantNames = await computeRelevantProfileNames(paths, rawConfig, mergedEnv);
  const profiles = allProfiles.filter((p) => relevantNames.has(p.name));
  return { adapters, profiles };
}

function renderHintBlock(hintType, hint, apiKeyEnv) {
  if (hintType === 'env') {
  const id = 'hint-env-' + Math.random().toString(36).slice(2, 9);
  return `
  <div class="hint-block">
  <code id="${id}">${escapeHtml(hint ?? '')}</code>
  <button type="button" class="copy-btn" data-target="${id}">copy</button>
  </div>
  <div class="hint-note">after replacing placeholders with real credentials,execute in shell.</div>`;
  }
  if (hintType === 'oauth') {
  return `
  <div class="hint-block">
  <code>${escapeHtml(hint ?? '')}</code>
  </div>
  <div class="hint-note">Trae uses OAuth login;please run interactively in terminal <code>${escapeHtml(apiKeyEnv || 'traecli')}</code> once to complete enterprise login.</div>`;
  }
  return '<span class="muted">—</span>';
}

// Render the connections panel HTML — used for both initial render and live refresh.
export function renderConnectionsPanelHtml(adapters, profiles) {
  const adapterRows = (Array.isArray(adapters) ? adapters : []).map((probe) => {
  const status = probe.available ? '<span class="badge green">connected</span>' : '<span class="badge red">not connected</span>';
  const version = probe.available && probe.version ? `<code>${escapeHtml(probe.version)}</code>` : '<span class="muted">—</span>';
  let note;
  if (probe.stderr && probe.stderr.length > 0) {
  const snippet = probe.stderr.length > 80 ? probe.stderr.slice(0, 80) + '...' : probe.stderr;
  note = `<code title="${escapeHtml(probe.stderr)}">${escapeHtml(snippet)}</code>`;
  } else if (probe.reason) {
  note = `<span class="muted">${escapeHtml(probe.reason)}</span>`;
  } else {
  note = '<span class="muted">—</span>';
  }
  return `
  <tr>
  <td><strong>${escapeHtml(probe.name)}</strong></td>
  <td>${status}</td>
  <td>${version}</td>
  <td>${note}</td>
  </tr>`;
  }).join('');
  const profileRows = (Array.isArray(profiles) ? profiles : []).map((profile) => {
  const cred = profile.credentialAvailable ? '<span class="badge green">configured</span>' : '<span class="badge orange">not configured</span>';
  const action = profile.credentialAvailable
  ? '<span class="muted">—</span>'
  : renderHintBlock(profile.hintType, profile.hint, profile.apiKeyEnv);
  return `
  <tr>
  <td><code>${escapeHtml(profile.name)}</code></td>
  <td>${escapeHtml(profile.provider || '—')}</td>
  <td>${escapeHtml(profile.model || '—')}</td>
  <td><span class="badge gray">${escapeHtml(profile.adapter)}</span></td>
  <td>${cred}</td>
  <td>${action}</td>
  </tr>`;
  }).join('');
  const adapterTable = Array.isArray(adapters) && adapters.length > 0
  ? '<table><thead><tr><th>name</th><th>status</th><th>version</th><th>note</th></tr></thead><tbody>' + adapterRows + '</tbody></table>'
  : '<p class="empty">No CLI adapters registered.</p>';
  const profileTable = Array.isArray(profiles) && profiles.length > 0
  ? '<table><thead><tr><th>Profile</th><th>Provider</th><th>Model</th><th>Adapter</th><th>credential</th><th>action</th></tr></thead><tbody>' + profileRows + '</tbody></table>'
  : '<p class="empty">No profiles found.check <code>~/.config/pi-worker/config.json</code> exists.</p>';
  return `
  <section class="connections">
  <h2>CLI adapter connection status</h2>
  ${adapterTable}
  <h2>Profile credential status</h2>
  ${profileTable}
  </section>`;
}

// Aggregate built rows by provider+model. Pure function so it can be
// unit-tested with a fixture without touching disk.
export function buildProviderModelAggregation(rows) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
  if (!row || typeof row !== 'object') continue;
  const provider = typeof row.provider === 'string' && row.provider.length > 0 ? row.provider : 'unknown';
  const model = typeof row.model === 'string' && row.model.length > 0 ? row.model : 'unknown';
  const key = provider + '|' + model;
  if (!groups.has(key)) {
  groups.set(key, {
  provider, model, adapter: row.caller ?? null,
  runCount: 0, totalPiRequests: 0,
  totalPiInput: 0, totalPiOutput: 0,
  totalPiDuration: 0, totalEquivalentCredits: 0,
  savingRateSum: 0, savingRateCount: 0,
  lastUsed: null,
  });
  }
  const g = groups.get(key);
  g.runCount += 1;
  g.totalPiRequests += row.piRequests ?? 0;
  g.totalPiInput += row.piInput ?? 0;
  g.totalPiOutput += row.piOutput ?? 0;
  g.totalPiDuration += row.piDuration ?? 0;
  g.totalEquivalentCredits += row.equivalentCredits ?? 0;
  if (Number.isFinite(row.savingRate)) {
  g.savingRateSum += row.savingRate;
  g.savingRateCount += 1;
  }
  if (row.createdAt && (!g.lastUsed || String(row.createdAt) > String(g.lastUsed))) g.lastUsed = row.createdAt;
  // Update adapter label: prefer the most recent caller observation.
  if (row.caller && (!g.adapter || g.adapter === 'unknown')) g.adapter = row.caller;
  }
  const out = [];
  for (const g of groups.values()) {
  out.push({
  provider: g.provider,
  model: g.model,
  adapter: g.adapter,
  runCount: g.runCount,
  totalPiRequests: g.totalPiRequests,
  totalPiInput: g.totalPiInput,
  totalPiOutput: g.totalPiOutput,
  totalPiDuration: g.totalPiDuration,
  totalEquivalentCredits: g.totalEquivalentCredits,
  meanSavingRate: g.savingRateCount > 0 ? g.savingRateSum / g.savingRateCount : null,
  lastUsed: g.lastUsed,
  });
  }
  out.sort((left, right) => {
  if (right.runCount !== left.runCount) return right.runCount - left.runCount;
  return String(right.lastUsed ?? '').localeCompare(String(left.lastUsed ?? ''));
  });
  return out;
}

function renderProviderModelAggregationHtml(groups) {
  if (!Array.isArray(groups) || groups.length === 0) {
  return `
  <section class="provider-model">
  <h2>CLI / model usage statistics</h2>
  <p class="empty">No model usage data yet.</p>
  </section>`;
  }
  const rows = groups.map((g) => {
  const adapterLabel = g.adapter ? `<div class="muted">${escapeHtml(g.adapter)}</div>` : '';
  const equiv = g.totalEquivalentCredits > 0 ? g.totalEquivalentCredits.toFixed(2) : '—';
  return `
  <tr>
  <td><strong>${escapeHtml(g.provider)}</strong><span class="muted"> / </span>${escapeHtml(g.model)}${adapterLabel}</td>
  <td>${g.runCount}</td>
  <td>${g.totalPiRequests}</td>
  <td>${formatTokens(g.totalPiInput + g.totalPiOutput)}<div class="muted">in ${formatTokens(g.totalPiInput)} / out ${formatTokens(g.totalPiOutput)}</div></td>
  <td>${formatDuration(g.totalPiDuration)}</td>
  <td>${equiv}</td>
  <td>${formatPercent(g.meanSavingRate)}</td>
  <td>${formatTimestamp(g.lastUsed)}</td>
  </tr>`;
  }).join('');
  return `
  <section class="provider-model">
  <h2>CLI / model usage statistics</h2>
  <table>
  <thead>
  <tr>
  <th>model</th>
  <th>Runs</th>
  <th>Pi calls</th>
  <th>Pi Token</th>
  <th>Pi duration</th>
  <th>Equivalent credits</th>
  <th>mean saving rate</th>
  <th>Last used</th>
  </tr>
  </thead>
  <tbody>${rows}</tbody>
  </table>
  </section>`;
}

function renderFilters() {
  return `
  <section class="filters">
  <input id="filter-text" type="search" placeholder="Filter by runId / provider / model..." />
  <select id="filter-caller"><option value="">All sources</option><option value="trae">trae</option><option value="codex">codex</option><option value="claude-code">claude-code</option><option value="cursor">cursor</option><option value="pi-recursive">pi-recursive</option><option value="cli">cli</option><option value="unknown">unknown</option></select>
  <select id="filter-status"><option value="">All statuses</option><option value="prepared">prepared</option><option value="running">running</option><option value="verifying">verifying</option><option value="reviewing">reviewing</option><option value="revising">revising</option><option value="approved">approved</option><option value="committed">committed</option><option value="integrated">integrated</option><option value="failed">failed</option><option value="blocked">blocked</option></select>
  </section>`;
}

export function renderDashboardFragment(states, metricsList, generatedAt, options = {}) {
  const summary = buildSummary(states, metricsList);
  const rows = states.map((state, index) => buildRow(state, metricsList[index]));
  const empty = rows.length === 0 ? '<p class="empty">No runs yet.run `pi-worker prepare --task <task.json>` to create the first one.</p>' : '';
  const aggregation = renderProviderModelAggregationHtml(buildProviderModelAggregation(rows));
  return {
  generatedAt,
  bodyHtml: renderSummaryCards(summary) + '\n' + renderFilters() + '\n' + (empty || '<table>\n  <thead><tr><th>Run ID</th><th>Created at</th><th>Source</th><th>status</th><th>model</th><th>Pi Token</th><th>Pi duration</th><th>Equivalent credits</th><th>Allowance share</th><th>saving rate</th><th>verification</th><th>Pi-side balance</th><th>Commit</th></tr></thead>\n  <tbody>' + rows.map(renderRow).join('') + '</tbody>\n</table>') + '\n' + aggregation,
  };
}

function dashboardScript(options) {
  const live = options && options.live === true;
  const parts = [];
  parts.push('  function formatLocal(iso) { const d = new Date(iso); const pad = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + pad(d.getMonth()+1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()); }\n  function clientEscapeHtml(text) { return String(text == null ? "" : text).replace(/[&<>"\']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\\"": "&quot;", "\'": "&#39;" })[c]; }); }\n  function clientTruncate(s, n) { if (!s) return ""; var t = String(s); return t.length > n ? t.slice(0, n) + "..." : t; }\n  function renderClientConnectionsPanel(adapters, profiles) {\n  var adapterRows = (Array.isArray(adapters) ? adapters : []).map(function (p) {\n  var status = p.available ? \'<span class="badge green">connected</span>\' : \'<span class="badge red">not connected</span>\';\n  var version = (p.available && p.version) ? \'<code>\' + clientEscapeHtml(p.version) + \'</code>\' : \'<span class="muted">—</span>\';\n  var note;\n  if (p.stderr && p.stderr.length > 0) {\n  var snippet = clientTruncate(p.stderr, 80);\n  note = \'<code title="\' + clientEscapeHtml(p.stderr) + \'">\' + clientEscapeHtml(snippet) + \'</code>\';\n  } else if (p.reason) {\n  note = \'<span class="muted">\' + clientEscapeHtml(p.reason) + \'</span>\';\n  } else {\n  note = \'<span class="muted">—</span>\';\n  }\n  return \'<tr><td><strong>\' + clientEscapeHtml(p.name) + \'</strong></td><td>\' + status + \'</td><td>\' + version + \'</td><td>\' + note + \'</td></tr>\';\n  }).join("");\n  var profileRows = (Array.isArray(profiles) ? profiles : []).map(function (p) {\n  var cred = p.credentialAvailable ? \'<span class="badge green">configured</span>\' : \'<span class="badge orange">not configured</span>\';\n  var action = \'<span class="muted">—</span>\';\n  if (!p.credentialAvailable) {\n  if (p.hintType === "env") {\n  var eid = "hint-env-" + Math.random().toString(36).slice(2, 9);\n  action = \'<div class="hint-block"><code id="\' + eid + \'">\' + clientEscapeHtml(p.hint || "") + \'</code> <button type="button" class="copy-btn" data-target="\' + eid + \'">copy</button></div><div class="hint-note">after replacing placeholders with real credentials,execute in shell.</div>\';\n  } else if (p.hintType === "oauth") {\n  action = \'<div class="hint-block"><code>\' + clientEscapeHtml(p.hint || "") + \'</code></div><div class="hint-note">Trae uses OAuth login;please run interactively in terminal \' + clientEscapeHtml(p.apiKeyEnv || "traecli") + \' once to complete enterprise login.</div>\';\n  }\n  }\n  return \'<tr><td><code>\' + clientEscapeHtml(p.name) + \'</code></td><td>\' + clientEscapeHtml(p.provider || "—") + \'</td><td>\' + clientEscapeHtml(p.model || "—") + \'</td><td><span class="badge gray">\' + clientEscapeHtml(p.adapter) + \'</span></td><td>\' + cred + \'</td><td>\' + action + \'</td></tr>\';\n  }).join("");\n  var adapterTable = (Array.isArray(adapters) && adapters.length > 0)\n  ? \'<table><thead><tr><th>name</th><th>status</th><th>version</th><th>note</th></tr></thead><tbody>\' + adapterRows + \'</tbody></table>\'\n  : \'<p class="empty">No CLI adapters registered.</p>\';\n  var profileTable = (Array.isArray(profiles) && profiles.length > 0)\n  ? \'<table><thead><tr><th>Profile</th><th>Provider</th><th>Model</th><th>Adapter</th><th>credential</th><th>action</th></tr></thead><tbody>\' + profileRows + \'</tbody></table>\'\n  : \'<p class="empty">No profiles found.check <code>~/.config/pi-worker/config.json</code> exists.</p>\';\n  return \'<section class="connections"><h2>CLI adapter connection status</h2>\' + adapterTable + \'<h2>Profile credential status</h2>\' + profileTable + \'</section>\';\n  }\n  function bindCopyButtons() {\n  document.querySelectorAll(".copy-btn").forEach(function (btn) {\n  if (btn.dataset.bound === "1") return;\n  btn.dataset.bound = "1";\n  btn.addEventListener("click", function () {\n  var targetId = btn.dataset.target;\n  var target = targetId ? document.getElementById(targetId) : null;\n  if (!target) return;\n  var text = target.textContent || "";\n  var original = btn.textContent;\n  var showDone = function () { btn.textContent = "Copied"; setTimeout(function () { btn.textContent = original; }, 1500); };\n  var showFail = function () { btn.textContent = "Copy failed"; setTimeout(function () { btn.textContent = original; }, 1500); };\n  if (navigator.clipboard && navigator.clipboard.writeText) {\n  navigator.clipboard.writeText(text).then(showDone).catch(showFail);\n  } else {\n  try {\n  var ta = document.createElement("textarea");\n  ta.value = text;\n  document.body.appendChild(ta);\n  ta.select();\n  document.execCommand("copy");\n  document.body.removeChild(ta);\n  showDone();\n  } catch (e) { showFail(); }\n  }\n  });\n  });\n  }\n  function selectTab(name) {\n  if (!name) return;\n  var btns = document.querySelectorAll(".tab-btn");\n  var panels = document.querySelectorAll(".tab-panel");\n  btns.forEach(function (b) { b.classList.toggle("active", b.dataset.tab === name); });\n  panels.forEach(function (p) { p.classList.toggle("active", p.id === "tab-" + name); });\n  try { localStorage.setItem("pi-worker-active-tab", name); } catch (e) {}\n  }\n  function initTabs() {\n  var saved = null;\n  try { saved = localStorage.getItem("pi-worker-active-tab"); } catch (e) {}\n  selectTab(saved === "dashboard" || saved === "connections" ? saved : "dashboard");\n  document.querySelectorAll(".tab-btn").forEach(function (btn) {\n  if (btn.dataset.bound === "1") return;\n  btn.dataset.bound = "1";\n  btn.addEventListener("click", function () { selectTab(btn.dataset.tab); });\n  });\n  }\n  function bindDashboardEvents() {');
  parts.push('  document.querySelectorAll("tr.row").forEach((row) => {');
  parts.push('  if (row.dataset.bound === "1") return;');
  parts.push('  row.dataset.bound = "1";');
  parts.push('  row.addEventListener("click", () => {');
  parts.push('  const runId = row.dataset.run;');
  parts.push('  const detail = document.querySelector("tr.detail[data-run-detail=\\"" + CSS.escape(runId) + "\\"]");');
  parts.push('  if (detail) detail.classList.toggle("open");');
  parts.push('  });');
  parts.push('  });');
  parts.push('  const text = document.getElementById("filter-text");');
  parts.push('  const caller = document.getElementById("filter-caller");');
  parts.push('  const status = document.getElementById("filter-status");');
  parts.push('  function applyFilters() {');
  parts.push('  const q = text.value.toLowerCase().trim();');
  parts.push('  const c = caller.value;');
  parts.push('  const s = status.value;');
  parts.push('  document.querySelectorAll("tr.row").forEach((row) => {');
  parts.push('  const matchesText = !q || row.textContent.toLowerCase().includes(q);');
  parts.push('  const matchesCaller = !c || row.dataset.caller === c || (c === "unknown" && !row.dataset.caller);');
  parts.push('  const matchesStatus = !s || row.dataset.status === s;');
  parts.push('  const detail = document.querySelector("tr.detail[data-run-detail=\\"" + CSS.escape(row.dataset.run) + "\\"]");');
  parts.push('  const visible = matchesText && matchesCaller && matchesStatus;');
  parts.push('  row.style.display = visible ? "" : "none";');
  parts.push('  if (detail && !visible) detail.style.display = "none";');
  parts.push('  });');
  parts.push('  }');
  parts.push('  if (text && caller && status) {');
  parts.push('  text.addEventListener("input", applyFilters);');
  parts.push('  caller.addEventListener("change", applyFilters);');
  parts.push('  status.addEventListener("change", applyFilters);');
  parts.push('  }');
  parts.push('  }');
  parts.push('  function applyTheme(theme) {');
  parts.push('  const root = document.documentElement;');
  parts.push('  if (theme === "light") root.setAttribute("data-theme", "light");');
  parts.push('  else root.removeAttribute("data-theme");');
  parts.push('  const btn = document.getElementById("theme-btn");');
  parts.push('  if (btn) btn.textContent = theme === "light" ? "\u{1F319} Dark" : "\u2600\ufe0f Light";');
  parts.push('  }');
  parts.push('  function initTheme() {');
  parts.push('  let saved = null;');
  parts.push('  try { saved = localStorage.getItem("pi-worker-theme"); } catch (e) {}');
  parts.push('  applyTheme(saved === "light" ? "light" : "dark");');
  parts.push('  const btn = document.getElementById("theme-btn");');
  parts.push('  if (btn && !btn.dataset.bound) {');
  parts.push('  btn.dataset.bound = "1";');
  parts.push('  btn.addEventListener("click", () => {');
  parts.push('  const current = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";');
  parts.push('  const next = current === "light" ? "dark" : "light";');
  parts.push('  try { localStorage.setItem("pi-worker-theme", next); } catch (e) {}');
  parts.push('  applyTheme(next);');
  parts.push('  });');
  parts.push('  }');
  parts.push('  }');
  const bindEventsJs = parts.join('\n');
  const initJs = '  try { initTheme(); } catch (err) { console.warn("initTheme failed", err); }\n' +
  '  try { initTabs(); } catch (err) { console.warn("initTabs failed", err); }\n' +
  '  try { bindDashboardEvents(); } catch (err) { console.warn("bindDashboardEvents failed", err); }\n' +
  '  try { bindCopyButtons(); } catch (err) { console.warn("bindCopyButtons failed", err); }';
  if (!live) {
  return '<script>\n' + bindEventsJs + '\n' + initJs + '\n</script>';
  }
  const refreshJs = '  function bindRefreshButtons() {\n' +
  '  document.querySelectorAll(".panel-refresh-btn").forEach(function (refreshBtn) {\n' +
  '  if (refreshBtn.dataset.bound === "1") return;\n' +
  '  refreshBtn.dataset.bound = "1";\n' +
  '  refreshBtn.addEventListener("click", async () => {\n' +
  '  const refreshButtons = document.querySelectorAll(".panel-refresh-btn");\n' +
  '  refreshButtons.forEach(function (btn) { btn.disabled = true; });\n' +
  '  const original = refreshBtn.textContent;\n' +
  '  refreshBtn.textContent = "Refreshing\u2026";\n' +
  '  try {\n' +
  '  const fragRes = await fetch("/api/fragment", { cache: "no-store" });\n' +
  '  const fragData = await fragRes.json();\n' +
  '  if (!fragData.ok) throw new Error((fragData.error && fragData.error.message) || "fetch fragment failed");\n' +
  '  const body = document.getElementById("dashboard-body");\n' +
  '  if (body) body.innerHTML = fragData.bodyHtml;\n' +
  '  const gen = document.querySelector(".generated");\n' +
  '  if (gen) gen.innerHTML = "Generated at " + formatLocal(fragData.generatedAt) + " \u00b7 Data source <code>~/.local/state/pi-worker/runs/</code>";\n' +
  '  try { bindDashboardEvents(); } catch (err) { console.warn("bindDashboardEvents failed", err); }\n' +
  '  const connRes = await fetch("/api/connections", { cache: "no-store" });\n' +
  '  const connData = await connRes.json();\n' +
  '  if (!connData.ok) throw new Error((connData.error && connData.error.message) || "fetch connections failed");\n' +
  '  const connBody = document.getElementById("connections-body");\n' +
  '  if (connBody) connBody.innerHTML = renderClientConnectionsPanel(connData.adapters || [], connData.profiles || []);\n' +
  '  try { bindCopyButtons(); } catch (err) { console.warn("bindCopyButtons failed", err); }\n' +
  '  } catch (err) {\n' +
  '  alert("Refresh failure: " + err.message);\n' +
  '  } finally {\n' +
  '  refreshButtons.forEach(function (btn) { btn.disabled = false; });\n' +
  '  refreshBtn.textContent = original;\n' +
  '  }\n' +
  '  });\n' +
  '  });\n' +
  '  }\n' +
  '  try { bindRefreshButtons(); } catch (err) { console.warn("bindRefreshButtons failed", err); }';
  return '<script>\n' + bindEventsJs + '\n' + initJs + '\n' + refreshJs + '\n</script>';
}

export function renderDashboardHtml(states, metricsList, generatedAt, options = {}) {
  const live = options.live === true;
  const connections = options.connections ?? null;
  const fragment = renderDashboardFragment(states, metricsList, generatedAt);
  const connectionsAdapters = connections?.adapters ?? [];
  const connectionsProfiles = connections?.profiles ?? [];
  const connectionsHtml = renderConnectionsPanelHtml(connectionsAdapters, connectionsProfiles);
  const panelToolbar = live ? '<div class="panel-toolbar"><button class="panel-refresh-btn" type="button">Refresh</button></div>' : '';
  const dashboardPanel = live
  ? '<div id="dashboard-body">\n' + fragment.bodyHtml + '\n</div>'
  : fragment.bodyHtml;
  const connectionsPanel = '<div id="connections-body">\n' + connectionsHtml + '\n</div>';
  const footerNote = live ? 'Click the "Refresh" button at the top of the dashboard to fetch the latest run data.' : 'Generated by <code>pi-worker dashboard</code>. Re-run the command to refresh.';
  // CSS for the restructured header layout:
  // - Row 1 (header): menubar with tab buttons (left) and theme toggle (right)
  // - Each tab-panel has its own .titles block (h1 + generated timestamp)
  // - Per-panel toolbar: each tab panel has its own refresh button
  //  (class=panel-refresh-btn) so users refresh the panel they are viewing.
  // The old id=refresh-btn global header button was removed to fix a cascade
  // failure where bindDashboardEvents threw TypeError on null filter elements.
  const css = [
  '  :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e; --blue: #58a6ff; --green: #3fb950; --red: #f85149; --orange: #db6d28; --light: #21262d; --hover: #1f242b; --thead: #161b22; --detail-bg: #0d1117; }',
  '  [data-theme="light"] { --bg: #f6f7f9; --card: #ffffff; --border: #e1e4e8; --text: #1f2328; --muted: #636c76; --blue: #0969da; --green: #1a7f37; --red: #cf222e; --orange: #bc4c00; --light: #eaeef2; --hover: #f6f8fa; --thead: #f0f1f3; --detail-bg: #fafbfc; }',
  '  * { box-sizing: border-box; }',
  '  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); font-size: 14px; line-height: 1.5; }',
  '  header { padding: 12px 32px; }',
  '  .tab-panel .titles { margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }',
  '  h1 { margin: 0 0 4px; font-size: 22px; }',
  '  .generated { color: var(--muted); font-size: 12px; }',
  '  .menubar { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--border); }',
  '  .tabs { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }',
  '  .tab-btn { padding: 7px 14px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--text); font-size: 13px; font-weight: 500; cursor: pointer; transition: background 0.15s, color 0.15s; }',
  '  .tab-btn:hover { background: var(--hover); }',
  '  .tab-btn.active { background: var(--blue); color: #fff; border-color: var(--blue); }',
  '  [data-theme="light"] .tab-btn.active { color: #fff; }',
  ...(live ? [
  '  .panel-toolbar { display: flex; flex-direction: row; justify-content: flex-end; margin-bottom: 12px; }',
  '  .panel-refresh-btn { padding: 8px 18px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--text); font-size: 13px; font-weight: 500; cursor: pointer; transition: background 0.15s; }',
  '  .panel-refresh-btn:hover:not(:disabled) { background: var(--hover); }',
  '  .panel-refresh-btn:disabled { opacity: 0.6; cursor: wait; }',
  ] : []),
  '  .theme-btn { padding: 8px 14px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--text); font-size: 13px; font-weight: 500; cursor: pointer; transition: background 0.15s; }',
  '  .theme-btn:hover { background: var(--hover); }',
  '  main { padding: 16px 32px 64px; }',
  '  .tab-panel { display: none; }',
  '  .tab-panel.active { display: block; }',
  '  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 20px; }',
  '  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }',
  '  .card-label { color: var(--muted); font-size: 12px; margin-bottom: 6px; }',
  '  .card-value { font-size: 24px; font-weight: 600; }',
  '  .card-sub { color: var(--muted); font-size: 12px; margin-top: 4px; }',
  '  .card-badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }',
  '  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; }',
  '  .badge.blue { background: #ddf4ff; color: var(--blue); }',
  '  .badge.green { background: #dafbe1; color: var(--green); }',
  '  .badge.red { background: #ffebe9; color: var(--red); }',
  '  .badge.orange { background: #fff1e5; color: var(--orange); }',
  '  .badge.gray { background: var(--light); color: var(--muted); }',
  '  .badge.light { background: #f0f0f0; color: var(--muted); }',
  '  .badge.purple { background: #f1e8ff; color: #6f42c1; }',
  '  .badge.cyan { background: #d0f0ff; color: #0969da; }',
  '  .filters { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }',
  '  .filters input, .filters select { padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--text); font-size: 13px; }',
  '  .filters select option { background: var(--card); color: var(--text); }',
  '  .filters input { flex: 1; min-width: 200px; }',
  '  table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }',
  '  thead th { background: var(--thead); text-align: left; padding: 10px 12px; font-size: 12px; font-weight: 600; color: var(--muted); border-bottom: 1px solid var(--border); position: sticky; top: 0; }',
  '  tbody td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }',
  '  tbody tr.row { cursor: pointer; }',
  '  tbody tr.row:hover { background: var(--hover); }',
  '  tbody tr.detail { display: none; }',
  '  tbody tr.detail.open { display: table-row; }',
  '  tbody tr.detail > td { background: var(--detail-bg); padding: 16px; }',
  '  .detail-block { margin-bottom: 12px; }',
  '  .detail-label { font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em; }',
  '  .mini-table { border: 1px solid var(--border); border-radius: 6px; font-size: 12px; }',
  '  .mini-table th { background: var(--thead); padding: 6px 10px; text-align: left; font-weight: 600; }',
  '  .mini-table td { padding: 6px 10px; border-top: 1px solid var(--border); }',
  '  code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; background: var(--light); padding: 1px 6px; border-radius: 4px; }',
  '  .muted { color: var(--muted); }',
  '  .ok { color: var(--green); font-weight: 500; }',
  '  .warn { color: var(--red); font-weight: 500; }',
  '  .empty { padding: 40px; text-align: center; color: var(--muted); }',
  '  footer { padding: 16px 32px; color: var(--muted); font-size: 12px; text-align: center; }',
  '  .provider-model, .connections { margin-top: 24px; }',
  '  .provider-model h2, .connections h2 { font-size: 16px; margin: 0 0 12px; }',
  '  .hint-block { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
  '  .hint-block code { word-break: break-all; }',
  '  .copy-btn { padding: 4px 10px; border: 1px solid var(--border); border-radius: 4px; background: var(--card); color: var(--text); font-size: 12px; cursor: pointer; }',
  '  .copy-btn:hover { background: var(--hover); }',
  '  .hint-note { margin-top: 4px; font-size: 11px; color: var(--muted); }',
  ].join('\n');
  const html = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8" />',
  '<meta name="viewport" content="width=device-width, initial-scale=1" />',
  '<title>Pi Worker Dashboard</title>',
  '<style>',
  css,
  '</style>',
  '</head>',
  '<body>',
  '<header>',
  '  <nav class="menubar" aria-label="Main menu">',
  '  <div class="tabs">',
  '  <button id="tab-btn-dashboard" class="tab-btn active" type="button" data-tab="dashboard">Dashboard</button>',
  '  <button id="tab-btn-connections" class="tab-btn" type="button" data-tab="connections">Connections</button>',
  '  </div>',
  '  <button id="theme-btn" class="theme-btn" type="button" title="Toggle theme"></button>',
  '  </nav>',
  '</header>',
  '<main>',
  '  <div id="tab-dashboard" class="tab-panel active">',
  '  <div class="titles">',
  '  <h1>Pi Worker Dashboard</h1>',
  '  <div class="generated">Generated at ' + escapeHtml(formatLocal(generatedAt)) + ' \u00b7 Data source <code>~/.local/state/pi-worker/runs/</code></div>',
  '  </div>',
  panelToolbar,
  dashboardPanel,
  '  </div>',
  '  <div id="tab-connections" class="tab-panel">',
  '  <div class="titles">',
  '  <h1>Connections</h1>',
  '  </div>',
  panelToolbar,
  connectionsPanel,
  '  </div>',
  '</main>',
  '<footer>' + footerNote + '</footer>',
  dashboardScript(options),
  '</body>',
  '</html>',
  '',
  ].join('\n');
  return html;
}
