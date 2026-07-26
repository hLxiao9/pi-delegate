/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { readFile } from 'node:fs/promises';
import { installDefaultConfiguration, loadConfig, resolveWorkerPaths, selectProfile } from './config.mjs';
import { resolveAdapter } from './adapters/index.mjs';
import { loadShellProfileEnv } from './shell-profile.mjs';

// Reports whether a profile's credential is available either in process.env
// or in the user's shell profile (~/.zshrc etc.). Uses the shared
// loadShellProfileEnv so the report matches what doctor/runner actually see.
async function isCredentialAvailable(apiKeyEnv, env, home) {
  if (env[apiKeyEnv]) return true;
  const profileEnv = await loadShellProfileEnv([apiKeyEnv], { home });
  return Boolean(profileEnv[apiKeyEnv]);
}

// Build the copy-paste-ready `export` line for a missing credential. Mirrors
// the dashboard hint so init's report is consistent with the connections tab.
function buildExportHint(profile) {
  const adapter = resolveAdapter(profile);
  if (adapter.name === 'trae') {
    return `# ${profile.name} uses Trae OAuth. Run 'traecli' once interactively to complete enterprise login.`;
  }
  return `export ${profile.apiKeyEnv}=YOUR_KEY_HERE`;
}

// Readline-based yes/no prompt. Returns true only on an explicit 'y'/'yes'.
// Returns false immediately when stdin is not a TTY (non-interactive mode),
// so 'pi-worker init' is safe to run from CI / non-terminal parents.
async function promptYesNo(question, io) {
  const stdin = io?.stdin ?? process.stdin;
  const stdout = io?.stdout ?? process.stdout;
  if (!stdin.isTTY) return false;
  await new Promise((resolve) => stdout.write(question + ' [y/N] ', resolve));
  return new Promise((resolve) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes('\n')) {
        stdin.off('data', onData);
        const answer = buf.trim().toLowerCase();
        resolve(answer === 'y' || answer === 'yes');
      }
    };
    stdin.on('data', onData);
    stdin.once('end', () => resolve(false));
  });
}

// Print a block of text to the runtime stdout (defaults to process.stdout).
function print(io, text) {
  const stdout = io?.stdout ?? process.stdout;
  stdout.write(text);
}

// initCommand is the onboarding entry point. It:
//   1. Installs the default config if missing (or merges if present).
//   2. Lists all profiles with their apiKeyEnv.
//   3. Reports which profiles have credentials available (env + shell profile).
//   4. Suggests switching defaultProfile when the default is unconfigured but
//      another profile is configured (interactive prompt; non-interactive-safe).
//   5. Prints copy-paste 'export' lines when no profile is configured.
//   6. Prints a final summary (default profile, credential status, next step).
//
// The command is NON-interactive-safe: when stdin is not a TTY it just prints
// the report without prompting, so it can be safely run from CI or piped.
export async function initCommand(options = {}, runtime = {}) {
  const env = runtime.env ?? process.env;
  const paths = runtime.paths ?? resolveWorkerPaths(env);
  const io = runtime.io ?? process;

  // Step 1: ensure the config exists. installDefaultConfiguration is idempotent
  // (merges with existing config), so calling it when the config already exists
  // is a no-op for user edits.
  let configExisted = true;
  try {
    await readFile(paths.configFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') configExisted = false;
    else throw error;
  }
  if (!configExisted) {
    await installDefaultConfiguration({ paths });
    print(io, `Installed default config to ${paths.configFile}\n`);
    print(io, `Installed Volcengine provider to ${paths.modelsFile}\n`);
  } else {
    // Refresh/merge defaults so new profiles (kimi-cli, trae-cli, qoder-cli)
    // appear for users who installed an older version. User edits are preserved.
    await installDefaultConfiguration({ paths });
    print(io, `Merged default config into ${paths.configFile} (existing user edits preserved)\n`);
  }

  // Step 2: load the (now-merged) config and list all profiles.
  const config = await loadConfig(paths);
  const profileEntries = Object.entries(config.profiles)
    .map(([name, p]) => p && typeof p === 'object' ? { name, ...p } : null)
    .filter((p) => p !== null);

  // Step 3: probe credential availability for each profile.
  const home = env.HOME;
  for (const p of profileEntries) {
    p.credentialAvailable = await isCredentialAvailable(p.apiKeyEnv, env, home);
  }

  // Step 4: if the default profile is unconfigured but another is configured,
  // suggest switching defaultProfile (interactive prompt only).
  const defaultName = config.defaultProfile;
  const defaultProfile = profileEntries.find((p) => p.name === defaultName);
  const otherConfigured = profileEntries.find((p) => p.name !== defaultName && p.credentialAvailable);
  let switchedDefault = false;
  if (defaultProfile && !defaultProfile.credentialAvailable && otherConfigured) {
    print(io, `\nDefault profile '${defaultName}' is missing its credential (${defaultProfile.apiKeyEnv}),\n`);
    print(io, `but profile '${otherConfigured.name}' has its credential configured.\n`);
    const yes = await promptYesNo(`Switch defaultProfile to '${otherConfigured.name}'?`, io);
    if (yes) {
      // Write the new defaultProfile back to disk. We re-read the file (not the
      // validated config) so we don't lose fields the validator strips.
      const raw = JSON.parse(await readFile(paths.configFile, 'utf8'));
      raw.defaultProfile = otherConfigured.name;
      const { writeJsonAtomic } = await import('./atomic-json.mjs');
      await writeJsonAtomic(paths.configFile, raw);
      config.defaultProfile = otherConfigured.name;
      switchedDefault = true;
      print(io, `defaultProfile is now '${otherConfigured.name}'. Edit ${paths.configFile} to change it back.\n`);
    }
  }

  // Step 5: print the full profile list with credential status and export hints.
  print(io, '\nProfiles:\n');
  for (const p of profileEntries) {
    const status = p.credentialAvailable ? 'configured' : 'not configured';
    const tag = p.name === config.defaultProfile ? ' (default)' : '';
    print(io, `  - ${p.name}${tag}  [${p.adapter ?? 'pi'} / ${p.provider} / ${p.model}]  ${p.apiKeyEnv}  →  ${status}\n`);
    if (!p.credentialAvailable) {
      print(io, `      ${buildExportHint(p)}\n`);
    }
  }

  // Step 6: final summary — which profile is the default, whether its
  // credential is configured, and the next step (pi-worker doctor).
  const finalDefault = profileEntries.find((p) => p.name === config.defaultProfile) ?? defaultProfile;
  print(io, '\nSummary:\n');
  print(io, `  defaultProfile: ${config.defaultProfile}\n`);
  if (finalDefault) {
    print(io, `  credential:     ${finalDefault.apiKeyEnv}  (${finalDefault.credentialAvailable ? 'configured' : 'NOT configured'})\n`);
  }
  if (switchedDefault) {
    print(io, `  next step:      pi-worker doctor   (verify the new default works)\n`);
  } else if (finalDefault && !finalDefault.credentialAvailable) {
    print(io, `  next step:      add the export line above to ~/.zshrc, run 'source ~/.zshrc', then 'pi-worker doctor'\n`);
  } else {
    print(io, `  next step:      pi-worker doctor   (validates Pi, model, credentials, config)\n`);
  }

  return {
    ok: true,
    command: 'init',
    configInstalled: !configExisted,
    defaultProfile: config.defaultProfile,
    defaultCredentialConfigured: Boolean(finalDefault?.credentialAvailable),
    profileCount: profileEntries.length,
    configuredCount: profileEntries.filter((p) => p.credentialAvailable).length,
    switchedDefault,
  };
}
