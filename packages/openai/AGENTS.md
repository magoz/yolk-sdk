# OpenAI Provider Package

`@yolk-sdk/openai` owns reusable OpenAI-family mechanics for Codex/ChatGPT OAuth and OpenAI API-key provider mode.

## Boundaries

- No app users, teams, sessions, DB, Better Auth, Vercel routes, or Cloudflare Durable Objects.
- No refresh-token storage ownership.
- Provider-specific token schemas, endpoints, headers, refresh/device-flow helpers, request lowering, and stream parsing belong here.
- Hosted apps provide tokens through `@yolk-sdk/oauth` broker contracts.
- Local apps provide tokens through local credential sources.

## Public model

| Export area | Purpose |
| ----------- | ------- |
| `codex` | Codex constants, token schemas, broker helpers, headers |
| `codex-provider` | Codex `LLMProvider` layer, request lowering, SSE/JSON stream parsing, usage mapping |
| `provider` | OpenAI API-key Chat Completions `LLMProvider` layer |

## Design rules

- Keep Codex direct execution compatible with Worker runtimes.
- Keep gateway/server execution out until a real provider-gateway package is needed.
- API-key provider mode stays separate from Codex OAuth contracts.
- Provider layers depend on `@yolk-sdk/agent`; hosts still own token storage/refresh and app policy.
