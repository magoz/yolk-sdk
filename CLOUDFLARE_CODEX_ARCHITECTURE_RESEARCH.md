# Cloudflare Codex architecture research

## Question

Can the Cloudflare agent setup avoid the same Vercel timeout limits as the Next/Vercel agent path, while staying modular?

## Current architecture

```txt
Browser
  ↓ WebSocket
Cloudflare Durable Object
  ↓ runs Yolk agent runtime
Yolk agent loop
  ↓ needs model completion
Codex provider
  ↓ proxied through Vercel
Next internal Codex responses proxy
  ↓
ChatGPT/Codex Responses API
```

Cloudflare currently runs the agent runtime. Codex model calls attempt direct Worker → ChatGPT WebSocket first, then fall back to Next/Vercel when the direct open fails before any model events:

- `app/api/internal/cloudflare/codex-responses/route.ts`
- `cloudflare/agent/src/codex-ws-provider.ts` using optional `fallback`
- `cloudflare/agent/src/yolk-agent.ts` passing `bootstrap.codexResponsesEndpoint`

The proxy exists because:

1. Codex OAuth refresh token ownership currently lives in the Next app side.
2. Cloudflare direct egress to ChatGPT/Codex currently returns Cloudflare 403 HTML for us.
3. The current proxy is known-working network path.

So Cloudflare avoids Vercel timeout for the runtime/session loop, but long Codex calls can still hit Vercel limits through the response proxy when fallback is used.

## Latest verification

Current live behavior after fallback implementation:

```txt
Browser
  → Cloudflare DO WebSocket
  → DO append-backed runtime/session storage
  → DO asks Next token broker on token cache miss/near-expiry
  → DO tries ChatGPT Codex WS directly
  → ChatGPT Cloudflare returns 403 HTML before WS upgrade
  → DO falls back to Next Codex responses proxy
  → Next calls https://chatgpt.com/backend-api/codex/responses
  → response streams back Next → DO → browser
```

Observed direct Worker failure:

```txt
status: 403
hasWebSocket: false
content-type: text/html; charset=UTF-8
server: cloudflare
cf-ray: present
body: Attention Required / Sorry, you have been blocked HTML
```

Observed controls:

- Same broker/token flow works from local machine against `wss://chatgpt.com/backend-api/codex/responses`.
- Same Cloudflare runtime succeeds when `YOLK_APP_URL` points at a live public tunnel and fallback proxy is available.
- Cloudflare smoke path remains OK with faux provider.

Current conclusion: **not proven that ChatGPT blocks Cloudflare Workers categorically**. Proven only that our Worker egress path is blocked while local/Vercel egress is accepted. The likely class is Cloudflare bot/WAF challenge based on egress reputation, TLS/runtime fingerprint, or missing browser/clearance cookies.

## External research: ChatGPT/Codex Cloudflare blocks

### Official `openai/codex` evidence

The official Codex repo contains `codex-rs/codex-client/src/chatgpt_cloudflare_cookies.rs`.

It defines a process-global ChatGPT Cloudflare cookie store that:

- only applies to ChatGPT hosts;
- stores only Cloudflare infrastructure cookies;
- explicitly allowlists `cf_clearance`, `__cf_bm`, `_cfuvid`, `cf_chl_*`, `__cflb`, `__cfruid`, `__cfseq`, `cf_ob_info`, `cf_use_ob`, etc.;
- refuses ChatGPT account/session cookies.

Implication: official Codex expects headless ChatGPT backend calls to need Cloudflare clearance/cookie handling.

The official Codex repo also has Cloudflare-specific error handling in `codex-rs/protocol/src/error.rs`:

```txt
Access blocked by Cloudflare. This usually happens when connecting from a restricted region
```

and tests that simplify `403` HTML bodies containing `Cloudflare` + `Sorry, you have been blocked` into that friendly error with `cf-ray` context.

Sources:

- https://github.com/openai/codex/blob/main/codex-rs/codex-client/src/chatgpt_cloudflare_cookies.rs
- https://github.com/openai/codex/blob/main/codex-rs/protocol/src/error.rs
- https://github.com/openai/codex/blob/main/codex-rs/protocol/src/error_tests.rs

### Official Cloudflare docs

Cloudflare docs confirm:

- `403/1020`-class access denied can come from the site owner's Cloudflare firewall/security rules, and only the zone owner can inspect/update the rule using Ray ID.
- `cf_clearance` stores proof of a passed challenge and is required by Challenge Platform / JavaScript detections to reach the origin without a new challenge.
- `_cfuvid` is used by rate limiting to distinguish visitors behind shared IPs/NAT.
- Cloudflare anycast/shared IP ranges can appear to origins/firewalls as a small set of high-volume sources.
- Workers `fetch()` supports outbound subrequests, but it does not make the caller equivalent to a browser TLS/cookie profile.

Sources:

- https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1020/
- https://developers.cloudflare.com/fundamentals/reference/policies-compliances/cloudflare-cookies/
- https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/
- https://developers.cloudflare.com/workers/runtime-apis/fetch/

### OpenClaw evidence

OpenClaw issue `#67670` is the closest external match.

Claimed findings:

- `openai-codex` provider via `chatgpt.com/backend-api` gets Cloudflare 403 with `cf-mitigated: challenge`.
- Same OAuth token works through Python `cloudscraper` with Chrome-like TLS fingerprint.
- Node.js native fetch / Undici fails.
- Both HTTP/SSE and WebSocket fail.
- Report attributes root to JA3/JA4 / TLS fingerprint, not auth validity or request headers.
- Suggested workaround is a local Python reverse proxy using `cloudscraper`.

Source: https://github.com/openclaw/openclaw/issues/67670

OpenClaw issue `#64092` shows earlier misclassification of `403` HTML from Codex as DNS/rate-limit/auth. Comments explicitly state the actual block can be IP + TLS fingerprint; curl can succeed while Node/Undici fails. OpenClaw later fixed only classification, not the underlying transport block.

Source: https://github.com/openclaw/openclaw/issues/64092

OpenClaw PR `#67642` merged classifier changes so Cloudflare/CDN HTML pages are treated as transport/upstream HTML failures instead of structured provider rate limits.

Source: https://github.com/openclaw/openclaw/pull/67642

OpenClaw PR `#69336` fixed a separate alias issue: `https://chatgpt.com/backend-api/responses` started returning Cloudflare HTML 403, while `https://chatgpt.com/backend-api/codex/responses` remained valid. Yolk already uses `/backend-api/codex/responses`, so this is not our current failure.

Source: https://github.com/openclaw/openclaw/pull/69336

### OpenAI Codex issue tracker evidence

OpenAI Codex issue `#17880` reports ChatGPT auth-mode sessions receiving Cloudflare challenge HTML in background tasks, leading to downstream failures. Maintainer skepticism exists, but later comments from users report positive diagnostics and current errors against `https://chatgpt.com/backend-api/codex/responses/compact`.

Source: https://github.com/openai/codex/issues/17880

OpenAI Codex issue `#22144` reports long-lived `codex app-server` sessions silently timing out until manual `codex login`, suspected stale `cf_clearance` / Cloudflare WAF cookie issue. This supports the “clearance/cookie state matters” model, not specifically Workers.

Source: https://github.com/openai/codex/issues/22144

### Pi Codex provider comparison

Pi's `openai-codex-responses` provider uses the same broad transport shape:

- default base URL: `https://chatgpt.com/backend-api`
- WebSocket beta header: `responses_websockets=2026-02-06`
- SSE fallback beta header: `responses=experimental`
- pre-stream WebSocket → SSE fallback only when no model events have emitted
- per-session debug stats for WS failures, SSE fallbacks, connection reuse, previous response id, and cached-context requests

Important difference for Yolk: Pi's fallback is still a same-runtime ChatGPT HTTP/SSE call. Yolk's Worker HTTP/SSE and WS paths both hit ChatGPT Cloudflare 403 HTML, so a same-Worker WS → SSE fallback likely does not help. Yolk's fallback must leave the blocked egress path, currently via the Next/Vercel responses proxy.

Useful Pi patterns to keep:

- record direct-transport failures without logging credentials
- disable direct WS per session after a pre-stream transport block
- expose session-level debug state for support diagnostics
- preserve the invariant: if direct stream emitted any event, do not retry through fallback

## Research conclusion

The most accurate technical description is:

```txt
ChatGPT/Codex backend-api is protected by Cloudflare bot/WAF/challenge systems.
Some non-browser runtimes, TLS fingerprints, shared/datacenter/proxy egress routes,
or stale/missing Cloudflare clearance cookies receive 403 HTML/challenge responses.
Cloudflare Workers are one egress/runtime path that triggers this for Yolk.
```

Avoid overclaiming:

- Not proven: “OpenAI blocks Cloudflare Workers specifically.”
- Proven: “Yolk Worker egress to ChatGPT Codex direct WS receives Cloudflare 403 HTML while local/Vercel paths succeed.”

Useful search terms:

- `openai codex cf_clearance`
- `openai-codex Cloudflare JS Challenge`
- `chatgpt backend-api codex responses 403 HTML`
- `ChatGPT backend-api TLS fingerprint`
- `Node Undici ChatGPT Cloudflare 403`
- `JA3 JA4 chatgpt.com backend-api`
- `cf-mitigated challenge chatgpt.com backend-api`

## Key distinction

Yolk owns the agent runtime. The runtime still needs an LLM provider.

Vercel is not needed for the agent loop. It is currently only a narrow Codex auth/network bridge.

## Desired architectural boundary

Separate agent runtime from provider credential authority.

```txt
Browser
  ↓
Cloudflare DO agent runtime
  ↓ needs model call
Provider adapter
  ↓ needs valid access token
Credential broker / provider gateway
  ↓ refreshes/stores OAuth tokens
Token store / app DB
```

## Possible modular pieces

### `packages/llm-provider`

Provider-neutral interface for model calls.

No app auth. No token storage. No deployment assumptions.

### `packages/oauth-credentials`

Generic OAuth credential mechanics:

- expiry checks
- refresh flow
- redacted token model
- credential errors
- provider config abstraction

No DB. No Next. No Cloudflare.

### App-specific credential broker / provider gateway

Deployable service boundary.

Responsibilities:

- authenticate caller/session/user
- read/write token store
- refresh OAuth credentials
- return short-lived access token or execute provider call server-side

Deployment options:

- Cloudflare Worker
- non-Vercel server
- temporary Next route

## Option A: token broker

```txt
Cloudflare agent → credential broker → returns fresh access token
Cloudflare agent → Codex directly
```

Pros:

- agent owns provider call
- simpler streaming
- Vercel removed if direct Codex egress works

Cons:

- Cloudflare must be able to call Codex directly
- Cloudflare sees access tokens

## Option B: provider gateway

```txt
Cloudflare agent → provider gateway → Codex
```

Gateway owns OAuth refresh and actual Codex request.

Pros:

- refresh tokens never leave gateway
- avoids Cloudflare egress issue if gateway runs outside Cloudflare
- can deploy anywhere, not necessarily Vercel
- clean security boundary

Cons:

- gateway must support streaming well
- another service to operate

## Decision update: token broker first, proxy fallback second

Goal: execute agent/provider requests in Cloudflare when possible, not Vercel.

Vercel remains the main app server and credential vault. Cloudflare owns the agent runtime and should call Codex directly after getting a valid access token from Vercel. Because current Worker egress is blocked by ChatGPT Cloudflare WAF, Cloudflare also receives a narrow responses proxy URL as fallback.

```txt
Browser
  → Cloudflare Durable Object
  → Vercel token broker
  ← access token + account id + expiry
Cloudflare Durable Object
  → ChatGPT/Codex Responses API direct WS
  → fallback: Vercel Codex responses proxy
```

### Decisions

- Keep provider support OAuth-only for now; API-key mode can come later.
- Prefer a **token broker** for direct execution, plus temporary **provider proxy fallback** when direct egress fails before stream start.
- Vercel stores and refreshes Codex OAuth credentials in Postgres.
- Cloudflare never receives refresh tokens.
- Cloudflare receives only short-lived access token data needed for one or more Codex requests.
- Cloudflare attempts direct Codex request execution first.
- Existing Vercel responses proxy remains as a tactical fallback while Worker egress is blocked.
- Do not delete the responses proxy until another accepted egress path exists.

### Current fallback downsides

The Next/Vercel responses proxy is a tactical bridge, not the desired end state.

- Vercel timeout risk remains: Cloudflare owns runtime/session, but long model streams still cross Vercel when fallback is used.
- Extra hop and latency: browser → DO → Next → ChatGPT → Next → DO → browser.
- Vercel execution and bandwidth cost increases because token streams pass through Next.
- Fallback is currently the hot path: direct Worker egress fails first, so every real Codex run pays one failed direct WS attempt plus proxy streaming.
- Cloudflare runtime availability depends on a reachable, healthy Next app for Codex calls.
- Local dev needs a public `YOLK_APP_URL`; `localhost` and portless local URLs are not reachable from Workers, and stale tunnels become opaque 502s.
- More auth surface: the proxy route needs bridge-secret validation and strict header allowlisting.
- Access token exposure area is wider: the DO receives brokered access tokens, then forwards them through the proxy. Refresh tokens still stay in Next/Postgres.
- Duplicate provider transport paths: direct WS and proxy HTTP/SSE need consistent Codex quirks, cancellation, errors, and observability.
- Diagnostics are harder: failures can occur at direct WS open, DO → Next proxy, Next → ChatGPT, or the stream back to DO.
- It is not Vercel-free Codex execution; it only proves Cloudflare can own the durable agent loop while Codex egress remains bridged.

### Token refresh model

Cloudflare asks Vercel for a fresh-enough token before a Codex request.

```txt
POST /api/internal/cloudflare/codex-token
Authorization: Bearer <bridge-secret>
Body: { provider, subjectId, minTtlSeconds?, forceRefresh? }
```

Vercel:

1. validates internal caller auth
2. resolves the user/session
3. loads Codex OAuth credentials from Postgres
4. refreshes if missing required TTL or force refresh requested
5. persists refreshed credentials
6. returns `{ provider, accessToken, expiresAt, accountId? }`

Cloudflare:

1. calls token broker
2. sends Codex request directly with returned access token
3. falls back to responses proxy if direct open fails before any events
4. retries token broker with `forceRefresh: true` only for token-shaped auth failures, not generic Cloudflare HTML blocks

## Package direction

Create two packages first:

```txt
@yolk/oauth
@yolk/openai
```

`@yolk/oauth` owns shared contracts only:

- token broker request/response schemas
- credential source interfaces
- token TTL helpers
- no provider-specific endpoints
- no token storage ownership

`@yolk/openai` owns reusable OpenAI/Codex mechanics:

- Codex request lowering
- Codex SSE/body parsing
- Codex token shape
- Codex refresh/device-flow helpers
- token broker client
- local OAuth credential source
- future API-key mode, later

It must not own app policy:

- no Better Auth dependency
- no Postgres schema dependency
- no Vercel route dependency
- no Cloudflare Durable Object dependency
- no app session/user model

Consumers:

```txt
Cloudflare app
  → @yolk/openai Codex provider
  → @yolk/openai token broker client

Vercel app
  → @yolk/openai Codex refresh helpers
  → @yolk/oauth broker contract
  → app-owned Postgres token store

Local CLI/app
  → @yolk/openai Codex provider
  → @yolk/openai local OAuth source
```

Do not create `@yolk/gateway` yet. The current architecture needs a token broker, not a provider gateway. Add a generic gateway package only after another provider or deployment mode needs remote provider execution.

Anthropic Max / Claude subscription auth should use the same split later:

```txt
@yolk/oauth      shared broker/local credential contracts
@yolk/openai     OpenAI/Codex auth + provider mechanics
@yolk/anthropic  Anthropic/Claude auth + provider mechanics
```

The invariant:

```txt
host owns tokens
provider package owns vendor mechanics
oauth package owns shared contract
runtime owns no auth
```

## Previous recommendation: provider gateway

Prefer Option B: provider gateway.

Narrow API:

```txt
POST /providers/codex/responses
Authorization: internal service/session auth
Body: provider request
Response: streamed provider response
```

Gateway flow:

```txt
validate Cloudflare/app session
  → load user's Codex OAuth credential
  → refresh if needed
  → call Codex
  → stream response back
```

Cloudflare agent stays thin:

```ts
makeOpenAiCodexProviderLayer({
  responsesUrl: gatewayUrl,
  extraHeaders: internalAuthHeaders
})
```

## Remaining questions

- Non-Vercel fallback target?
- Per-session direct-block TTL?
- Debug stats surface?
- Future gateway package?
