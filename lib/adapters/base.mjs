/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

// Worker Adapter abstract interface.
// each CLI(pi / kimi / trae)implements a adapter, encapsulates each CLI's command-line format, 
// configuration directory structure, output parsing approach.pi-runner.mjs pass registry dispatches calls.
//
// interface contract: 
//  - all methods are pure functions(except sanitizeHome / listModels has IO)
//  - invokeCommand returned argv/env/input/cwd fed to runProcess
//  - parseOutput converts raw stdout/stderr into a unified structure { text, usage?, stopReason? }
//  - usage for null when metrics gracefully degrades(does not compute token saving rate)
export const WorkerAdapter = {
  name: 'abstract',
  defaultBin: null,  // default executable name, as 'pi' / 'kimi' / 'traecli'
  configDirName: null,  // relative to HOME directory name, as '.pi/agent' / '.kimi-code'
  configFormat: 'none',  // 'json' | 'toml' | 'none'
  supportsStreaming: false,  // true=NDJSON stream(Pi), false=one-shot text output
  supportsTokenUsage: false,  // true=output contains token usage, false=metrics degrades
  supportsModelList: false,  // true=has --list-models -like command
  minimumVersion: null,  // string like '0.80.10', doctor use

  // methods that must be implemented(subclass overrides): 
  versionCommand() { throw new Error('not implemented'); },
  invokeCommand({ state, profile, prompt, config, sessionDir, mode }) { throw new Error('not implemented'); },
  parseOutput(rawStdout, rawStderr, exitCode, timedOut) { throw new Error('not implemented'); },
  async sanitizeHome({ paths, files, profile, env }) { throw new Error('not implemented'); },
  async listModels({ paths, profile, env, bin }) { throw new Error('not implemented'); },

  // generic failure classification(based on stderr text, subclass can override)
  classifyFailure({ stderr, stdout, exitCode, timedOut }) {
  const text = `${stderr}\n${stdout}`.toLowerCase();
  if (timedOut) return 'timeout';
  if (/\b(401|403)\b|unauthori[sz]ed|invalid api.?key|authentication failed|not logged in|login required/.test(text)) return 'auth';
  if (/\b(408|409|425|429|500|502|503|504)\b|rate.?limit|econnreset|etimedout|temporar|overloaded|network/.test(text)) return 'transient';
  return 'permanent';
  },
};
