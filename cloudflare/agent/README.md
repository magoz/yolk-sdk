# Yolk Cloudflare Agent

Cloudflare spike for running the reusable Yolk agent stack inside Durable Objects via Alchemy.
Alchemy state is local under `.alchemy/state` for now.

## Scope

- `Api` Worker exposes `/connect/:sessionId`.
- `YolkAgent` Durable Object owns a session-scoped WebSocket.
- Incoming WebSocket text becomes a `UserMessage`.
- `@yolk/agent-runtime` runs in input mode.
- DO storage persists the protocol transcript.
- A faux LLM provider replies deterministically for infra/runtime validation.

## Commands

```sh
pnpm cloudflare-agent:dev
pnpm cloudflare-agent:deploy
pnpm cloudflare-agent:destroy
pnpm cloudflare:check
```

## Current dev deployment

```txt
https://yolkagentworker-api-dev-magoz-acgmzjtxyqsevrst.expenses.workers.dev
```

Health check:

```sh
curl https://yolkagentworker-api-dev-magoz-acgmzjtxyqsevrst.expenses.workers.dev/health
```

Expected response: `ok`.

## Alchemy patch

This repo patches `alchemy@2.0.0-beta.36` so Cloudflare Vite-only imports are lazy. Without it, non-Vite Workers still pull `vite -> lightningcss` into Alchemy's stack bundle and fail on Lightning CSS's dev-only `../pkg` fallback.

## Cloudflare env

Alchemy deploy/dev needs Cloudflare credentials:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Use `workers.dev` for the spike. No custom domain required.
