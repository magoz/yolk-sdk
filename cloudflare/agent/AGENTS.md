# Cloudflare Agent

Cloudflare app for the Yolk durable agent runtime.

## Role and structure

- Keep this a thin adapter: generic protocol, loop, runtime, client, tool, MCP, and provider mechanics belong in `packages/*`; Cloudflare binding/runtime code stays here.
- Do not add Knowledge DO, R2 ingestion, Vectorize, Workers AI embeddings, Queues, a full auth bridge, or production topology unless explicitly requested.
- Preserve the deployed smoke path: Worker `/health`, WebSocket `/connect/:sessionId`, and `YolkAgent` DO; `pnpm cloudflare-agent:smoke` verifies health plus a faux-provider roundtrip.

## Rules

- Use Alchemy for Cloudflare resources and bindings.
- Keep `Api` Worker `name` pinned to the canonical dev script unless intentionally replacing the deployed Worker; `CLOUDFLARE_AGENT_URL` only tells Next which Worker to call.
- Use `pnpm cloudflare-agent:deploy:adopt` for pinned non-interactive deploys; it passes Alchemy `--adopt --force --yes`.
- Follow Alchemy style: relative TypeScript imports include explicit `.ts` extensions.
- Keep Cloudflare-specific code here, not in `packages/*`.
- Keep agent/MCP packages provider-neutral; provider subpaths stay host-runtime agnostic.
- Route/runtime adapters choose tool modules explicitly.
- Preserve faux fallback for smoke/unbootstrapped sessions; bootstrapped app sessions select Codex or Anthropic provider by model.
- Bootstrapped Anthropic construction must use `agentTextModelMaxOutputTokens(model)` for required Claude `maxTokens`, with no Worker-owned fallback. ChatGPT Codex rejects `max_output_tokens`, so direct/proxied Codex construction does not accept or send an output-token limit.
- Centralize provider refresh in Next; DO caches `TokenBrokerResponse` (`provider`, `accessToken`, `expiresAt`, optional `accountId`) only and never stores refresh tokens.
- Codex provider is proxy-first from DO: Browser ↔ Worker/DO stays WebSocket, DO ↔ Next uses the internal streaming HTTP Codex proxy. Direct Codex WebSocket code remains as dormant fallback for unproxied configs/experiments.
- Token broker requests use provider ids from `@yolk-sdk/agent/providers/openai` / `@yolk-sdk/agent/providers/anthropic` and `@yolk-sdk/agent/oauth` broker contracts.
- Direct browser WS uses protocol `SessionSnapshot` server messages and `AgentWebSocketClientMessage` inputs (`UserInput`, approval/question HITL responses; `expectedRevision?`, `model?`, `reasoningEffort?`); keep schemas in `@yolk-sdk/agent/protocol`.
- App-generated session ids should be URL-safe; raw `:` in `/connect/:sessionId` breaks browser WS/Worker routing.
- DO storage returns plain structured-clone objects; hydrate protocol messages with Schema before `SessionSnapshot.make`.
- Use bootstrap-injected skillsets or generated fallback; never add Node filesystem adapters to Worker/DO code.
- Prefer typed protocol events over app-local render models.
- Persist runtime append logs; replay protocol transcripts via `@yolk-sdk/agent/runtime` helpers.
- Keep Cloudflare error mapping in `src/cloudflare-error.ts` and cover adapter-only mappings in `test/`.
- Keep shared base tool parity tests updated when changing `makeTextToolModules` or MCP discovery.

## Smoke Script

- `scripts/smoke.ts` is an Effect boundary: use `Config`, `HttpClient`, `Schema.fromJsonString`, tagged errors, and `Effect.runPromise` only at the top level.
- Use `effect/unstable/socket/Socket` for WebSocket smoke checks; do not hand-roll `new WebSocket(...)` callback state.
- Prefer `Clock.currentTimeMillis`, `Deferred`, and `Ref` over `Date.now()` and mutable async callback state.
- `CLOUDFLARE_AGENT_URL` overrides deployed URL; otherwise decode `.alchemy/state/.../Api.json` with Schema.

## Checks

- Run `pnpm cloudflare:check` after touching this app.
- Run `NODE_ENV=test pnpm --filter @yolk-example/next exec playwright test --config playwright.config.ts e2e/ui/agent-cloudflare.spec.ts --project=chromium` for direct-WS reconnect/persistence/conflict/fallback changes.
- Run root `pnpm tsc`, `pnpm lint`, and `pnpm test:run` before finishing larger changes.
