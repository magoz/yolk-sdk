# Yolk Cloudflare Agent

Cloudflare spike for running the reusable Yolk agent stack inside Durable Objects via Alchemy.
Alchemy state is local under `.alchemy/state` for now.

## Scope

- `Api` Worker exposes `/connect/:sessionId`.
- `YolkAgent` Durable Object owns a session-scoped WebSocket.
- Incoming WebSocket text becomes a `UserMessage`.
- `@yolk-sdk/agent/runtime` runs in input mode.
- DO storage persists the protocol transcript.
- Smoke and unbootstrapped sessions use a faux provider for deterministic infra/runtime validation.
- Bootstrapped sessions select Anthropic Claude or OpenAI Codex from app-provided model/token broker configuration.
- Both provider constructors receive the selected host model's required output-token configuration; the Worker does not infer limits. Codex omits the unsupported vendor `max_output_tokens` field.

## Commands

```sh
pnpm cloudflare-agent:dev
pnpm cloudflare-agent:deploy
pnpm cloudflare-agent:destroy
pnpm cloudflare-agent:smoke
pnpm cloudflare:check
```

## Current dev deployment

```txt
https://yolkagentworker-api-dev-magoz-acgmzjtxyqsevrst.expenses.workers.dev
```

`src/api.ts` pins the Worker `name` to this script name so Alchemy updates the existing dev Worker instead of creating a new generated workers.dev URL when local state is missing.

Health check:

```sh
curl https://yolkagentworker-api-dev-magoz-acgmzjtxyqsevrst.expenses.workers.dev/health
```

Expected response: `ok`.

Full smoke:

```sh
pnpm cloudflare-agent:smoke
```

The smoke command reads `.alchemy/state/YolkAgentWorker/dev_magoz/Api.json` unless `CLOUDFLARE_AGENT_URL` is set.

## Alchemy patch

This repo patches `alchemy@2.0.0-beta.36` so Cloudflare Vite-only imports are lazy. Without it, non-Vite Workers still pull `vite -> lightningcss` into Alchemy's stack bundle and fail on Lightning CSS's dev-only `../pkg` fallback.

## Import style

Use explicit `.ts` extensions for relative TypeScript imports. This matches Alchemy's source and examples, and lets deploy-time stack evaluation load TypeScript source through Node-compatible ESM paths.

## Cloudflare env

Alchemy deploy/dev needs Cloudflare credentials:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Use `workers.dev` for the spike. No custom domain required.
