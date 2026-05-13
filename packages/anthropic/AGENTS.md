# Anthropic Provider Package

`@yolk/anthropic` owns reusable Anthropic/Claude mechanics for Claude subscription OAuth and future Anthropic provider modes.

## Boundaries

- No app users, teams, sessions, DB, Better Auth, Vercel routes, or Cloudflare Durable Objects.
- No refresh-token storage ownership.
- Provider-specific constants, OAuth endpoints/scopes, auth URL helpers, broker helpers, and header helpers belong here.
- Hosted apps provide tokens through `@yolk/oauth` broker contracts.
- Local apps provide tokens through local credential sources.

## Public model

| Export area | Purpose |
| ----------- | ------- |
| `claude` | Claude OAuth constants, auth URL/code parsing, broker helpers, headers |

## Design rules

- Keep Claude subscription auth compatible with Worker/server runtimes.
- Manual Claude OAuth uses PKCE; app-owned server actions store verifier outside `'use server'` modules.
- API-key mode may be added later without changing OAuth contracts.
