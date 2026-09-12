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
- Anthropic receives the selected host model's required output-token configuration; the Worker does not infer limits. ChatGPT Codex rejects `max_output_tokens`, so Codex construction does not accept or send an output-token limit.

## Commands

```sh
pnpm cloudflare-agent:dev
pnpm cloudflare-agent:deploy
pnpm cloudflare-agent:destroy
pnpm cloudflare-agent:smoke
pnpm --filter @yolk-sdk/cloudflare-agent run compat
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

## Alchemy compatibility

This app pins `alchemy@2.0.0-beta.56` against catalog Effect `4.0.0-beta.80` (one Effect instance). Alchemy `2.0.0-beta.36` crashed at import time on `Effect.serviceOption(...).asEffect()`, which Effect 80 removed. `2.0.0-beta.38` dropped that obsolete protocol call but still treated `Schema.Defect` as a schema value (`Schema.optional(Schema.Defect)` / `Schema.DefectWithStack`), so `alchemy --help` and `alchemy/Cloudflare` failed on Effect 80 Schema AST encoding. 56 is the last Effect-80-compatible release (`peer effect >=4.0.0-beta.78`); it uses `Schema.Defect()` / `Schema.Defect({ includeStack: true })` and natively lazy-loads Vite, so the previous `patches/alchemy@*` Vite lazy-import is no longer needed. Do not blanket-strip remaining `.asEffect` sites: Alchemy's own `Resource`/`Platform`/`Binding` methods are still valid.

`pnpm --filter @yolk-sdk/cloudflare-agent run compat` (also part of `pnpm cloudflare:check`) is a synchronous Node CLI smoke (`node --experimental-strip-types`, not tsx) so it loads Alchemy `lib/` the same way the CLI does. It checks the import graph, `alchemy --help`, and that app/root/Alchemy `require.resolve('effect')` realpaths are one instance. It does not deploy, start `alchemy dev`, or prove a running Worker or E2E.

Running a local Worker (`alchemy dev`) or E2E against it is a separate step. Local `alchemy dev` authenticates through Alchemy's default Cloudflare profile: an existing OAuth profile is enough. `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are an alternative, not a requirement when that profile exists.

## Import style

Use explicit `.ts` extensions for relative TypeScript imports. This matches Alchemy's source and examples, and lets deploy-time stack evaluation load TypeScript source through Node-compatible ESM paths.

## Cloudflare env

Alchemy deploy/dev authenticates through either:

- the default Alchemy Cloudflare profile (OAuth), or
- `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`

Use `workers.dev` for the spike. No custom domain required.
