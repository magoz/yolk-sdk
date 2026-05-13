# OpenAI Provider Package

`@yolk/openai` owns reusable OpenAI-family mechanics for Codex/ChatGPT and future OpenAI API-key modes.

## Boundaries

- No app users, teams, sessions, DB, Better Auth, Vercel routes, or Cloudflare Durable Objects.
- No refresh-token storage ownership.
- Provider-specific token schemas, endpoints, headers, refresh/device-flow helpers, request lowering, and stream parsing belong here.
- Hosted apps provide tokens through `@yolk/oauth` broker contracts.
- Local apps provide tokens through local credential sources.

## Public model

| Export area | Purpose |
| ----------- | ------- |
| `codex` | Codex constants, token schemas, broker helpers, headers |

## Design rules

- Keep Codex direct execution compatible with Worker runtimes.
- Keep gateway/server execution out until a real provider-gateway package is needed.
- API-key mode may be added later without changing OAuth contracts.
