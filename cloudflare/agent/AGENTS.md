# Cloudflare Agent

Cloudflare app for the future Yolk durable agent runtime.

## Current Status

- This app is a proving adapter, not the main product surface yet.
- Keep the deployed smoke path alive: Worker `/health` + WebSocket `/connect/:sessionId` + `YolkAgent` DO.
- `pnpm cloudflare-agent:smoke` validates deployed `/health` and one WebSocket faux-provider roundtrip.
- Current goal: prove `@yolk/*` packages run inside Cloudflare Durable Objects with typed protocol events and append-log durable transcript storage.
- DO storage uses `SessionEventStore`; reconnect marks latest incomplete run `RunInterrupted` before accepting a new socket.
- Skillset support is bundle/static only: `src/generated/skillset.ts` is produced by `pnpm skillset:build`; no filesystem reads at Worker runtime.
- Do not expand into full product infrastructure until package APIs are stable.

## Strategic Direction

Primary work should stay in reusable packages first:

- `@yolk/protocol`
- `@yolk/agent-loop`
- `@yolk/agent-runtime`
- `@yolk/client`
- `@yolk/tool-registry`

Cloudflare should remain a thin adapter + smoke deploy until package holes are closed.

## Defer For Now

Do not build these here yet unless explicitly requested:

- Knowledge DO
- R2 ingestion/files
- Vectorize
- Workers AI embeddings
- Queues
- full auth bridge
- production Cloudflare topology
- real integration tools beyond minimal adapter validation

## Package Holes To Close First

- Cancellation/resume beyond reconnect interruption.
- Tool approval and permission hooks.
- Context provider API.
- Compaction hook shape.
- Protocol event completeness and stability.
- Client transport abstraction for WebSocket/SSE.
- Later enhancement: once Cloudflare needs real UI integration, consider a shared `@yolk/client` transport interface for NDJSON/SSE/WebSocket; defer until backend needs are concrete.
- Tests for event ordering, persistence, retries, failures.
- Package docs and public API cleanup.

## Recommended Sequence

1. Keep Cloudflare smoke deploy passing.
2. Stabilize protocol events in packages.
3. Harden runtime append-log behavior and Cloudflare coverage.
4. Add transport/client abstractions in packages.
5. Add tool policy/context seams in packages.
6. Test with fake provider/store/tools.
7. Update Cloudflare adapter to consume stable APIs.
8. Only then expand Cloudflare infra.

## Rule Of Thumb

- If a feature can be generic, build it in `packages/*` first.
- If it needs Cloudflare bindings/runtime APIs, keep it in `cloudflare/agent`.
- Avoid hardening immature package abstractions into Cloudflare infrastructure.

## Rules

- Use Alchemy for Cloudflare resources and bindings.
- Follow Alchemy style: relative TypeScript imports include explicit `.ts` extensions.
- Keep Cloudflare-specific code here, not in `packages/*`.
- Keep `@yolk/*` packages provider/runtime-neutral.
- Use faux provider until Cloudflare DO + persistence path is proven.
- Import generated skillsets from `src/generated/skillset.ts`; never add Node filesystem adapters to Worker/DO code.
- Prefer typed protocol events over app-local render models.
- Persist runtime append logs; replay protocol transcripts via `@yolk/agent-runtime` helpers.
- Keep Cloudflare error mapping in `src/cloudflare-error.ts` and cover adapter-only mappings in `test/`.

## Smoke Script

- `scripts/smoke.ts` is an Effect boundary: use `Config`, `HttpClient`, `Schema.fromJsonString`, tagged errors, and `Effect.runPromise` only at the top level.
- Use `effect/unstable/socket/Socket` for WebSocket smoke checks; do not hand-roll `new WebSocket(...)` callback state.
- Prefer `Clock.currentTimeMillis`, `Deferred`, and `Ref` over `Date.now()` and mutable async callback state.
- `CLOUDFLARE_AGENT_URL` overrides deployed URL; otherwise decode `.alchemy/state/.../Api.json` with Schema.

## Checks

- Run `pnpm cloudflare:check` after touching this app.
- Run root `pnpm tsc`, `pnpm lint`, and `pnpm test:run` before finishing larger changes.
