# Security Policy

## Supported versions

pi-delegate is pre-1.0. Security fixes are applied to the latest `main` branch only; there are no backport branches yet. Once a stable 1.0 is cut, this section will list which minor lines receive fixes.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report vulnerabilities privately using one of:

1. **GitHub Security Advisories** (preferred): go to <https://github.com/hLxiao9/pi-delegate/security/advisories/new> and submit a private advisory. This lets us collaborate on a fix and publish a CVE together.
2. **Email**: send a description and reproduction to the maintainer. (Open an issue titled "security contact request" if you need the address — do **not** put vulnerability details in the issue.)

Please include:
- A clear description of the issue and its impact
- Steps to reproduce (commands, task JSON, config snippets — redact real API keys)
- Affected versions / commit
- Suggested fix if you have one

## Response timeline

- **Acknowledgement**: within 72 hours.
- **Initial assessment**: within 7 days.
- **Fix or mitigation**: target 30 days for medium/high severity; faster for critical.

## Security model (what pi-delegate is and is not)

- pi-delegate treats the Pi CLI as an **untrusted implementation worker**. Pi never gets Bash, extensions, Skills, prompt templates, context files, or project auto-trust enabled.
- Worktree isolation is **not** an OS-level sandbox. It prevents accidental writes outside the allowed path list via the wrapper's own constraints, but does not defend against a malicious local process. Run pi-delegate on a machine you trust.
- pi-delegate **never pushes, creates PRs, or changes remotes**. Integration is a local branch operation only.
- Credentials live in environment variables (read by Pi); pi-delegate itself does not store API keys. Do not put keys in `~/.config/pi-worker/config.json` — use env vars or a secret manager.
- The dashboard HTTP server binds to `localhost` only and exposes no credentials, but it does expose run metadata (run IDs, model names, token counts). Do not expose it to a network.

## Out of scope

- Vulnerabilities in Pi itself or in any provider CLI (Kimi/Trae/Qoder) — report those upstream.
- Issues that require already having local code execution on the host.
- Theoretical timing attacks against the local file lock.
