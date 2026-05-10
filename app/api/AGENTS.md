# API Routes

HTTP boundaries for auth, agent text, and Realtime voice. CRUD/product mutations belong in server actions, not routes.

## Routes

| Route                          | Role                         |
| ------------------------------ | ---------------------------- |
| `auth/[...all]/route.ts`       | better-auth Next handler     |
| `agent/route.ts`               | Text agent NDJSON stream     |
| `agent/realtime/call/route.ts` | OpenAI Realtime SDP exchange |
| `agent/realtime/tool/route.ts` | Voice tool execution bridge  |

## Effect Route Pattern

- Use `HttpEffect.toWebHandlerLayer(handler, Layer)` for Effect-backed routes.
- Parse JSON with `HttpServerRequest.schemaBodyJson(...)`.
- Return `HttpServerResponse.*`; wrap raw streamed `Response` with `HttpServerResponse.raw(...)`.
- Add `export const dynamic = 'force-dynamic'` for auth/session/tool routes.
- Provide `AppLayer`; add `FetchHttpClient.layer` when the route itself calls external HTTP.
- Catch specific tags before catch-all; report only at route boundary.

## Status Conventions

- Unauthenticated: `401`.
- Invalid body/schema: `400`.
- Missing/invalid Codex auth: `409`.
- Upstream OAuth/provider failure: `502`.
- Unknown boundary failure: `500` with generic body.

## Agent Routes

- Text route requires Codex OAuth token, model `gpt-5.4`, and non-empty protocol transcript.
- Text route resolves tools with `{ surface: 'text', route: '/agent', userId }`.
- Realtime `/call` uses `OPENAI_API_KEY`, accepts raw SDP, returns `application/sdp`.
- Realtime `/tool` uses `@yolk/voice-runtime`; current registry enables `web_fetch` and `web_search` for voice.
- Realtime routes resolve voice tools with `{ surface: 'voice', route: '/agent', userId }`.

## Exceptions

- `auth/[...all]/route.ts` may use `Effect.runPromise()` to construct better-auth's handler at the Next boundary.
- Browser/WebRTC specifics stay in `app/agent/use-realtime-voice.ts` and `lib/agents/realtime/*`, not route bodies.

## Anti-Patterns

- API route for CRUD/domain mutation — use `lib/core` server action.
- Raw `JSON.parse` for HTTP bodies — use Schema/HttpServerRequest helpers.
- Swallowing route errors silently — report boundary failures via telemetry.
