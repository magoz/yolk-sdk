# Internal Cloudflare Bridge

Next-only routes called by the Cloudflare Worker/DO. Never expose these contracts to browsers.

## Routes

| Route | Role |
| --- | --- |
| `codex-token/route.ts` | Exchange bridge secret + provider request for fresh OAuth access token |
| `codex-token/route-model.ts` | Token request/response schema helpers and tests |
| `codex-responses/route.ts` | Proxy Codex Responses HTTP stream from DO to ChatGPT backend |
| `codex-responses/route-model.ts` | Header allowlist + response contract helpers |

## Rules

- Require `x-yolk-cloudflare-secret`; missing env and bad secret both fail closed.
- Return access token/account/expiry only. Never send refresh tokens to Worker/DO.
- Keep provider ids aligned with `@yolk-sdk/agent/providers/openai`, `@yolk-sdk/agent/providers/anthropic`, and `@yolk-sdk/agent/oauth` broker contracts.
- Codex proxy forwards the upstream body stream and preserves only safe response headers.
- Header forwarding stays allowlist-only in `codex-responses/route-model.ts`; never forward cookies or bridge secrets.
- Provide `FetchHttpClient.layer` only inside route handlers that call upstream HTTP.

## Tests

- Security-sensitive allowlist/status behavior belongs beside route-model or route files.
- Cover secret failures, provider selection, token shape, and forbidden forwarded headers.

## Anti-Patterns

- Browser-callable routes.
- Cloudflare Worker env/filesystem reads for app OAuth tokens.
- Proxying arbitrary headers/body shapes without schema/allowlist review.
