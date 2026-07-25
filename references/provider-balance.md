# Provider Balance Adapters

Pi CLI does not expose a subscription balance/quota query command. To show
"Pi 侧额度" (Pi-side remaining balance) in the monitoring dashboard, pi-delegate
uses a pluggable adapter pattern: each provider has an optional adapter that
calls the provider's own balance API.

## How it works

1. `pi-worker report` reads the run's profile from config.
2. If the profile has `balanceAdapter` set, `fetchProviderBalance` is called.
3. The result is stored in `metrics.json` under `pi.balance`.
4. The dashboard shows the balance in the "Pi 侧额度" column.

If no adapter is registered for the provider, the column shows `—` with a
hover tooltip explaining how to contribute one.

## Adapter contract

Each adapter is an ES module in `lib/provider-balance/<name>.mjs` that exports:

```js
export const name = 'deepseek';

/**
 * Fetch the remaining balance/quota for this provider.
 *
 * @param {Object} params
 * @param {string} params.apiKey - The provider API key from the environment.
 * @param {Object} params.config - Optional per-profile config (balanceConfig).
 * @returns {Promise<Object>} Balance snapshot.
 */
export async function fetchBalance({ apiKey, config }) {
  // Call the provider's balance API.
  const res = await fetch('https://api.example.com/v1/billing', {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  const data = await res.json();

  return {
    balance: data.remaining,       // Remaining balance (number, required)
    currency: data.currency,       // Currency code (string, optional)
    quota: data.total,             // Total quota (number, optional)
    used: data.used,               // Used amount (number, optional)
    unit: data.unit ?? 'credits',  // Unit label (string, optional, default 'credits')
  };
}
```

### Return fields

| Field      | Type   | Required | Description                         |
|------------|--------|----------|-------------------------------------|
| `balance`  | number | Yes      | Remaining balance                   |
| `currency` | string | No       | Currency code (e.g. `CNY`, `USD`)   |
| `quota`    | number | No       | Total quota (for showing `X / Y`)   |
| `used`     | number | No       | Used amount                         |
| `unit`     | string | No       | Unit label (default: `credits`)     |

If the API call fails, throw an error. `fetchProviderBalance` will catch it
and return `{ available: false, reason: error.message }`.

## Registering an adapter

1. Create `lib/provider-balance/<provider-name>.mjs` with the contract above.
2. Register it in `lib/provider-balance/index.mjs`:

```js
const ADAPTERS = {
  'deepseek': () => import('./deepseek.mjs'),
  // Add your adapter here
};
```

3. (Optional) Add a test in `tests/provider-balance.test.mjs`.

## Enabling in config

Add `balanceAdapter` to the profile in `~/.config/pi-worker/config.json`:

```json
{
  "profiles": {
    "deepseek": {
      "provider": "deepseek",
      "model": "deepseek-v4-flash",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "balanceAdapter": "deepseek",
      "balanceConfig": {
        "endpoint": "https://api.deepseek.com/user/balance"
      }
    }
  }
}
```

- `balanceAdapter` (string, optional): The adapter name. Defaults to the
  `provider` field if not set.
- `balanceConfig` (object, optional): Extra config passed to the adapter.

## Known provider APIs (for contributors)

These are starting points; verify the actual API before implementing.

| Provider       | Balance API endpoint                        | Notes                          |
|----------------|----------------------------------------------|--------------------------------|
| DeepSeek       | `GET /user/balance`                          | Returns `is_available`, balance |
| OpenAI         | `GET /v1/organization/usage`                 | Needs organization key         |
| Volcengine     | Console API                                  | Needs AK/SK signing            |
| Google         | `GET /v1/quota`                              | Per-project quota              |
| MiniMax        | `GET /v1/billing`                            | Account balance                |

## Security notes

- Adapters only receive the API key, never the full environment.
- Balance queries are best-effort: failures are caught and shown as `—`.
- Never log or persist the API key. Only the balance snapshot is stored in
  `metrics.json`.
