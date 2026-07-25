import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './atomic-json.mjs';
import { loadConfig, resolveWorkerPaths, selectProfile } from './config.mjs';
import { validateSelfReviewResult, assertDelegableCapabilities } from './contracts.mjs';
import { WorkerError, invariant } from './errors.mjs';
import { git } from './git-worker.mjs';
import { runPiTurn } from './pi-runner.mjs';
import { loadRun, transition, updateRun, withRunLock } from './state.mjs';

// 构造 Pi self-review prompt。Pi 拿到自己的 diff、独立 verification 结果、
// 验收标准和约束,以及 review-policy 的 P0-P3 优先级表,生成结构化 self-review。
// 关键:Pi 仍无 shell,只能用 read/grep 工具读自己的 diff,无法伪造测试结果。
export function buildSelfReviewPrompt({ task, verification, changedFiles, diffStat, diffSha256 }) {
  const acceptanceList = task.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
  const constraintList = task.constraints.length > 0
    ? task.constraints.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
    : '  (none)';
  const changedList = changedFiles.map((f) => `  - ${f}`).join('\n');
  const statList = diffStat.map((s) => `  ${s.added}+ ${s.deleted}- ${s.path}`).join('\n');
  const verificationSummary = verification.commands.map((c) => {
    const status = c.passed ? 'PASS' : `FAIL(exit=${c.code})`;
    return `  ${status} ${c.argv.join(' ')} (${c.durationMs}ms)`;
  }).join('\n');

  return [
    'You are an implementation worker performing SELF-REVIEW on your own diff before the parent agent reviews it.',
    'The parent agent owns the final verdict; your self-review is a hint to reduce the parent token spend, not a substitute for its judgment.',
    'Be honest and precise. Lying about evidence will cause the parent to fall back to a full-diff review and cost more tokens.',
    '',
    '## Hard rules',
    '- You do NOT have a shell. Do not claim that tests pass or fail beyond what is in the verification evidence below.',
    '- Use the read/grep tools to inspect your own diff and the changed files.',
    '- For every acceptance criterion, classify it as: met (you can point to evidence), uncertain (you cannot prove it), or unmet (you know it fails).',
    '- Report any P0-P3 finding you notice in your own work using the priority table below.',
    '- The diffSha256 in your output MUST equal the value provided below.',
    '',
    '## Priority table',
    '| P0 | Data loss, credential exposure, destructive or production-critical defect |',
    '| P1 | Likely correctness/security failure in normal use |',
    '| P2 | Real edge-case regression, missing required test, contract breach, material maintainability defect |',
    '| P3 | Non-blocking preference or polish |',
    '',
    '## Task contract summary',
    `Goal: ${task.goal}`,
    `Risk: ${task.risk}`,
    `Domain: ${task.domain ?? '(not declared)'}`,
    `Required capabilities: ${task.requiredCapabilities.join(', ')}`,
    '',
    '## Acceptance criteria (judge each one)',
    acceptanceList,
    '',
    '## Constraints',
    constraintList,
    '',
    '## Independent verification (run by the parent wrapper, not you)',
    `diffSha256: ${diffSha256}`,
    `Overall passed: ${verification.passed}`,
    verificationSummary,
    '',
    '## Changed files',
    changedList,
    '',
    '## Diff stat',
    statList,
    '',
    '## Required output format',
    'Output a single JSON object matching this shape:',
    '```json',
    '{',
    '  "schemaVersion": 1,',
    '  "runId": "<the run id>",',
    '  "diffSha256": "<the diffSha256 provided above>",',
    '  "acceptanceEvidence": [',
    '    { "criterion": "<verbatim acceptance criterion text>", "status": "met|uncertain|unmet",',
    '      "evidence": [ { "file": "<relative path>", "line": <integer|null>, "note": "<short justification>" } ] }',
    '  ],',
    '  "findings": [',
    '    { "priority": "P0|P1|P2|P3", "file": "<relative path>", "line": <integer|null>,',
    '      "problem": "<what is wrong>", "requiredChange": "<what to fix>" }',
    '  ],',
    '  "uncertainCriteria": ["<criterion text that you marked uncertain or could not evidence>"],',
    '  "summary": "<one short paragraph summarizing the change and your confidence>"',
    '}',
    '```',
    'Output ONLY the JSON object. Do not wrap it in markdown fences. Do not include commentary before or after.',
  ].join('\n');
}

async function readDiffMetadata({ paths, state, env }) {
  // 复用 security.mjs 的扫描结果以保证 diffSha256 与 verification.json 一致。
  // 这里只读 git diff 的元数据(name-only + numstat),不重新计算 hash。
  const namesResult = await git(paths, state.worktreePath, ['diff', '--name-only', '-z', '--no-renames', state.workerBaseRevision], { env });
  const changedFiles = namesResult.stdout.split('\0').filter(Boolean);
  const numstatResult = await git(paths, state.worktreePath, ['diff', '--numstat', '-z', '--no-renames', state.workerBaseRevision], { env });
  const diffStat = numstatResult.stdout.split('\0').filter(Boolean).map((record) => {
    const [added, deleted, ...pathParts] = record.split('\t');
    return { added, deleted, path: pathParts.join('\t') };
  });
  return { changedFiles, diffStat };
}

function parseSelfReviewJson(raw) {
  // Pi 可能输出包含 ```json fences 的内容,或者前后带说明文字。提取首个 { ... } 块。
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch {}
  }
  const fenceMatch = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch {}
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const candidate = trimmed.slice(start, end + 1);
    try { return JSON.parse(candidate); } catch {}
  }
  throw new WorkerError('SELF_REVIEW_INVALID', 'Pi did not return a parseable JSON self-review', { rawPreview: trimmed.slice(0, 500) });
}

export async function selfReviewCommand(options = {}, runtime = {}) {
  invariant(options.id, 'CLI_USAGE', 'self-review requires --id', {}, 2);
  const env = runtime.env ?? process.env;
  const paths = runtime.paths ?? resolveWorkerPaths(env);
  return withRunLock(paths, options.id, async () => {
    const loaded = await loadRun(paths, options.id);
    invariant(['verifying', 'selfReviewing'].includes(loaded.state.status), 'STATE_INVALID', `self-review requires verifying or selfReviewing state, found ${loaded.state.status}`);
    const config = await loadConfig(paths);

    // 配置禁用 → 直接转到 reviewing,不调用 Pi
    if (!config.selfReview.enabled) {
      const updated = await updateRun(paths, options.id, (state) => transition(state, 'reviewing', { selfReviewSkipped: true, selfReviewSkipReason: 'disabled' }));
      return { runId: options.id, status: updated.state.status, skipped: true, reason: 'disabled' };
    }

    // 读取独立 verification 结果(由 verify 命令产生)
    const verification = await readJson(loaded.files.verification).catch((error) => {
      if (error.code === 'ENOENT') throw new WorkerError('STATE_INVALID', `verification.json missing; run 'verify --id ${options.id}' first`);
      throw error;
    });
    invariant(verification.passed, 'SELF_REVIEW_BLOCKED', 'Independent verification did not pass; skip self-review and revise', { verificationPassed: verification.passed });

    // diff 太小 → self-review 收益不抵成本
    if (typeof verification.security?.diffBytes === 'number' && verification.security.diffBytes < config.selfReview.minDiffBytes) {
      const updated = await updateRun(paths, options.id, (state) => transition(state, 'reviewing', { selfReviewSkipped: true, selfReviewSkipReason: 'diff-too-small', diffBytes: verification.security.diffBytes }));
      return { runId: options.id, status: updated.state.status, skipped: true, reason: 'diff-too-small', diffBytes: verification.security.diffBytes };
    }

    const diffSha256 = verification.security?.diffSha256;
    invariant(diffSha256, 'STATE_INVALID', 'verification.json is missing security.diffSha256');

    // 进入 self-reviewing(若已是 self-reviewing 则跳过 transition)
    if (loaded.state.status === 'verifying') {
      await updateRun(paths, options.id, (state) => transition(state, 'selfReviewing'));
    }

    const { changedFiles, diffStat } = await readDiffMetadata({ paths, state: loaded.state, env });
    const prompt = buildSelfReviewPrompt({
      task: loaded.task,
      verification,
      changedFiles,
      diffStat,
      diffSha256,
    });

    // 复用 runPiTurn 的 retry / fallback 逻辑,mode=self-review
    // Pi self-review 不会改文件(只用 read/grep),无需 assertDelegableCapabilities 限制 vision 等
    let piResult;
    try {
      piResult = await runPiTurn({
        paths,
        files: loaded.files,
        state: loaded.state,
        task: loaded.task,
        config,
        env,
        mode: 'self-review',
        evidence: null,
        promptOverride: prompt,
        expectJsonOutput: true,
      });
    } catch (error) {
      // self-review 失败不应阻塞整个 run;降级到 reviewing 让主控走全量 review。
      const updated = await updateRun(paths, options.id, (state) => transition(state, 'reviewing', {
        selfReviewSkipped: true,
        selfReviewSkipReason: 'pi-failed',
        selfReviewError: { code: error.code, message: error.message },
      }));
      return { runId: options.id, status: updated.state.status, skipped: true, reason: 'pi-failed', error: { code: error.code, message: error.message } };
    }

    // 解析 Pi 输出。Pi --mode json 输出 message_end 事件,message.content 是 [{type:'text', text:'...'}]。
    const content = piResult.lastAssistant?.content;
    let rawText = '';
    if (Array.isArray(content)) {
      rawText = content.filter((c) => c && typeof c.text === 'string').map((c) => c.text).join('\n');
    } else if (typeof content === 'string') {
      rawText = content;
    } else if (typeof piResult.lastAssistant?.text === 'string') {
      rawText = piResult.lastAssistant.text;
    }
    let parsed;
    try {
      parsed = parseSelfReviewJson(rawText);
    } catch (error) {
      const updated = await updateRun(paths, options.id, (state) => transition(state, 'reviewing', {
        selfReviewSkipped: true,
        selfReviewSkipReason: 'parse-failed',
        selfReviewError: { code: error.code, message: error.message },
      }));
      return { runId: options.id, status: updated.state.status, skipped: true, reason: 'parse-failed', error: { code: error.code, message: error.message } };
    }

    // runId 兜底(若 Pi 漏填)
    if (!parsed.runId) parsed.runId = loaded.state.runId;
    const selfReview = validateSelfReviewResult(parsed);

    // 一致性校验:Pi 报告的 diffSha256 必须等于 verification 的 diffSha256。
    // 不一致说明 Pi 撒谎或读到了错的 diff → 主控必须全量 review。
    const shaMismatch = selfReview.diffSha256 !== diffSha256;

    await writeJsonAtomic(loaded.files.selfReview, {
      ...selfReview,
      diffSha256Mismatch: shaMismatch,
      generatedAt: new Date().toISOString(),
      spotCheckRequired: Math.max(config.selfReview.spotCheckCount, selfReview.acceptanceEvidence.filter((e) => e.status === 'uncertain').length),
      fallbackRecommended: shaMismatch || selfReview.acceptanceEvidence.some((e) => e.status === 'unmet') || selfReview.findings.some((f) => ['P0', 'P1', 'P2'].includes(f.priority)),
    });

    const updated = await updateRun(paths, options.id, (state) => transition(state, 'reviewing', {
      selfReviewCompleted: true,
      selfReviewShaMismatch: shaMismatch,
    }));
    return {
      runId: options.id,
      status: updated.state.status,
      skipped: false,
      diffSha256Mismatch: shaMismatch,
      spotCheckRequired: Math.max(config.selfReview.spotCheckCount, selfReview.acceptanceEvidence.filter((e) => e.status === 'uncertain').length),
      fallbackRecommended: shaMismatch || selfReview.acceptanceEvidence.some((e) => e.status === 'unmet') || selfReview.findings.some((f) => ['P0', 'P1', 'P2'].includes(f.priority)),
      selfReviewFile: loaded.files.selfReview,
    };
  });
}
