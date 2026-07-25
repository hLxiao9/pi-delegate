import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { WorkerAdapter } from './base.mjs';

// Qoder CN CLI 特点:
// - 支持 Personal Access Token 环境变量认证:QODERCN_PERSONAL_ACCESS_TOKEN
// - 非交互模式: qoderclicn -p "<prompt>" --output-format=json --yolo
// - --output-format 支持 text / json / stream-json
// - --allowed-tools 限制工具集(逗号分隔)
// - --max-turns 限制对话轮数
// - 配置目录: ~/.qoder-cn/
// - 无 --list-models 命令(模型通过账号体系绑定)
// - json 输出格式暂不确定是否含 token usage,先按无 usage 处理

const PASSTHROUGH_ENV = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];

// Qoder 工具名映射(大写首字母,和 Trae 类似)
const QODER_ALLOWED_TOOLS = ['Read', 'Write', 'Grep', 'Glob', 'Edit', 'MultiEdit'];

function selectedEnvironment(env, qoderHome, profile) {
  const selected = { HOME: qoderHome, CI: '1', NO_COLOR: '1' };
  for (const name of PASSTHROUGH_ENV) if (env[name]) selected[name] = env[name];
  // Qoder 用环境变量认证
  const tokenEnv = profile.apiKeyEnv || 'QODERCN_PERSONAL_ACCESS_TOKEN';
  if (env[tokenEnv]) selected[tokenEnv] = env[tokenEnv];
  return selected;
}

// 解析 qoderclicn --output-format=json 输出
// 输出格式可能是 JSON 数组或单个 JSON 对象
function parseQoderJsonOutput(rawStdout) {
  try {
    const parsed = JSON.parse(rawStdout);
    if (Array.isArray(parsed)) {
      // 从后往前找 assistant 文本
      for (let i = parsed.length - 1; i >= 0; i -= 1) {
        const item = parsed[i];
        if (item?.role === 'assistant' && typeof item.content === 'string') return item.content;
        if (item?.type === 'assistant' && typeof item.text === 'string') return item.text;
        if (item?.message?.role === 'assistant') {
          const content = item.message.content;
          if (typeof content === 'string') return content;
          if (Array.isArray(content)) {
            const text = content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
            if (text) return text;
          }
        }
      }
      // 兜底
      for (let i = parsed.length - 1; i >= 0; i -= 1) {
        const item = parsed[i];
        if (typeof item?.text === 'string' && item.text.length > 0) return item.text;
        if (typeof item?.content === 'string' && item.content.length > 0) return item.content;
      }
    } else if (typeof parsed === 'object' && parsed !== null) {
      // 单个 JSON 对象
      if (typeof parsed.content === 'string') return parsed.content;
      if (typeof parsed.text === 'string') return parsed.text;
      if (parsed.message?.role === 'assistant') {
        const content = parsed.message.content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          return content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

export const QoderAdapter = {
  ...WorkerAdapter,
  name: 'qoder',
  defaultBin: 'qoderclicn',
  configDirName: '.qoder-cn',
  configFormat: 'json',
  supportsStreaming: false,       // 支持 stream-json 但格式未确认,先用 json 模式
  supportsTokenUsage: false,      // json 输出格式待确认是否含 usage
  supportsModelList: false,
  minimumVersion: null,

  versionCommand() {
    return { argv: ['--version'], env: {} };
  },

  invokeCommand({ state, profile, prompt, config, sessionDir, mode }) {
    // qoderclicn -p "<prompt>" --output-format=json --yolo --allowed-tools=<tools> --max-turns=<N>
    const argv = [
      '-p', prompt,
      '--output-format=json',
      '--yolo',
      '--allowed-tools', QODER_ALLOWED_TOOLS.join(','),
    ];
    // max-turns 限制防止无限循环
    if (config.limits?.piMaxTurns) {
      argv.push('--max-turns', String(config.limits.piMaxTurns));
    }
    return { argv, input: null, cwd: state.worktreePath };
  },

  parseOutput(rawStdout, rawStderr, exitCode, timedOut) {
    // 优先尝试 JSON 解析
    let text = parseQoderJsonOutput(rawStdout);
    // 兜底:JSON 解析失败时直接用 stdout 文本
    if (!text) {
      text = rawStdout.trim();
    }
    const stopReason = exitCode === 0 ? 'stop' : (timedOut ? 'timeout' : 'error');
    return { text, usage: null, stopReason, lastAssistant: { content: text } };
  },

  async sanitizeHome({ paths, files, profile, env }) {
    // 创建隔离的 ~/.qoder-cn 目录
    // Qoder 的认证 token 通过环境变量传递,不需要写配置文件
    const qoderHome = path.join(files.directory, 'qoder-home');
    const qoderCnDir = path.join(qoderHome, '.qoder-cn');
    await mkdir(qoderCnDir, { recursive: true });
    return { home: qoderHome, env: selectedEnvironment(env, qoderHome, profile) };
  },

  async listModels({ paths, profile, env, bin }) {
    // Qoder 无 --list-models 命令
    return null;
  },
};
