import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeTextAtomic } from './atomic-json.mjs';
import { resolveWorkerPaths } from './config.mjs';
import { invariant } from './errors.mjs';
import { readPiUsage } from './metrics.mjs';
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
  await writeTextAtomic(dashboardFile, renderDashboardHtml(states, metricsList, generatedAt));
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

function formatTimestamp(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'; } catch { return escapeHtml(iso); }
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
      <div class="card"><div class="card-label">总 Runs</div><div class="card-value">${summary.total}</div></div>
      <div class="card"><div class="card-label">Pi 调用次数</div><div class="card-value">${summary.totalPiRequests}</div><div class="card-sub">耗时 ${formatDuration(summary.totalPiDurationMs)}</div></div>
      <div class="card"><div class="card-label">Pi Token 总量</div><div class="card-value">${formatTokens(summary.totalPiInput + summary.totalPiOutput)}</div><div class="card-sub">入 ${formatTokens(summary.totalPiInput)} / 出 ${formatTokens(summary.totalPiOutput)}</div></div>
      <div class="card"><div class="card-label">平均节省率</div><div class="card-value">${formatPercent(summary.meanSavingRate)}</div><div class="card-sub">估算位移 ${summary.totalDisplacedCredits.toFixed(4)} credits</div></div>
      <div class="card"><div class="card-label">等价主控端 credits</div><div class="card-value">${summary.totalEquivalentCredits.toFixed(2)}</div><div class="card-sub">Pi token 按主控 rate card 折算</div></div>
      <div class="card"><div class="card-label">占${summary.subscriptionAllowance === 'weekly' ? '周' : '订阅'}额度</div><div class="card-value">${formatPercent(summary.totalSubscriptionPortion)}</div><div class="card-sub">额度 ${summary.subscriptionAllowanceCredits ?? '—'} credits（社区估算）</div></div>
      <div class="card"><div class="card-label">调用来源</div><div class="card-badges">${callerBadges || '<span class="badge light">无</span>'}</div></div>
      <div class="card"><div class="card-label">状态分布</div><div class="card-badges">${statusBadges || '<span class="badge light">无</span>'}</div></div>
    </section>`;
}

function renderRow(row) {
  const commitCell = row.commit ? `<code title="${escapeHtml(row.commit)}">${escapeHtml(row.commit.slice(0, 8))}</code>` : '<span class="muted">—</span>';
  const savingCell = row.savingRate !== null ? formatPercent(row.savingRate) : '<span class="muted">—</span>';
  const verificationCell = row.verificationPassed === null ? '<span class="muted">—</span>' : row.verificationPassed ? '<span class="ok">通过</span>' : '<span class="warn">未通过</span>';
  const transitions = row.transitions.length > 0
    ? `<div class="detail-block"><div class="detail-label">状态流转</div><table class="mini-table"><tr><th>从</th><th>到</th><th>时间</th><th>原因</th></tr>${row.transitions.map((t) => `<tr><td>${escapeHtml(t.from)}</td><td>${escapeHtml(t.to)}</td><td>${escapeHtml(t.at)}</td><td>${escapeHtml(t.reason ?? '—')}</td></tr>`).join('')}</table></div>`
    : '';
  const metrics = row.piRequests > 0
    ? `<div class="detail-block"><div class="detail-label">Pi 使用</div><table class="mini-table"><tr><th>调用次数</th><th>耗时</th><th>输入 Token</th><th>缓存读取</th><th>输出 Token</th></tr><tr><td>${row.piRequests}</td><td>${formatDuration(row.piDuration)}</td><td>${formatTokens(row.piInput)}</td><td>${formatTokens(row.piCached)}</td><td>${formatTokens(row.piOutput)}</td></tr></table></div>`
    : '';
  const credits = row.actualCredits !== null || row.displacedCredits !== null
    ? `<div class="detail-block"><div class="detail-label">成本与节省</div><table class="mini-table"><tr><th>实际主控端 credits</th><th>估算位移 credits</th><th>节省率</th><th>返工轮数</th></tr><tr><td>${escapeHtml(String(row.actualCredits ?? '—'))}</td><td>${escapeHtml(String(row.displacedCredits ?? '—'))}</td><td>${formatPercent(row.savingRate)}</td><td>${escapeHtml(String(row.revisionRounds))}</td></tr></table></div>`
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
        <td>${row.piBalanceAvailable && row.piBalance !== null ? escapeHtml(String(row.piBalance)) + (row.piBalanceCurrency ? ' ' + escapeHtml(row.piBalanceCurrency) : '') + (row.piBalanceQuota !== null ? ' / ' + escapeHtml(String(row.piBalanceQuota)) : '') : '<span class="muted" title="' + escapeHtml(row.piBalanceReason || '无适配器') + '">—</span>'}</td>
        <td>${commitCell}</td>
      </tr>
      <tr class="detail" data-run-detail="${escapeHtml(row.runId)}">
        <td colspan="13">
          ${metrics}
          ${credits}
          ${transitions}
          ${!metrics && !credits && !transitions ? '<div class="muted">无更多详情。运行 `pi-worker report --id ' + escapeHtml(row.runId) + '` 生成 metrics。</div>' : ''}
        </td>
      </tr>`;
}

function renderFilters() {
  return `
    <section class="filters">
      <input id="filter-text" type="search" placeholder="按 runId / provider / model 过滤…" />
      <select id="filter-caller"><option value="">全部来源</option><option value="trae">trae</option><option value="codex">codex</option><option value="claude-code">claude-code</option><option value="cursor">cursor</option><option value="pi-recursive">pi-recursive</option><option value="cli">cli</option><option value="unknown">unknown</option></select>
      <select id="filter-status"><option value="">全部状态</option><option value="prepared">prepared</option><option value="running">running</option><option value="verifying">verifying</option><option value="reviewing">reviewing</option><option value="revising">revising</option><option value="approved">approved</option><option value="committed">committed</option><option value="integrated">integrated</option><option value="failed">failed</option><option value="blocked">blocked</option></select>
    </section>`;
}

export function renderDashboardFragment(states, metricsList, generatedAt) {
  const summary = buildSummary(states, metricsList);
  const rows = states.map((state, index) => buildRow(state, metricsList[index]));
  const empty = rows.length === 0 ? '<p class="empty">还没有任何 run。运行 `pi-worker prepare --task <task.json>` 创建第一个。</p>' : '';
  return {
    generatedAt,
    bodyHtml: renderSummaryCards(summary) + '\n' + renderFilters() + '\n' + (empty || '<table>\n  <thead><tr><th>Run ID</th><th>创建时间</th><th>来源</th><th>状态</th><th>模型</th><th>Pi Token</th><th>Pi 耗时</th><th>等价 credits</th><th>占额度</th><th>节省率</th><th>验证</th><th>Pi 侧额度</th><th>提交</th></tr></thead>\n  <tbody>' + rows.map(renderRow).join('') + '</tbody>\n</table>'),
  };
}

function dashboardScript(options) {
  const live = options && options.live === true;
  const parts = [];
  parts.push('  function bindDashboardEvents() {');
  parts.push('    document.querySelectorAll("tr.row").forEach((row) => {');
  parts.push('      if (row.dataset.bound === "1") return;');
  parts.push('      row.dataset.bound = "1";');
  parts.push('      row.addEventListener("click", () => {');
  parts.push('        const runId = row.dataset.run;');
  parts.push('        const detail = document.querySelector("tr.detail[data-run-detail=\\"" + CSS.escape(runId) + "\\"]");');
  parts.push('        if (detail) detail.classList.toggle("open");');
  parts.push('      });');
  parts.push('    });');
  parts.push('    const text = document.getElementById("filter-text");');
  parts.push('    const caller = document.getElementById("filter-caller");');
  parts.push('    const status = document.getElementById("filter-status");');
  parts.push('    function applyFilters() {');
  parts.push('      const q = text.value.toLowerCase().trim();');
  parts.push('      const c = caller.value;');
  parts.push('      const s = status.value;');
  parts.push('      document.querySelectorAll("tr.row").forEach((row) => {');
  parts.push('        const matchesText = !q || row.textContent.toLowerCase().includes(q);');
  parts.push('        const matchesCaller = !c || row.dataset.caller === c || (c === "unknown" && !row.dataset.caller);');
  parts.push('        const matchesStatus = !s || row.dataset.status === s;');
  parts.push('        const detail = document.querySelector("tr.detail[data-run-detail=\\"" + CSS.escape(row.dataset.run) + "\\"]");');
  parts.push('        const visible = matchesText && matchesCaller && matchesStatus;');
  parts.push('        row.style.display = visible ? "" : "none";');
  parts.push('        if (detail && !visible) detail.style.display = "none";');
  parts.push('      });');
  parts.push('    }');
  parts.push('    if (text) {');
  parts.push('      text.addEventListener("input", applyFilters);');
  parts.push('      caller.addEventListener("change", applyFilters);');
  parts.push('      status.addEventListener("change", applyFilters);');
  parts.push('    }');
  parts.push('  }');
  parts.push('  function applyTheme(theme) {');
  parts.push('    const root = document.documentElement;');
  parts.push('    if (theme === "light") root.setAttribute("data-theme", "light");');
  parts.push('    else root.removeAttribute("data-theme");');
  parts.push('    const btn = document.getElementById("theme-btn");');
  parts.push('    if (btn) btn.textContent = theme === "light" ? "\u{1F319} \u6df1\u8272" : "\u2600\ufe0f \u6d45\u8272";');
  parts.push('  }');
  parts.push('  function initTheme() {');
  parts.push('    let saved = null;');
  parts.push('    try { saved = localStorage.getItem("pi-worker-theme"); } catch (e) {}');
  parts.push('    applyTheme(saved === "light" ? "light" : "dark");');
  parts.push('    const btn = document.getElementById("theme-btn");');
  parts.push('    if (btn && !btn.dataset.bound) {');
  parts.push('      btn.dataset.bound = "1";');
  parts.push('      btn.addEventListener("click", () => {');
  parts.push('        const current = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";');
  parts.push('        const next = current === "light" ? "dark" : "light";');
  parts.push('        try { localStorage.setItem("pi-worker-theme", next); } catch (e) {}');
  parts.push('        applyTheme(next);');
  parts.push('      });');
  parts.push('    }');
  parts.push('  }');
  parts.push('  initTheme();');
  const bindEventsJs = parts.join('\n');
  if (!live) {
    return '<script>\n' + bindEventsJs + '\n  bindDashboardEvents();\n</script>';
  }
  const refreshJs = '  const refreshBtn = document.getElementById("refresh-btn");\n' +
    '  if (refreshBtn) {\n' +
    '    refreshBtn.addEventListener("click", async () => {\n' +
    '      refreshBtn.disabled = true;\n' +
    '      const original = refreshBtn.textContent;\n' +
    '      refreshBtn.textContent = "\u5237\u65b0\u4e2d\u2026";\n' +
    '      try {\n' +
    '        const res = await fetch("/api/fragment", { cache: "no-store" });\n' +
    '        const data = await res.json();\n' +
    '        if (!data.ok) throw new Error((data.error && data.error.message) || "fetch failed");\n' +
    '        const body = document.getElementById("dashboard-body");\n' +
    '        if (body) body.innerHTML = data.bodyHtml;\n' +
    '        const gen = document.querySelector(".generated");\n' +
    '        if (gen) gen.innerHTML = "\u751f\u6210\u4e8e " + data.generatedAt + " \u00b7 \u6570\u636e\u6e90 <code>~/.local/state/pi-worker/runs/</code>";\n' +
    '        bindDashboardEvents();\n' +
    '      } catch (err) {\n' +
    '        alert("\u5237\u65b0\u5931\u8d25\uff1a" + err.message);\n' +
    '      } finally {\n' +
    '        refreshBtn.disabled = false;\n' +
    '        refreshBtn.textContent = original;\n' +
    '      }\n' +
    '    });\n' +
    '  }';
  return '<script>\n' + bindEventsJs + '\n  bindDashboardEvents();\n' + refreshJs + '\n</script>';
}

export function renderDashboardHtml(states, metricsList, generatedAt, options = {}) {
  const live = options.live === true;
  const fragment = renderDashboardFragment(states, metricsList, generatedAt);
  const refreshButton = live ? '<button id="refresh-btn" class="refresh-btn" type="button">\u5237\u65b0</button>' : '';
  const bodyWrapper = live
    ? '<div id="dashboard-body">\n' + fragment.bodyHtml + '\n</div>'
    : fragment.bodyHtml;
  const footerNote = live ? '\u70b9\u51fb\u53f3\u4e0a\u89d2"\u5237\u65b0"\u6309\u94ae\u62c9\u53d6\u6700\u65b0 run \u6570\u636e\u3002' : '\u7531 <code>pi-worker dashboard</code> \u751f\u6210\u3002\u91cd\u65b0\u8fd0\u884c\u4ee5\u5237\u65b0\u3002';
  const css = [
    '  :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e; --blue: #58a6ff; --green: #3fb950; --red: #f85149; --orange: #db6d28; --light: #21262d; --hover: #1f242b; --thead: #161b22; --detail-bg: #0d1117; }',
    '  [data-theme="light"] { --bg: #f6f7f9; --card: #ffffff; --border: #e1e4e8; --text: #1f2328; --muted: #636c76; --blue: #0969da; --green: #1a7f37; --red: #cf222e; --orange: #bc4c00; --light: #eaeef2; --hover: #f6f8fa; --thead: #f0f1f3; --detail-bg: #fafbfc; }',
    '  * { box-sizing: border-box; }',
    '  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; background: var(--bg); color: var(--text); font-size: 14px; line-height: 1.5; }',
    '  header { padding: 24px 32px 8px; display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }',
    '  header .titles { flex: 1; }',
    '  h1 { margin: 0 0 4px; font-size: 22px; }',
    '  .generated { color: var(--muted); font-size: 12px; }',
    '  .refresh-btn { padding: 8px 18px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--text); font-size: 13px; font-weight: 500; cursor: pointer; transition: background 0.15s; }',
    '  .refresh-btn:hover:not(:disabled) { background: var(--hover); }',
    '  .refresh-btn:disabled { opacity: 0.6; cursor: wait; }',
    '  .theme-btn { padding: 8px 14px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--text); font-size: 13px; font-weight: 500; cursor: pointer; transition: background 0.15s; }',
    '  .theme-btn:hover { background: var(--hover); }',
    '  main { padding: 16px 32px 64px; }',
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
    '  .filters input, .filters select { padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); font-size: 13px; }',
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
  ].join('\n');
  const html = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<title>Pi Worker \u76d1\u63a7\u53f0</title>',
    '<style>',
    css,
    '</style>',
    '</head>',
    '<body>',
    '<header>',
    '  <div class="titles">',
    '    <h1>Pi Worker \u76d1\u63a7\u53f0</h1>',
    '    <div class="generated">\u751f\u6210\u4e8e ' + escapeHtml(generatedAt) + ' \u00b7 \u6570\u636e\u6e90 <code>~/.local/state/pi-worker/runs/</code></div>',
    '  </div>',
    '  ' + refreshButton,
    '  <button id="theme-btn" class="theme-btn" type="button" title="\u5207\u6362\u4e3b\u9898"></button>',
    '</header>',
    '<main>',
    bodyWrapper,
    '</main>',
    '<footer>' + footerNote + '</footer>',
    dashboardScript(options),
    '</body>',
    '</html>',
    '',
  ].join('\n');
  return html;
}
