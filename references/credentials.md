# Credentials

Read this file when: adding a provider, `doctor` reports a missing credential, or you are rotating/revoking a key.

The active source of truth is `/Users/xiao9/.config/pi-worker/config.json` **for variable names only**; the values themselves never live in this repo or in that file.

## The rule

Credentials are **environment variables, nothing else**. `config.json` stores only the *name* of the variable (`apiKeyEnv`), never the secret.

Why it is enforced this way:

- `config.json` gets backed up, synced across machines, pasted into issues and screenshotted. An env var does not.
- Nothing in pi-worker writes a credential to disk. Error output passes through `redactDiagnostic()`, which has an explicit allowlist (`causeCode`, `category`, `command`, `exitCode`, `runId`, `timedOut`) — an accidental `details: { token }` is dropped rather than logged.
- Prompts travel over stdin, not argv, so the value never shows up in `ps` / `/proc/<pid>/cmdline`.

## Where to put them

**Recommended:** one file, mode 600, sourced from `~/.zshenv`.

```bash
mkdir -p ~/.config/pi-worker
touch ~/.config/pi-worker/credentials.env
chmod 600 ~/.config/pi-worker/credentials.env
```

```bash
# ~/.config/pi-worker/credentials.env
export QODERCN_PERSONAL_ACCESS_TOKEN="pat-..."
export VOLCENGINE_API_KEY="..."
export DEEPSEEK_API_KEY="..."
```

```bash
# ~/.zshenv  (append once)
[ -f "$HOME/.config/pi-worker/credentials.env" ] && . "$HOME/.config/pi-worker/credentials.env"
```

> **Use `~/.zshenv`, not `~/.zshrc`.** zsh reads `.zshenv` for *every* invocation, including the non-interactive shells that agents, CI runners, cron and `ssh host 'cmd'` use. `.zshrc` is interactive-only, which produces the most confusing failure mode there is: the key works in your terminal but `pi-worker doctor` (spawned headlessly) insists the credential is missing.
>
> Bash users: `~/.bash_profile` is login-only and `~/.bashrc` is interactive-only. Source the file from both, or export directly in the process that launches the worker.

Alternatives that are also fine: a real secret manager (`op run`, `direnv`, vault) as long as the variable ends up in the worker's environment. Do **not** put the value in `config.json`, a `.env` committed next to the code, or the `env` block of a task file.

## Variable map

| Profile | Adapter | Credential | Notes |
|---|---|---|---|
| `volcengine` | pi | `VOLCENGINE_API_KEY` | |
| `deepseek` | pi | `DEEPSEEK_API_KEY` | |
| `kimi` | pi | `KIMI_API_KEY` | |
| `minimax-cn` | pi | `MINIMAX_CN_API_KEY` | |
| `minimax-m3` | pi | `MINIMAX_CN_API_KEY` | Same key as `minimax-cn`. |
| `gemini-vision` | pi | `GOOGLE_API_KEY` | |
| `gpt-image` | pi | `OPENAI_API_KEY` | |
| `kimi-cli` | kimi | `KIMI_API_KEY` | CLI reads the same key as the Pi provider. |
| `trae-cli` | trae | `TRAE_CLI_TOKEN` | OAuth-style; see exceptions. |
| `qoder-cli` | qoder | `QODERCN_PERSONAL_ACCESS_TOKEN` | See exceptions — the obvious name is wrong. |
| `codebuddy-cli` | codebuddy | *(none)* | OAuth login only. |
| `opencode*` | opencode | *(none)* | Free-tier models. |

The name in this table must also match the `$VAR` reference in `~/.pi/agent/models.json`. A mismatch produces silent 401s; `pi-worker doctor` detects it.

## Adapter exceptions

**`qoder-cli` — the CN build only reads the CN variable name.**
`QODER_PERSONAL_ACCESS_TOKEN` (the name in the international docs at docs.qoder.com) is **silently ignored** by `qoderclicn`; the run reports `Not logged in · Please run /login`. Only `QODERCN_PERSONAL_ACCESS_TOKEN` is read and validated. Generate it at the qoder.cn account → integrations page.

Qoder's desktop client login does **not** carry over to the CLI — verified: a headless run with the real `HOME` and no PAT still returns `Not logged in`. The client stores credentials in `~/Library/Application Support/QoderCN` (Electron safeStorage, keychain `Qoder CN Safe Storage`); the CLI has its own store under `~/.qoder-cn/.auth/`.

The adapter runs the worker with an isolated `HOME`, which means interactive `/login` credentials are **not** visible to it. Only the PAT environment variable crosses the boundary. If you would rather authenticate with `/login`, the adapter has to be pointed at the real config root (`--config-dir ~/.qoder-cn`) — ask before changing that, since it gives the worker write access to your real CLI config.

**`trae-cli` — OAuth, not a plain key.** `TRAE_CLI_TOKEN` is accepted but the CLI manages its own session; `doctor` reports `credential.type: oauth` with a login hint instead of probing the variable.

**`codebuddy-cli` — OAuth only, no env var.** Install with `npm i -g @tencent-ai/codebuddy-code`, run `codebuddy` once, then `/login`. The headless copy bundled inside `WorkBuddy.app` cannot log in and is deliberately not used. An unauthenticated run exits 0, which the adapter classifies as `auth`.

**`opencode` — no credential.** The shipped profiles are free-tier models.

## Verify

```bash
pi-worker doctor --profile qoder-cli
```

A ready profile returns `{"ok":true,"status":"ready"}` with a `credential` check. A missing variable returns `DOCTOR_FAILED` naming the exact variable and the `export` line to add.

`doctor` never prints the value — it only reports presence and which variable it read.

## Rotate or revoke

1. Regenerate the token at the provider (for Qoder: qoder.cn → account → integrations; the value cannot be retrieved again after the page closes).
2. Edit `~/.config/pi-worker/credentials.env` in place.
3. Open a new shell (or `source` the file), then re-run `pi-worker doctor --profile <name>`.

Rotating mid-run does not affect a run already in flight: the worker process holds its copy of the environment.

## Never

- Put a value in `config.json`, a task file, or a commit — `alwaysForbiddenPaths` blocks `.env*`, `*credential*` and `*secret*` from the worker's own edits, but that guard does not protect you from committing by hand.
- Pass a token as a CLI argument (`--api-key sk-...`). It lands in `ps` and in shell history. pi-worker pipes prompts over stdin for the same reason.
- Paste a token into a review file, a report, or a chat message. `report.md` and `metrics.json` are generated artifacts that get shared.
