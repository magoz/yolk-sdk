# Anthropic Provider Package

`@yolk-sdk/anthropic` owns reusable Anthropic/Claude mechanics for Claude subscription OAuth and future Anthropic provider modes.

## Boundaries

- No app users, teams, sessions, DB, Better Auth, Vercel routes, or Cloudflare Durable Objects.
- No refresh-token storage ownership.
- Provider-specific constants, OAuth endpoints/scopes, auth URL helpers, broker helpers, header helpers, request lowering, stream parsing, and response/usage mapping belong here.
- Hosted apps provide tokens through `@yolk-sdk/oauth` broker contracts.
- Local apps provide tokens through local credential sources.

## Public model

| Export area | Purpose |
| ----------- | ------- |
| `claude` | Claude OAuth constants, auth URL/code parsing, broker helpers, headers |
| `claude-provider` | Claude `LLMProvider` layer, request lowering, SSE/JSON stream parsing, response/usage mapping |

## Design rules

- Keep Claude subscription auth compatible with Worker/server runtimes.
- Claude OAuth provider requests must include Claude Code OAuth compatibility headers by default; `extraHeaders` stays last so hosts can override/gateway them.
- Claude OAuth request bodies keep `system[]` to Claude Code identity plus billing header; host instructions move into first user message.
- Claude tool names use Claude Code MCP parity (`name` → `mcp_Name`) and provider responses unprefix back; preserve `StructuredOutput` casing.
- Claude provider streams by default but accepts SSE or JSON bodies by body shape; do not rely on content-type.
- Claude tool `input_schema` payloads must be provider-safe root objects; add missing root `type: 'object'` and flatten top-level `anyOf`/`oneOf`/`allOf`.
- Claude provider lowers PDF `DocumentPart` to Anthropic `document` blocks; non-PDF documents fail explicitly.
- Manual Claude OAuth uses PKCE; app-owned server actions store verifier outside `'use server'` modules.
- API-key mode may be added later without changing OAuth contracts.
- Provider layers depend on `@yolk-sdk/agent`; hosts still own token storage/refresh and app policy.
- Lower `AgentMessage` envelopes with protocol helpers `messageContextText` + `prependMessageContextToContent`; do not duplicate context rendering locally.
