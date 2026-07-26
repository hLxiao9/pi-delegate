/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readJson } from './atomic-json.mjs';
import { resolveWorkerPaths } from './config.mjs';
import { WorkerError, invariant } from './errors.mjs';
import { buildConnectionsPayload, listRunStates, renderDashboardFragment, renderDashboardHtml } from './dashboard.mjs';
import { loadShellProfileEnv } from './shell-profile.mjs';
import { runFiles } from './state.mjs';

// Tolerant JSON reader: returns null for missing or unparseable files.
// Mirrors lib/dashboard.mjs so the server can read the config without throwing
// when the user has not yet run install-config (Fix 9 will also auto-install
// on first loadConfig call, but the server reads the raw file directly here to
// avoid pulling the full config validator into the serve path).
async function readOptionalJson(file) {
  try { return await readJson(file); } catch (error) { if (error.code === 'ENOENT') return null; if (error instanceof SyntaxError) return null; throw error; }
}
const DEFAULT_PORT = 7317;

export async function readMetricsList(paths, states) {
  const metricsList = [];
  for (const state of states) {
    const files = runFiles(paths, state.runId);
    try {
      metricsList.push(await readJson(files.metrics));
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) metricsList.push(null);
      else throw error;
    }
  }
  return metricsList;
}

export async function buildRunsPayload(paths) {
  const states = await listRunStates(paths);
  const metricsList = await readMetricsList(paths, states);
  return { generatedAt: new Date().toISOString(), states, metricsList };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

export function createRequestHandler(paths, options = {}) {
  return async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    const base = 'http://localhost:' + (options.port ?? DEFAULT_PORT);
    const url = new URL(req.url, base);
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        const payload = await buildRunsPayload(paths);
        const connections = await buildConnectionsPayload({ env: process.env, paths });
        const html = renderDashboardHtml(payload.states, payload.metricsList, payload.generatedAt, { live: true, connections });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/fragment') {
        const payload = await buildRunsPayload(paths);
        const fragment = renderDashboardFragment(payload.states, payload.metricsList, payload.generatedAt);
        sendJson(res, 200, { ok: true, ...fragment });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/runs') {
        const payload = await buildRunsPayload(paths);
        sendJson(res, 200, { ok: true, ...payload });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/connections') {
        const connections = await buildConnectionsPayload({ env: process.env, paths });
        sendJson(res, 200, { ok: true, generatedAt: new Date().toISOString(), adapters: connections.adapters, profiles: connections.profiles });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown route: ' + req.method + ' ' + url.pathname } });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: error.message } });
    }
  };
}

function openBrowser(url) {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(command, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

export async function serveCommand(options = {}, runtime = {}) {
  const env = runtime.env ?? process.env;
  const paths = runtime.paths ?? resolveWorkerPaths(env);
  // Fix 3: merge shell-profile credentials into process.env before starting the
  // server. process.env takes priority (runtime-injected values are more
  // trustworthy); shell profile is the fallback. This makes `pi-worker serve`
  // behave like start-dashboard.command (which already does the same merge in
  // bash) so the dashboard sees credentials even when launched from a
  // non-login shell (e.g., GUI double-click).
  try {
    const rawConfig = await readOptionalJson(paths.configFile);
    const allApiKeyEnvs = rawConfig?.profiles && typeof rawConfig.profiles === 'object'
      ? Object.values(rawConfig.profiles)
          .map((p) => p && typeof p === 'object' && typeof p.apiKeyEnv === 'string' ? p.apiKeyEnv : '')
          .filter((n) => n.length > 0)
      : [];
    if (allApiKeyEnvs.length > 0) {
      const profileEnv = await loadShellProfileEnv(allApiKeyEnvs, { home: env.HOME });
      for (const [name, value] of Object.entries(profileEnv)) {
        if (!process.env[name]) process.env[name] = value;
      }
    }
  } catch (error) {
    // Shell-profile merge is best-effort; never block server startup on it.
    // The dashboard will still surface 'not configured' hints per profile.
    if (env.PI_WORKER_DEBUG) process.stderr.write(`[pi-worker serve] shell-profile merge skipped: ${error?.message ?? error}\n`);
  }
  const port = Number(options.port ?? DEFAULT_PORT);
  invariant(Number.isInteger(port) && port >= 1 && port <= 65535, 'CLI_USAGE', 'Invalid port: ' + (options.port ?? DEFAULT_PORT), {}, 2);
  const server = createServer(createRequestHandler(paths, { port }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const url = 'http://localhost:' + port + '/';
  const startedAt = new Date().toISOString();
  const io = runtime.io ?? process;
  if (options.open !== 'false' && options.open !== false) {
    openBrowser(url);
  }
  io.stderr.write('[pi-worker serve] listening on ' + url + ' (Ctrl+C to stop)\n');
  io.stdout.write(JSON.stringify({ ok: true, command: 'serve', url, port, startedAt }) + '\n');
  return new Promise(() => {});
}
