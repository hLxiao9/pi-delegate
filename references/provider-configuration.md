# Provider Configuration

Read this file only for setup, `doctor` failures, or a requested provider change. The active source of truth is `/Users/xiao9/.config/pi-worker/config.json`; credentials remain environment variables.

## Preflight

```bash
pi --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve --list-models
node /Users/xiao9/.agents/skills/pi-delegate/scripts/pi-worker.mjs doctor
```

Only use model IDs printed by the installed Pi version. Authentication failures stop immediately; they never trigger cross-provider fallback.

## Built-in profiles and cost tiers

The default fixture ships six profiles covering the cheap / standard / premium cost tiers plus vision and image-output modalities:

| Profile | Provider | Model | `costTier` | `strengths` | `modalities` | API key env |
|---|---|---|---|---|---|---|
| `volcengine` | `volcengine-plan` | `ark-code-latest` | `standard` | `frontend`, `backend` | `text` | `VOLCENGINE_API_KEY` |
| `deepseek` | `deepseek` | `deepseek-v4-flash` | `cheap` | `algorithm`, `systems`, `backend` | `text` | `DEEPSEEK_API_KEY` |
| `kimi` | `kimi-coding` | `kimi-for-coding` | `standard` | `refactor`, `docs`, `backend` | `text` | `KIMI_API_KEY` |
| `minimax-m3` | `minimax-cn` | `MiniMax-M3` | `premium` | `frontend`, `docs`, `backend` | `text` | `MINIMAX_CN_API_KEY` |
| `gemini-vision` | `google` | `gemini-2.5-pro` | `premium` | `docs`, `backend`, `refactor` | `text`, `vision` | `GOOGLE_API_KEY` |
| `gpt-image` | `openai` | `gpt-image-1` | `premium` | `frontend`, `docs` | `text`, `image-output` | `OPENAI_API_KEY` |

Difficulty mapping: `low` → `cheap`, `medium` → `standard`, `high` → `premium`. Within the same tier, the selector soft-matches `task.domain` (or an inferred domain from `task.goal` keywords) against `profile.strengths`. Override auto-selection with `pi-worker doctor --task TASK --profile NAME`.

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
node /Users/xiao9/.agents/skills/pi-delegate/scripts/pi-worker.mjs doctor
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
node /Users/xiao9/.agents/skills/pi-delegate/scripts/pi-worker.mjs doctor --profile PROFILE_NAME
```

Visual and image tasks are delegated to Pi only when a profile advertising the matching `modalities` is configured. If no such profile exists, the selector returns null and the parent agent should report a setup blocker (or handle the task directly). The `chatgpt-image-generations` flag on `report` remains available for tracking image generations routed through ChatGPT web outside the Pi delegation path.

---

## Multi-CLI Adapter Support (v2)

pi-delegate now supports multiple CLI backends via the **adapter** system. Each profile can specify `adapter` to route to a different CLI:

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
- Non-interactive `-p --output-format=json --yolo` mode, JSON output
- **Environment variable auth**: `QODERCN_PERSONAL_ACCESS_TOKEN`
- Supports `--allowed-tools` and `--max-turns`
- Config dir: `~/.qoder-cn/` (created per run, no config file needed — token via env var)
- No token usage (may be available via `stream-json` format in future)

### Metrics Degradation

When adapter `supportsTokenUsage = false` (Kimi/Trae/Qoder):
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
