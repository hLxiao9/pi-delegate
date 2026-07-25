import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { invariant } from '../errors.mjs';
import { WorkerAdapter } from './base.mjs';

// Pi 专有工具集和禁用标志
const PI_TOOLS = 'read,grep,find,ls,edit,write';
const PI_DISABLE_FLAGS = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve'];

// passthrough 环境变量白名单
const PASSTHROUGH_ENV = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];

function selectedEnvironment(env, profile, piHome) {
  const selected = { HOME: piHome, CI: '1', NO_COLOR: '1' };
  for (const name of PASSTHROUGH_ENV) if (env[name]) selected[name] = env[name];
  selected[profile.apiKeyEnv] = env[profile.apiKeyEnv];
  return selected;
}

async function createSanitizedPiHome(paths, files, profile) {
  const models = JSON.parse(await readFile(paths.modelsFile, 'utf8'));
  const provider = models.providers?.[profile.provider];
  invariant(provider, 'CONFIG_INVALID', `Provider missing from models.json: ${profile.provider}`);
  const expectedKeys = [`$${profile.apiKeyEnv}`, '${' + profile.apiKeyEnv + '}'];
  invariant(expectedKeys.includes(provider.apiKey), 'CONFIG_INVALID', 'Selected provider must resolve its key from the selected environment variable');
  const piHome = path.join(files.directory, 'pi-home');
  const agentDir = path.join(piHome, '.pi', 'agent');
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, 'models.json'), `${JSON.stringify({ providers: { [profile.provider]: provider } }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(agentDir, 'settings.json'), '{"quietStartup":true}\n', { mode: 0o600 });
  return piHome;
}

export const PiAdapter = {
  ...WorkerAdapter,
  name: 'pi',
  defaultBin: 'pi',
  configDirName: '.pi/agent',
  configFormat: 'json',
  supportsStreaming: true,
  supportsTokenUsage: true,
  supportsModelList: true,
  minimumVersion: '0.80.10',

  versionCommand() {
    return { argv: ['--version'], env: {} };
  },

  invokeCommand({ state, profile, prompt, config, sessionDir, mode }) {
    // 注意:实际调用时 env 会在 pi-runner 里合并 HOME/passthrough/apiKeyEnv
    // 这里只返回 argv；env 由 sanitizeHome 返回的 home + selectedEnvironment 组合
    const argv = [
      '--mode', 'json', '--provider', profile.provider, '--model', profile.model,
      '--thinking', profile.thinking ?? 'high', '--session-dir', sessionDir, '--session-id', state.runId,
      '--tools', PI_TOOLS, ...PI_DISABLE_FLAGS,
    ];
    return { argv, input: prompt, cwd: state.worktreePath };
  },

  // Pi 是流式 NDJSON,parseOutput 不用于主流程(主流程用 onStdoutLine 逐行解析)
  // 但保留一个 fallback 用于非流式场景
  parseOutput(rawStdout, rawStderr, exitCode, timedOut) {
    // 尝试从 stdout 中提取最后一个 message_end 事件
    const lines = rawStdout.split('\n').filter(Boolean);
    let lastAssistant = null;
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'message_end' && event.message?.role === 'assistant') lastAssistant = event.message;
      } catch {}
    }
    const text = Array.isArray(lastAssistant?.content)
      ? lastAssistant.content.filter((c) => c?.text).map((c) => c.text).join('\n')
      : (lastAssistant?.content ?? '');
    const usage = lastAssistant?.usage
      ? {
          inputTokens: lastAssistant.usage.input ?? 0,
          cachedInputTokens: lastAssistant.usage.cacheRead ?? 0,
          cacheWriteInputTokens: lastAssistant.usage.cacheWrite ?? 0,
          outputTokens: lastAssistant.usage.output ?? 0,
          reasoningOutputTokens: lastAssistant.usage.reasoning ?? 0,
          totalTokens: lastAssistant.usage.totalTokens ?? 0,
          providerReportedCostUsd: lastAssistant.usage.cost?.total ?? 0,
          requests: 1,
          durationMs: 0,
        }
      : null;
    const stopReason = lastAssistant?.stopReason ?? (exitCode === 0 ? 'stop' : 'error');
    return { text, usage, stopReason, lastAssistant };
  },

  async sanitizeHome({ paths, files, profile, env }) {
    const piHome = await createSanitizedPiHome(paths, files, profile);
    return { home: piHome, env: selectedEnvironment(env, profile, piHome) };
  },

  async listModels({ paths, profile, env, bin }) {
    // 复用 doctor 的 list-models 逻辑
    return {
      argv: [...PI_DISABLE_FLAGS, '--list-models', `${profile.provider}/${profile.model}`],
      env: { ...env },
      parse: (stdout) => stdout.includes(profile.model),
    };
  },
};
