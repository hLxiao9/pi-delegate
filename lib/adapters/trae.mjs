import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { WorkerAdapter } from './base.mjs';

// Trae CLI 特点:
// - OAuth 企业登录,无法程序化预置凭证(用户需手动 traecli 首次登录)
// - 非交互模式: traecli -p "<prompt>" [--json]
// - --json 输出 JSON 数组(包含 system prompt、工具调用、执行过程、最终结果)
// - --allowed-tool 限制工具集
// - --worktree 内置 worktree(我们已自建,需禁用以避免冲突)
// - --yolo 跳过权限检查(非交互必须)
// - 无 token usage 输出
// - 无 --list-models 命令(模型通过账号体系绑定)

const PASSTHROUGH_ENV = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];

// Trae --allowed-tool 映射:把 pi 风格的工具名映射到 Trae 工具名
const TRAE_ALLOWED_TOOLS = ['Bash', 'Read', 'Grep', 'Glob', 'Edit', 'MultiEdit', 'Write'];

function selectedEnvironment(env, traeHome) {
  const selected = { HOME: traeHome, CI: '1', NO_COLOR: '1' };
  for (const name of PASSTHROUGH_ENV) if (env[name]) selected[name] = env[name];
  // Trae 用 OAuth,不需要 API key 环境变量
  return selected;
}

// 解析 traecli --json 输出
// 输出格式是 JSON 数组,每个元素是一条事件记录
// 我们需要找到最后一条 assistant 消息的文本内容
function parseTraeJsonOutput(rawStdout) {
  try {
    const arr = JSON.parse(rawStdout);
    if (!Array.isArray(arr)) return null;
    // 从后往前找 assistant 文本
    for (let i = arr.length - 1; i >= 0; i -= 1) {
      const item = arr[i];
      if (item?.role === 'assistant' && typeof item.content === 'string') {
        return item.content;
      }
      // Trae --json 格式可能用 type 字段
      if (item?.type === 'assistant' && typeof item.text === 'string') {
        return item.text;
      }
      // 或 message 嵌套
      if (item?.message?.role === 'assistant') {
        const content = item.message.content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          const text = content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
          if (text) return text;
        }
      }
    }
    // 兜底:如果 JSON 数组里没有明确 assistant 消息,取最后一个有 text/content 的
    for (let i = arr.length - 1; i >= 0; i -= 1) {
      const item = arr[i];
      if (typeof item?.text === 'string' && item.text.length > 0) return item.text;
      if (typeof item?.content === 'string' && item.content.length > 0) return item.content;
    }
    return null;
  } catch {
    return null;
  }
}

export const TraeAdapter = {
  ...WorkerAdapter,
  name: 'trae',
  defaultBin: 'traecli',
  configDirName: null,         // Trae 用 OAuth,无配置目录
  configFormat: 'none',
  supportsStreaming: false,
  supportsTokenUsage: false,   // Trae --json 不含 token usage
  supportsModelList: false,    // 无 --list-models
  minimumVersion: null,

  versionCommand() {
    return { argv: ['-v'], env: {} };
  },

  invokeCommand({ state, profile, prompt, config, sessionDir, mode }) {
    // traecli -p "<prompt>" --json --yolo --allowed-tool <tools>
    // --json: 输出 JSON 格式(含工具调用和结果)
    // --yolo: 跳过权限检查(非交互必须)
    // --allowed-tool: 限制工具集,防止 Trae 执行危险操作
    // 不用 --worktree(我们已自建 worktree 隔离)
    const argv = [
      '-p', prompt,
      '--json',
      '--yolo',
      '--allowed-tool', TRAE_ALLOWED_TOOLS.join(','),
    ];
    // session-id 用于会话隔离
    if (state.runId) {
      argv.push('--session-id', state.runId);
    }
    return { argv, input: null, cwd: state.worktreePath };
  },

  parseOutput(rawStdout, rawStderr, exitCode, timedOut) {
    // 优先尝试 --json 解析
    let text = parseTraeJsonOutput(rawStdout);
    // 兜底:如果 JSON 解析失败,直接用 stdout 文本
    if (!text) {
      text = rawStdout.trim();
    }
    const stopReason = exitCode === 0 ? 'stop' : (timedOut ? 'timeout' : 'error');
    return { text, usage: null, stopReason, lastAssistant: { content: text } };
  },

  async sanitizeHome({ paths, files, profile, env }) {
    // Trae 用 OAuth 登录,凭证存储在系统级 keychain 或 ~/.trae 目录
    // 我们不创建隔离 home(因为 OAuth token 需要复用系统级登录态)
    // 只返回一个临时目录作为 HOME(用于隔离其他状态)
    const traeHome = path.join(files.directory, 'trae-home');
    await mkdir(traeHome, { recursive: true });
    // 注意:Trae 的 OAuth token 可能在系统 keychain 里,不在 HOME 下
    // 所以这里设置 HOME 不会影响 OAuth 登录态
    return { home: traeHome, env: selectedEnvironment(env, traeHome) };
  },

  async listModels({ paths, profile, env, bin }) {
    // Trae 无 --list-models,doctor 跳过
    return null;
  },

  // Trae 特有:OAuth 预检
  // doctor 调用时如果检测到未登录,应给出明确提示
  checkAuthHint() {
    return {
      requiresManualLogin: true,
      loginCommand: 'traecli',
      loginHint: 'Trae CLI requires OAuth login. Run `traecli` once interactively to complete enterprise login before using delegation.',
    };
  },
};
