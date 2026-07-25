import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { invariant } from '../errors.mjs';
import { WorkerAdapter } from './base.mjs';

// Kimi Code CLI 配置目录 ~/.kimi-code/
// 配置文件 config.toml，凭证写在 [providers.<name>.api_key]
// 非交互模式: kimi -p "<prompt>"
// 输出:纯文本(无 token usage)
// 工具限制通过 config.toml 的 [tools] 表配置

const PASSTHROUGH_ENV = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];

function selectedEnvironment(env, kimiHome) {
  const selected = { HOME: kimiHome, KIMI_CODE_HOME: kimiHome, CI: '1', NO_COLOR: '1', KIMI_DISABLE_TELEMETRY: '1' };
  for (const name of PASSTHROUGH_ENV) if (env[name]) selected[name] = env[name];
  return selected;
}

// 生成 Kimi config.toml 内容,只包含当前 profile 用到的 provider 和 model
function buildKimiConfigToml(profile) {
  // 注意:Kimi 要求 api_key 写在 config.toml 里,不接受环境变量直接读取。
  // 但我们可以把 env 里的实际 key 值写进文件,实现等价效果。
  // profile.apiKeyEnv 是变量名(如 KIMI_API_KEY),运行时从 env 取值。
  // 这一步在 sanitizeHome 里完成(因为需要 env)。
  // 这里只返回模板,key 占位由 sanitizeHome 替换。
  const providerName = profile.provider || 'kimi';
  const modelName = profile.model;
  const modelAlias = `${providerName}/${modelName}`;
  return {
    default_model: modelAlias,
    default_permission_mode: 'yolo',  // 非交互模式必须自动批准工具调用
    default_plan_mode: false,
    telemetry: false,
    providers: {
      [providerName]: {
        type: profile.providerType || 'kimi',
        base_url: profile.baseUrl || 'https://api.kimi.com/coding/v1',
        api_key: '__KIMI_API_KEY_PLACEHOLDER__',  // 由 sanitizeHome 替换
      },
    },
    models: {
      [modelAlias]: {
        provider: providerName,
        model: modelName,
        max_context_size: profile.maxContextSize || 1048576,
        capabilities: ['thinking', 'always_thinking', 'tool_use', ...(profile.modalities?.includes('vision') ? ['image_in'] : [])],
        display_name: modelName,
        support_efforts: ['max'],
        default_effort: 'max',
      },
    },
    thinking: { enabled: true, effort: 'high', keep: 'all' },
    loop_control: { max_retries_per_step: 10, reserved_context_size: 50000 },
    permission: {
      rules: [
        { decision: 'allow', pattern: 'Read' },
        { decision: 'allow', pattern: 'Grep' },
        { decision: 'allow', pattern: 'Glob' },
        { decision: 'allow', pattern: 'Edit' },
        { decision: 'allow', pattern: 'Write' },
      ],
    },
  };
}

// 简易 TOML 序列化(只覆盖我们用到的子集:标量、数组、嵌套表、表数组)
function toToml(obj, prefix = '') {
  const lines = [];
  const topLevelKeys = Object.keys(obj).filter((k) => {
    const v = obj[k];
    return v === null || typeof v !== 'object' || Array.isArray(v);
  });
  const tableKeys = Object.keys(obj).filter((k) => {
    const v = obj[k];
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  });
  // 先输出标量
  for (const k of topLevelKeys) {
    const v = obj[k];
    if (Array.isArray(v)) {
      lines.push(`${k} = [${v.map((x) => JSON.stringify(String(x))).join(', ')}]`);
    } else if (typeof v === 'boolean') {
      lines.push(`${k} = ${v}`);
    } else if (typeof v === 'number') {
      lines.push(`${k} = ${v}`);
    } else {
      lines.push(`${k} = ${JSON.stringify(String(v))}`);
    }
  }
  // 再输出嵌套表
  for (const k of tableKeys) {
    const tablePath = prefix ? `${prefix}."${k}"` : `"${k}"`;
    lines.push('');
    lines.push(`[providers.${tablePath.replace(/^"providers"\./, '')}]`.replace(/\[(providers\.)?"([^"]+)"\]/, '[$1$2]'));
    // 简化:直接用 [k] 作为表头
    lines.pop();
    lines.push(`[${k}]`);
    lines.push(...toToml(obj[k]).split('\n'));
  }
  return lines.join('\n');
}

// 更可靠的 TOML 生成:手动构建,因为上面的通用方案对嵌套不够稳
function buildTomlManual(config) {
  const lines = [];
  // 顶层标量
  lines.push(`default_model = ${JSON.stringify(config.default_model)}`);
  lines.push(`default_permission_mode = ${JSON.stringify(config.default_permission_mode)}`);
  lines.push(`default_plan_mode = ${config.default_plan_mode}`);
  lines.push(`telemetry = ${config.telemetry}`);
  // providers
  for (const [name, prov] of Object.entries(config.providers)) {
    lines.push('');
    lines.push(`[providers.${name}]`);
    lines.push(`type = ${JSON.stringify(prov.type)}`);
    lines.push(`base_url = ${JSON.stringify(prov.base_url)}`);
    lines.push(`api_key = ${JSON.stringify(prov.api_key)}`);
  }
  // models
  for (const [alias, model] of Object.entries(config.models)) {
    lines.push('');
    lines.push(`[models.${JSON.stringify(alias)}]`.replace(/"([^"]+)"/, '$1'));
    lines.push(`provider = ${JSON.stringify(model.provider)}`);
    lines.push(`model = ${JSON.stringify(model.model)}`);
    lines.push(`max_context_size = ${model.max_context_size}`);
    lines.push(`capabilities = [${model.capabilities.map((c) => JSON.stringify(c)).join(', ')}]`);
    lines.push(`display_name = ${JSON.stringify(model.display_name)}`);
    lines.push(`support_efforts = [${model.support_efforts.map((c) => JSON.stringify(c)).join(', ')}]`);
    lines.push(`default_effort = ${JSON.stringify(model.default_effort)}`);
  }
  // thinking
  lines.push('');
  lines.push('[thinking]');
  lines.push(`enabled = ${config.thinking.enabled}`);
  lines.push(`effort = ${JSON.stringify(config.thinking.effort)}`);
  lines.push(`keep = ${JSON.stringify(config.thinking.keep)}`);
  // loop_control
  lines.push('');
  lines.push('[loop_control]');
  lines.push(`max_retries_per_step = ${config.loop_control.max_retries_per_step}`);
  lines.push(`reserved_context_size = ${config.loop_control.reserved_context_size}`);
  // permission.rules (表数组)
  for (const rule of config.permission.rules) {
    lines.push('');
    lines.push('[[permission.rules]]');
    lines.push(`decision = ${JSON.stringify(rule.decision)}`);
    lines.push(`pattern = ${JSON.stringify(rule.pattern)}`);
  }
  return lines.join('\n') + '\n';
}

export const KimiAdapter = {
  ...WorkerAdapter,
  name: 'kimi',
  defaultBin: 'kimi',
  configDirName: '.kimi-code',
  configFormat: 'toml',
  supportsStreaming: false,
  supportsTokenUsage: false,  // Kimi -p 模式不输出 token usage
  supportsModelList: false,   // Kimi 通过 /model 交互式切换,无命令行 list-models
  minimumVersion: null,       // 文档未强制最低版本

  versionCommand() {
    return { argv: ['--version'], env: {} };
  },

  invokeCommand({ state, profile, prompt, config, sessionDir, mode }) {
    // Kimi 非交互模式: kimi -p "<prompt>"
    // -p 打印响应并立即退出,适用于管道场景
    // 注意:Kimi 没有 --tools 限制,工具权限通过 config.toml 的 permission.rules 控制
    const argv = ['-p', prompt];
    return { argv, input: null, cwd: state.worktreePath };
  },

  parseOutput(rawStdout, rawStderr, exitCode, timedOut) {
    // Kimi -p 输出纯文本,无结构化事件
    // 文本中可能包含工具调用日志,我们只取最后的 assistant 文本
    const text = rawStdout.trim();
    const stopReason = exitCode === 0 ? 'stop' : (timedOut ? 'timeout' : 'error');
    // usage 为 null,metrics 会优雅降级
    return { text, usage: null, stopReason, lastAssistant: { content: text } };
  },

  async sanitizeHome({ paths, files, profile, env }) {
    // 创建隔离的 ~/.kimi-code 目录,写入只含当前 provider 的 config.toml
    const kimiHome = path.join(files.directory, 'kimi-home');
    const kimiCodeDir = path.join(kimiHome, '.kimi-code');
    await mkdir(kimiCodeDir, { recursive: true });

    // 从 env 取实际 api key 值
    const apiKeyValue = env[profile.apiKeyEnv];
    invariant(apiKeyValue, 'PI_FAILED', `Missing provider credential: ${profile.apiKeyEnv}`, { category: 'auth' });

    // 构建 config.toml
    const configObj = buildKimiConfigToml(profile);
    configObj.providers[profile.provider || 'kimi'].api_key = apiKeyValue;
    const tomlContent = buildTomlManual(configObj);
    await writeFile(path.join(kimiCodeDir, 'config.toml'), tomlContent, { mode: 0o600 });

    return { home: kimiHome, env: selectedEnvironment(env, kimiHome) };
  },

  async listModels({ paths, profile, env, bin }) {
    // Kimi 无命令行 list-models,doctor 跳过模型列表检查
    return null;
  },
};
