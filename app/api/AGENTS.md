# API Routes

HTTP boundaries for auth, agent text, and Realtime voice. CRUD/product mutations belong in server actions, not routes.

## Routes

| Route                                          | Role                             |
| ---------------------------------------------- | -------------------------------- |
| `auth/[...all]/route.ts`                       | better-auth Next handler         |
| `agent/route.ts`                               | Text agent NDJSON stream         |
| `agent/workflow/route.ts`                      | Vercel Workflow text NDJSON stream |
| `agent/workflow/[runId]/route.ts`              | Workflow stream replay/cancel    |
| `agent/AGENTS.md`                              | Agent route-local contracts      |
| `agent/commands/route.ts`                      | Agent command list/render        |
| `agent/realtime/call/route.ts`                 | OpenAI Realtime SDP exchange     |
| `agent/realtime/tool/route.ts`                 | Voice tool execution bridge      |
| `internal/cloudflare/codex-token/route.ts`     | Internal DO token bridge         |
| `internal/cloudflare/codex-responses/route.ts` | Internal DO Codex streaming HTTP proxy |

## Effect Route Pattern

- Use `HttpEffect.toWebHandlerLayer(handler, Layer)` for Effect-backed routes unless a framework SDK requires Web `Response` directly.
- Parse JSON with `HttpServerRequest.schemaBodyJson(...)`.
- Return `HttpServerResponse.*`; wrap raw streamed `Response` with `HttpServerResponse.raw(...)`.
- Add `export const dynamic = 'force-dynamic'` for auth/session/tool routes.
- Provide `AppLayer`; add `FetchHttpClient.layer` when the route itself calls external HTTP.
- Catch specific tags before catch-all; report only at route boundary.

## Status Conventions

- Unauthenticated: `401`.
- Invalid body/schema: `400`.
- Missing/invalid provider auth: `409`.
- Upstream OAuth/provider failure: `502`.
- Unknown boundary failure: `500` with generic body.

## Agent Routes

- See `agent/AGENTS.md` for route-local text/Workflow/commands/Realtime contracts.
- Text route supports model-picked Codex/Claude OAuth providers, `agentTextCapabilities`, and non-empty text+image protocol transcript.
- Workflow route starts `runAgentWorkflow`, returns `run.getReadable()` as NDJSON, and exposes `x-workflow-run-id`.
- Workflow run route supports `GET /api/agent/workflow/:runId` for stream replay/resume and `DELETE /api/agent/workflow/:runId` for `run.cancel()`.
- Commands route requires auth, loads merged project skillset, lists command summaries, and renders selected command macros as normal prompt text.
- Text runtime construction lives in `makeAgentTextResponse` / `makeAgentTextRuntime`; route wrappers keep auth/status boundaries thin.
- Realtime `/call` uses `OPENAI_API_KEY`, accepts raw SDP, returns `application/sdp`.
- Realtime `/tool` uses `@yolk/voice-runtime`; current registry enables `web_fetch` and `web_search` for voice.
- Realtime routes explicitly provide runtime-portable voice tool modules and resolve with `{ surface: 'voice', route: '/agent', userId }`.
- Internal Cloudflare token bridge is app-server-to-Worker only; it supports Codex/Claude providers and returns access token/account/expiry, never refresh token.
- Internal Cloudflare Codex responses proxy is the default DO provider path; it forwards upstream body streams with `HttpServerResponse.raw(...)`.
- Keep Codex proxy allowlist logic in `internal/cloudflare/codex-responses/route-model.ts`; never forward cookies or bridge secrets upstream.

## Exceptions

- `auth/[...all]/route.ts` may use `Effect.runPromise()` to construct better-auth's handler at the Next boundary.
- Workflow `start/getRun` routes may use `Effect.runPromise()` + raw `Response` for Vercel Workflow streams.
- `internal/cloudflare/*` routes require `YOLK_CLOUDFLARE_BRIDGE_SECRET`; do not expose to browsers.
- Browser/WebRTC specifics stay in `app/agent/use-realtime-voice.ts` and `lib/agents/realtime/*`, not route bodies.

## Anti-Patterns

- API route for CRUD/domain mutation — use `lib/core` server action.
- Raw `JSON.parse` for HTTP bodies — use Schema/HttpServerRequest helpers.
- Swallowing route errors silently — report boundary failures via telemetry.
