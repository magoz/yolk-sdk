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

Cloudflare currently runs the agent runtime, but Codex model calls still pass through Next/Vercel via:

- `app/api/internal/cloudflare/codex-responses/route.ts`
- `cloudflare/agent/src/yolk-agent.ts` using `bootstrap.codexResponsesEndpoint`

The proxy exists because:

1. Codex OAuth refresh token ownership currently lives in the Next app side.
2. Cloudflare direct egress to ChatGPT/Codex may be blocked.
3. The current proxy is known-working network path.

So Cloudflare avoids Vercel timeout for the runtime/session loop, but long Codex calls can still hit Vercel limits through the response proxy.

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

## Current recommendation

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

## Open questions

- Cloudflare → Codex direct egress works?
- Need gateway or token broker?
- Where should refresh tokens live long-term?
- Gateway deploy target?
- Streaming proxy contract shape?
