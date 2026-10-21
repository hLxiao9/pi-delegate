# Provider Configuration

Read this file only for setup, `doctor` failures, or a requested provider change. The active source of truth is `/Users/xiao9/.config/pi-worker/config.json`; credentials remain environment variables — where to put them, and the per-profile variable map, live in [`credentials.md`](./credentials.md).

> **`apiKeyEnv` contract (read this first)**: the `apiKeyEnv` field in `~/.config/pi-worker/config.json` and the `$VAR` reference in `~/.pi/agent/models.json` must point to the **same** environment variable name. A mismatch (e.g., `apiKeyEnv: VOLCENGINE_API_KEY` in config but `$API_KEY` in models.json) causes silent 401s at run time. `spot doctor` detects this and suggests the correct name. The nine built-in profiles each pin a specific `apiKeyEnv`; if you rename one, update both files.

## Preflight

```bash
pi --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve --list-models
node /Users/xiao9/.agents/skills/spotworkers/scripts/spot.mjs doctor
```

Only use model IDs printed by the installed Pi version. Authentication failures stop immediately; they never trigger cross-provider fallback.

## Built-in profiles and cost tiers

The default fixture ships nine profiles covering the cheap / standard / premium cost tiers, vision and image-output modalities, and three alternate-CLI adapters (Kimi Code CLI, Trae CLI, Qoder CLI):

| Profile | Provider | Model | `costTier` | `strengths` | `modalities` | API key env |
|---|---|---|---|---|---|---|
| `volcengine` | `volcengine-plan` | `ark-code-latest` | `standard` | `frontend`, `backend` | `text` | `VOLCENGINE_API_KEY` |
| `deepseek` | `deepseek` | `deepseek-v4-flash` | `cheap` | `algorithm`, `systems`, `backend` | `text` | `DEEPSEEK_API_KEY` |
| `kimi` | `kimi-coding` | `kimi-for-coding` | `standard` | `refactor`, `docs`, `backend` | `text` | `KIMI_API_KEY` |
| `minimax-m3` | `minimax-cn` | `MiniMax-M3` | `premium` | `frontend`, `docs`, `backend` | `text` | `MINIMAX_CN_API_KEY` |
| `gemini-vision` | `google` | `gemini-2.5-pro` | `premium` | `docs`, `backend`, `refactor` | `text`, `vision` | `GOOGLE_API_KEY` |
| `gpt-image` | `openai` | `gpt-image-1` | `premium` | `frontend`, `docs` | `text`, `image-output` | `OPENAI_API_KEY` |
| `kimi-cli` | `kimi` | `kimi-for-coding` | `standard` | `refactor`, `docs`, `backend` | `text` | `KIMI_API_KEY` |
| `trae-cli` | `trae` | `trae-default` | `premium` | `frontend`, `backend`, `systems` | `text` | `TRAE_CLI_TOKEN` (OAuth) |
| `qoder-cli` | `qoder` | `qoder-default` | `standard` | `frontend`, `backend`, `docs` | `text` | `QODERCN_PERSONAL_ACCESS_TOKEN` |

Difficulty mapping: `low` → `cheap`, `medium` → `standard`, `high` → `premium`. Within the same tier, the selector soft-matches `task.domain` (or an inferred domain from `task.goal` keywords) against `profile.strengths`. Override auto-selection with `spot doctor --task TASK --profile NAME`.

## Capability dimensions

Each profile carries three orthogonal dimensions so the selector can route by both cost and fit:

| Field | Type | Required | Purpose |
|---|---|---|---|
| `costTier` | `'cheap' \| 'standard' \| 'premium'` | optional | Matches task difficulty (low / medium / high). |
| `strengths` | `string[]` | optional | Domains the model is strong at. Values: `frontend`, `backend`, `systems`, `algorithm`, `refactor`, `docs`. Soft-matched: a hit wins the tier; a miss falls back to the first candidate in the tier. |
| `modalities` | `string[]` | optional, default `['text']` | Input/output modalities. Values: `text`, `vision`, `image-output`. Hard-matched when a task requires `vision-input` or `image-output`: the selector only routes to profiles whose `modalities` includes the matching value. |

The task side mirrors this with an optional `domain` field on the task contract (one of the `strengths` values). If `domain` is omitted, the selector infers it from `task.goal` keywords (e.g. "React component" → `frontend`, "API endpoint" → `backend`, "refactor the module" → `refactor`).

## Mainstream model capability reference

The selector only ever picks among the profiles you actually configure. This table is a reference for the Pi ecosystem's mainstream models so you can fill in `costTier` / `strengths` / `modalities` accurately when adding a profile. It is **not** a list of models the skill assumes exist — your `~/.pi/agent/models.json` and `config.json` are the only source of truth at dispatch time.

### International frontier (premium tier)

| Model | Typical `costTier` | Recommended `strengths` | `modalities` | Notes |
|---|---|---|---|---|
| `claude-opus-4` / `claude-opus-4.1` | `premium` | `refactor`, `systems`, `backend` | `text`, `vision` | Strong on large refactors and systems code; Anthropic provider. |
| `claude-sonnet-4` / `sonnet-4.5` | `standard` | `frontend`, `backend`, `docs` | `text`, `vision` | Balanced default for most coding tasks. |
| `gpt-5` / `gpt-5.1` | `premium` | `algorithm`, `systems`, `backend` | `text`, `vision` | Strong reasoning; OpenAI provider. |
| `gpt-4o` / `gpt-4.1` | `standard` | `frontend`, `backend` | `text`, `vision` | General-purpose. |
| `o3` / `o4-mini` | `premium` | `algorithm`, `systems` | `text` | Reasoning-heavy; no image output. |
| `gemini-2.5-pro` | `premium` | `docs`, `backend`, `refactor` | `text`, `vision` | Long context; Google provider. |
| `gemini-2.5-flash` | `cheap` | `frontend`, `docs` | `text`, `vision` | Cheap tier default. |

### Chinese coding models

| Model | Typical `costTier` | Recommended `strengths` | `modalities` | Notes |
|---|---|---|---|---|
| `MiniMax-M3` | `premium` | `frontend`, `docs`, `backend` | `text` | Strong creative / frontend. |
| `MiniMax-M2.7` | `standard` | `frontend`, `backend` | `text` | Mid-tier. |
| `ark-code-latest` (Volcengine) | `standard` | `frontend`, `backend` | `text` | ByteDance coding plan. |
| `deepseek-v4` | `standard` | `algorithm`, `systems`, `backend` | `text` | Strong reasoning. |
| `deepseek-v4-flash` | `cheap` | `algorithm`, `systems`, `backend` | `text` | Cheap tier default. |
| `kimi-for-coding` (Moonshot) | `standard` | `refactor`, `docs`, `backend` | `text` | Long context, good for refactors. |
| `glm-4.6` / `glm-5` (Zhipu) | `standard` | `backend`, `systems` | `text` | GLM models are text-only; do not declare `vision-input`/`image-output` unless the specific model supports it. |
| `glm-4-flash` | `cheap` | `backend`, `docs` | `text` | Cheap tier. |
| `qwen-coder` / `qwen3-coder` (Alibaba) | `standard` | `backend`, `systems`, `algorithm` | `text` | Strong on systems / algorithm. |
| `qwen-coder-flash` | `cheap` | `backend`, `docs` | `text` | Cheap tier. |
| `doubao-pro` (ByteDance) | `standard` | `frontend`, `backend` | `text` | General. |

### Open-source / self-hosted

| Model | Typical `costTier` | Recommended `strengths` | `modalities` | Notes |
|---|---|---|---|---|
| `llama-3.3-70b` / `llama-4` | `cheap` | `backend`, `docs` | `text` | Via OpenAI-compatible endpoint (vLLM / Ollama / Together). |
| `qwen2.5-coder-32b` | `cheap` | `backend`, `systems` | `text` | Self-hostable. |
| `deepseek-r1-distill` | `cheap` | `algorithm` | `text` | Reasoning distill. |
| `mistral-large` | `standard` | `backend`, `systems` | `text` | Via Mistral / OpenRouter. |

### Specialty (image / multimodal)

| Model | Typical use | `modalities` | Notes |
|---|---|---|---|
| `gpt-image-1` / `dall-e-3` | Image generation | `text`, `image-output` | Delegated to Pi when a profile with `image-output` modality is configured. |
| `gemini-2.5-pro` (vision) | Image input analysis | `text`, `vision` | Delegated to Pi when a profile with `vision` modality is configured. |
| `claude-sonnet-4` / `opus-4` (vision) | Image input + code | `text`, `vision` | Anthropic vision-capable models. |

## Volcengine Coding Plan

The installer merges provider `volcengine-plan` into `/Users/xiao9/.pi/agent/models.json` with endpoint `https://ark.cn-beijing.volces.com/api/coding/v3`, model `ark-code-latest`, and key reference `$VOLCENGINE_API_KEY`.

```bash
export VOLCENGINE_API_KEY='set-in-your-secret-manager-or-shell'
node /Users/xiao9/.agents/skills/spotworkers/scripts/spot.mjs doctor
```

Set `monthlyPlan.amount` to the amount actually paid (for example promotional versus normal price); do not treat a public promotion as the user's invoice.

## Adding or editing profiles

Merge one of these objects under `profiles`; retain `text`, `code`, and `tool-use` only even when the upstream model advertises image input. Set `costTier` so the auto-selector can match difficulty; set `strengths` so it can match domain:

```json
{
  "zai-global": {
    "provider": "zai",
    "model": "glm-5.2",
    "thinking": "high",
    "apiKeyEnv": "ZAI_API_KEY",
    "capabilities": ["text", "code", "tool-use"],
    "fallbackProfiles": [],
    "costTier": "standard",
    "strengths": ["backend", "systems"],
    "modalities": ["text"],
    "monthlyPlan": { "currency": "CNY", "amount": 0 }
  },
  "qwen-flash": {
    "provider": "qwen-token-plan-cn",
    "model": "qwen-coder-flash",
    "thinking": "high",
    "apiKeyEnv": "QWEN_TOKEN_PLAN_CN_API_KEY",
    "capabilities": ["text", "code", "tool-use"],
    "fallbackProfiles": [],
    "costTier": "cheap",
    "strengths": ["backend", "docs"],
    "modalities": ["text"],
    "monthlyPlan": { "currency": "CNY", "amount": 0 }
  }
}
```

Replace each zero monthly amount with the actual subscription or budget. Select the default by changing `defaultProfile`. Configure at most one `fallbackProfiles` entry and verify it independently with:

```bash
node /Users/xiao9/.agents/skills/spotworkers/scripts/spot.mjs doctor --profile PROFILE_NAME
```

Visual and image tasks are delegated to Pi only when a profile advertising the matching `modalities` is configured. If no such profile exists, the selector returns null and the parent agent should report a setup blocker (or handle the task directly). The `chatgpt-image-generations` flag on `report` remains available for tracking image generations routed through ChatGPT web outside the Pi delegation path.

---

## Multi-CLI Adapter Support (v2)

spotworkers now supports multiple CLI backends via the **adapter** system. Each profile can specify `adapter` to route to a different CLI:

| Adapter | CLI Binary | Auth Method | Streaming | Token Usage | Model List |
|---|---|---|---|---|---|
| `pi` (default) | `pi` | env var + models.json | NDJSON stream | yes | `--list-models` |
| `kimi` | `kimi` | config.toml (env var value) | text | no | no |
| `trae` | `traecli` | OAuth (manual login) | JSON | no | no |
| `qoder` | `qoderclicn` | `QODERCN_PERSONAL_ACCESS_TOKEN` env var | JSON | no | no |

### Adapter Selection

Profile-level `adapter` field (optional, defaults to `pi`):

```json
{
  "kimi-cli": {
    "adapter": "kimi",
    "provider": "kimi",
    "model": "kimi-for-coding",
    "apiKeyEnv": "KIMI_API_KEY",
    "providerType": "kimi",
    "baseUrl": "https://api.kimi.com/coding/v1",
    "maxContextSize": 1048576,
    "costTier": "standard",
    "strengths": ["refactor", "docs", "backend"],
    "modalities": ["text"],
    "capabilities": ["text", "code", "tool-use"],
    "fallbackProfiles": [],
    "monthlyPlan": { "currency": "CNY", "amount": 0 }
  }
}
```

### CLI Binary Resolution

Priority: `PI_WORKER_<ADAPTER>_BIN` env var > adapter `defaultBin`.

```bash
# Override binary path
export PI_WORKER_KIMI_BIN=/usr/local/bin/kimi
export PI_WORKER_TRAE_BIN=/opt/homebrew/bin/traecli
export PI_WORKER_QODER_BIN=/usr/local/bin/qoderclicn
```

### Adapter-Specific Notes

#### Pi (default)
- NDJSON streaming with `message_end` events
- Full token usage tracking (input/output/cached/reasoning)
- Model availability checked via `--list-models`
- Isolated `~/.pi/agent/models.json` per run

#### Kimi
- Non-interactive `-p` mode, text output
- **No token usage** — metrics gracefully degrade (saving rate = null, recommendation = `no-usage-data-available`)
- Generates isolated `~/.kimi-code/config.toml` per run with only the selected provider
- API key from env var is written into `config.toml` (Kimi requires this)
- No `--list-models` command — model availability checked at runtime only
- Extra profile fields: `providerType`, `baseUrl`, `maxContextSize`

#### Trae
- Non-interactive `-p --json --yolo` mode, JSON array output
- **OAuth authentication** — user must run `traecli` interactively once to complete enterprise login
- Doctor reports `credential.type: oauth` with login hint instead of checking env var
- No config file generation (OAuth token in system keychain)
- `--allowed-tool` restricts tool set; `--worktree` is NOT used (we provide our own git worktree isolation)
- No token usage

#### Qoder
- Non-interactive `-p --output-format=json --yolo` mode, single JSON object output
- **Environment variable auth**: `QODERCN_PERSONAL_ACCESS_TOKEN` — the CN build silently ignores the international `QODER_PERSONAL_ACCESS_TOKEN`
- **Pricing comes from the cloud catalog, not the CLI**: `GET https://api.qoder.com.cn/api/v1/cloud/models` (Bearer PAT) returns `price_factor`, `efforts`, `available_context_windows` and `max_input_tokens` per model. Cached to `~/.cache/pi-worker/qoder-models.json` for 30 minutes with a schema version; `invokeCommand` reads that cache synchronously, `sanitizeHome` refreshes it, and every failure mode degrades to "no catalog" rather than a failed run.
- **`--list-models` is not used for enumeration**: it prints a bare name column (no price, no tiers) and requires an interactive login. The API path also makes `spot detect` work for Qoder, which used to report `0 model(s)`.
- **Free-model alias**: `model: "free"` (also `qoder-free`, `cheapest`) resolves at dispatch time to the lowest `price_factor` model the account can reach, currently `DeepSeek-Flash` (ties on price and window with `Qwen3.8-Flash`; the name breaks the tie so the pick is stable). `qoder-cli` ships with this alias, so a delisted model never breaks the profile.
- **Per-model capability validation**: `efforts` and `available_context_windows` differ per model — `DeepSeek-Flash` accepts `low|high|max` while `Qwen3.8-Flash` accepts `low|medium|xhigh`. A requested effort outside that set is snapped to its nearest legal neighbour, and a context window outside the published tiers (200K / 400K / 1M) is rounded **down** to the largest tier that still satisfies it. Both adjustments are recorded as `worker_warning` events and echoed into `worker.log`, never applied silently.
- **Observed roster and multipliers** (2026-10; do not hardcode — the catalog changes weekly, `spot detect` prints the live table): `DeepSeek-Flash` 0x, `Qwen3.8-Flash` 0x, `GLM-5.3-Flash` / `MiniMax-M3.1-Flash` / `Qwen3.7-Plus` 0.1x, `Auto` / `Qwen3.8-Max` / `DeepSeek-V4-Pro` 0.5x, `Fast` / `GLM-5.3` / `Kimi-K2.8-Preview` 0.8x, `Kimi-K3` 1.4x.
- **Model pinning**: `prepare --model <display name>` forwards `-m`. The catalog `id` (`qfmodel`, `dfmodel`) is accepted too and translated, but `-m` itself wants the display name.
- **Thinking depth**: `--reasoning-effort` takes `auto | none | low | medium | high | xhigh | max | ultracode` ("extra high" is `xhigh`; `max` and `ultracode` go further). Set `reasoningEffort` on the profile, or override a single run with `PI_WORKER_QODER_REASONING_EFFORT=xhigh`.
- **Context window**: `--context-window <tokens>`, a positive integer (`1000000` = 1M). Set `maxContextSize` on the profile, or `PI_WORKER_QODER_CONTEXT_WINDOW=1000000`. Verified: for the same prompt, the reported `context_usage_ratio` drops from `0.117` (default window) to `0.024` (1M), i.e. the window really widened.
- **No token usage — credits instead**: every `usage.*_tokens` counter returns `0` and billing lands in `total_credits`, surfaced as `totalCredits` in metrics and `report.md`. A `price_factor: 0` model still reports credits consumed (the counter exists even when the rate is zero) — read the multiplier, not the credit count, to know whether a run was free.
- `--thinking enabled` requires `--thinking-budget <tokens>`. The adapter never passes `--thinking`; use `--reasoning-effort` for depth control instead.
- Config dir: `~/.qoder-cn/`, isolated per run via `HOME`; the PAT crosses the sandbox boundary, interactive `/login` credentials do not (see `credentials.md`).

### Metrics Degradation

When adapter `supportsTokenUsage = false` (Kimi/Trae):
- `metrics.pi.usage` = `null`
- `metrics.pi.usageAvailable` = `false`
- `metrics.counterfactual.estimatedCreditSavingRate` = `null`
- `metrics.counterfactual.label` = `unavailable-no-usage`
- Cohort recommendation becomes `no-usage-data-available` when all recent runs lack usage

### Fallback Across Adapters

Fallback profiles can use different adapters. For example, primary `kimi-cli` (Kimi adapter) with fallback to `deepseek` (Pi adapter):

```json
{
  "kimi-cli": {
    "adapter": "kimi",
    "fallbackProfiles": ["deepseek"],
    ...
  }
}
```

The runner resolves the adapter per-profile, so cross-adapter fallback works seamlessly.
