# Provider Configuration

Read this file only for setup, `doctor` failures, or a requested provider change. The active source of truth is `/Users/xiao9/.config/pi-worker/config.json`; credentials remain environment variables.

## Preflight

```bash
pi --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve --list-models
node /Users/xiao9/.agents/skills/pi-delegate/scripts/pi-worker.mjs doctor
```

Only use model IDs printed by the installed Pi version. Authentication failures stop immediately; they never trigger cross-provider fallback.

## Volcengine Coding Plan

The installer merges provider `volcengine-plan` into `/Users/xiao9/.pi/agent/models.json` with endpoint `https://ark.cn-beijing.volces.com/api/coding/v3`, model `ark-code-latest`, and key reference `$VOLCENGINE_API_KEY`.

```bash
export VOLCENGINE_API_KEY='set-in-your-secret-manager-or-shell'
node /Users/xiao9/.agents/skills/pi-delegate/scripts/pi-worker.mjs doctor
```

Set `monthlyPlan.amount` to the amount actually paid (for example promotional versus normal price); do not treat a public promotion as the user's invoice.

## Additional built-in profiles

Merge one of these objects under `profiles`; retain `text`, `code`, and `tool-use` only even when the upstream model advertises image input:

```json
{
  "zai-global": {
    "provider": "zai",
    "model": "glm-5.2",
    "thinking": "high",
    "apiKeyEnv": "ZAI_API_KEY",
    "capabilities": ["text", "code", "tool-use"],
    "fallbackProfiles": [],
    "monthlyPlan": { "currency": "CNY", "amount": 0 }
  },
  "zai-china": {
    "provider": "zai-coding-cn",
    "model": "glm-5.2",
    "thinking": "high",
    "apiKeyEnv": "ZAI_CODING_CN_API_KEY",
    "capabilities": ["text", "code", "tool-use"],
    "fallbackProfiles": [],
    "monthlyPlan": { "currency": "CNY", "amount": 0 }
  },
  "kimi": {
    "provider": "kimi-coding",
    "model": "kimi-for-coding",
    "thinking": "high",
    "apiKeyEnv": "KIMI_API_KEY",
    "capabilities": ["text", "code", "tool-use"],
    "fallbackProfiles": [],
    "monthlyPlan": { "currency": "CNY", "amount": 0 }
  },
  "deepseek": {
    "provider": "deepseek",
    "model": "deepseek-v4-flash",
    "thinking": "high",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "capabilities": ["text", "code", "tool-use"],
    "fallbackProfiles": [],
    "monthlyPlan": { "currency": "CNY", "amount": 0 }
  }
}
```

Replace each zero monthly amount with the actual subscription or budget. Select the default by changing `defaultProfile`. Configure at most one `fallbackProfiles` entry and verify it independently with:

```bash
node /Users/xiao9/.agents/skills/pi-delegate/scripts/pi-worker.mjs doctor --profile PROFILE_NAME
```

The v1 worker rejects `vision-input` and `image-output` for every profile. GLM remains text-only in the registry. Screenshots and visual comparison stay in Codex/ChatGPT; image generation is routed to ChatGPT web.
