# Cloudflare Agent

Cloudflare app for the future Yolk durable agent runtime.

## Current Status

- This app is a proving adapter for `/agent/cloudflare`; runtime page fails explicitly when unavailable, no Next fallback.
- Keep the deployed smoke path alive: Worker `/health` + WebSocket `/connect/:sessionId` + `YolkAgent` DO.
- App bootstrap path: Worker `/bootstrap/:sessionId` stores user/token/response-proxy bridge config and remote MCP server configs before direct browser WS.
- `pnpm cloudflare-agent:smoke` validates deployed `/health` and one WebSocket faux-provider roundtrip.
- Current goal: run Yolk runtime in DO with typed protocol WS messages, append-log transcript storage, app-centralized Codex token refresh, and Next-proxied Codex responses.
- DO storage uses `SessionEventStore`; WS connect sends `SessionSnapshot`; new input is rejected with `conflict` while a run is active.
- Stale WS `UserInput.expectedRevision` returns in-band `AgentError { code: 'conflict' }`; malformed WS text is treated as fallback `UserMessage` input.
- Skillset support is bundle/static only: `src/generated/skillset.ts` is produced by `pnpm skillset:build`; no filesystem reads at Worker runtime.
- Tool modules are runtime-adapter explicit. App tool modules are runtime-portable; never import Node-only code here. Remote MCP config arrives via bootstrap, not Worker env/filesystem.
- `src/tool-modules.ts` delegates to shared `makeTextToolModules`; `test/tool-modules.test.ts` locks Next/Cloudflare tool parity, including fake remote MCP.
- Do not expand into full product infrastructure until package APIs are stable.

## Strategic Direction

Primary work should stay in reusable packages first:

- `@yolk/protocol`
- `@yolk/agent-loop`
- `@yolk/agent-runtime`
- `@yolk/client`
- `@yolk/tool-registry`

Cloudflare should remain a thin runtime adapter; policy, auth, token refresh, and tools stay app-owned until stable.

## Defer For Now

Do not build these here yet unless explicitly requested:

- Knowledge DO
- R2 ingestion/files
- Vectorize
- Workers AI embeddings
- Queues
- full auth bridge (v1 only has app-server bootstrap + bridge secret)
- production Cloudflare topology

## Package Holes To Close First

- Cancellation/resume beyond reconnect interruption.
- Tool approval and permission hooks.
- Context provider API.
- Compaction hook shape.
- Protocol event completeness and stability.
- Broader client transport abstraction for SSE/fanout/replay beyond current NDJSON + Cloudflare WS helpers.
- Tests for event ordering, persistence, retries, failures.
- Package docs and public API cleanup.

## Recommended Sequence

1. Keep Cloudflare smoke deploy passing.
2. Stabilize protocol events in packages.
3. Harden runtime append-log behavior and Cloudflare coverage.
4. Add transport/client abstractions in packages.
5. Add tool policy/context seams in packages.
6. Test with fake provider/store/tools.
7. Keep app bootstrap/token bridge narrow and auditable.
8. Only then expand Cloudflare infra.

## Rule Of Thumb

- If a feature can be generic, build it in `packages/*` first.
- If it needs Cloudflare bindings/runtime APIs, keep it in `cloudflare/agent`.
- Avoid hardening immature package abstractions into Cloudflare infrastructure.

## Rules

- Use Alchemy for Cloudflare resources and bindings.
- Keep `Api` Worker `name` pinned to the canonical dev script unless intentionally replacing the deployed Worker; `CLOUDFLARE_AGENT_URL` only tells Next which Worker to call.
- Use `pnpm cloudflare-agent:deploy:adopt` for pinned non-interactive deploys; it passes Alchemy `--adopt --force --yes`.
- Follow Alchemy style: relative TypeScript imports include explicit `.ts` extensions.
- Keep Cloudflare-specific code here, not in `packages/*`.
- Keep `@yolk/*` packages provider/runtime-neutral.
- Route/runtime adapters choose tool modules; a future app-layer AgentDefinition may centralize tool selection once agent product boundaries stabilize.
- Preserve faux fallback for smoke/unbootstrapped sessions; bootstrapped app sessions use Codex provider in DO.
- Centralize Codex refresh in Next; DO caches access/account id/expiry only and never stores refresh tokens.
- Route bootstrapped DO Codex response calls through Next proxy; direct Worker egress to ChatGPT Codex may get Cloudflare-blocked.
- Direct browser WS uses protocol `SessionSnapshot` + `UserInput`; keep schemas in `@yolk/protocol`.
- App-generated session ids should be URL-safe; raw `:` in `/connect/:sessionId` breaks browser WS/Worker routing.
- DO storage returns plain structured-clone objects; hydrate protocol messages with Schema before `SessionSnapshot.make`.
- Import generated skillsets from `src/generated/skillset.ts`; never add Node filesystem adapters to Worker/DO code.
- Prefer typed protocol events over app-local render models.
- Persist runtime append logs; replay protocol transcripts via `@yolk/agent-runtime` helpers.
- Keep Cloudflare error mapping in `src/cloudflare-error.ts` and cover adapter-only mappings in `test/`.
- Keep tool parity tests updated when adding/removing app text tools or changing MCP discovery.

## Smoke Script

- `scripts/smoke.ts` is an Effect boundary: use `Config`, `HttpClient`, `Schema.fromJsonString`, tagged errors, and `Effect.runPromise` only at the top level.
- Use `effect/unstable/socket/Socket` for WebSocket smoke checks; do not hand-roll `new WebSocket(...)` callback state.
- Prefer `Clock.currentTimeMillis`, `Deferred`, and `Ref` over `Date.now()` and mutable async callback state.
- `CLOUDFLARE_AGENT_URL` overrides deployed URL; otherwise decode `.alchemy/state/.../Api.json` with Schema.

## Checks

- Run `pnpm cloudflare:check` after touching this app.
- Run `NODE_ENV=test pnpm playwright test e2e/ui/agent-cloudflare.spec.ts --project=chromium` for direct-WS reconnect/persistence/conflict/fallback changes.
- Run root `pnpm tsc`, `pnpm lint`, and `pnpm test:run` before finishing larger changes.
