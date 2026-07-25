// Worker Adapter 抽象接口。
// 每个 CLI（pi / kimi / trae）实现一个 adapter，封装各自命令行格式、
// 配置目录结构、输出解析方式。pi-runner.mjs 通过 registry 分发调用。
//
// 接口约定：
//   - 所有方法均为纯函数（除 sanitizeHome / listModels 有 IO）
//   - invokeCommand 返回的 argv/env/input/cwd 喂给 runProcess
//   - parseOutput 把原始 stdout/stderr 解析成统一结构 { text, usage?, stopReason? }
//   - usage 为 null 时 metrics 会优雅降级（不计算 token 节省率）
export const WorkerAdapter = {
  name: 'abstract',
  defaultBin: null,           // 默认可执行文件名，如 'pi' / 'kimi' / 'traecli'
  configDirName: null,        // 相对 HOME 的目录名，如 '.pi/agent' / '.kimi-code'
  configFormat: 'none',       // 'json' | 'toml' | 'none'
  supportsStreaming: false,   // true=NDJSON 流（Pi），false=一次性文本输出
  supportsTokenUsage: false,  // true=输出含 token usage，false=metrics 降级
  supportsModelList: false,   // true=有 --list-models 之类命令
  minimumVersion: null,       // 字符串如 '0.80.10'，doctor 用

  // 必须实现的方法（子类覆盖）：
  versionCommand() { throw new Error('not implemented'); },
  invokeCommand({ state, profile, prompt, config, sessionDir, mode }) { throw new Error('not implemented'); },
  parseOutput(rawStdout, rawStderr, exitCode, timedOut) { throw new Error('not implemented'); },
  async sanitizeHome({ paths, files, profile, env }) { throw new Error('not implemented'); },
  async listModels({ paths, profile, env, bin }) { throw new Error('not implemented'); },

  // 通用失败分类（基于 stderr 文本，子类可覆盖）
  classifyFailure({ stderr, stdout, exitCode, timedOut }) {
    const text = `${stderr}\n${stdout}`.toLowerCase();
    if (timedOut) return 'timeout';
    if (/\b(401|403)\b|unauthori[sz]ed|invalid api.?key|authentication failed|not logged in|login required/.test(text)) return 'auth';
    if (/\b(408|409|425|429|500|502|503|504)\b|rate.?limit|econnreset|etimedout|temporar|overloaded|network/.test(text)) return 'transient';
    return 'permanent';
  },
};
