# App Agent Wiring

App-owned provider/runtime glue over the domain-free `packages/*` agent stack.

## Current Mode

- Unified `/agent` UI with text input and mic voice mode
- Text `/api/agent` route and Realtime voice `/api/agent/realtime/*` routes
- Calculator tool wired for tool-call smoke tests
- No durable transcript: text client sends full protocol transcript each turn
- Voice seeds current protocol transcript into Realtime via `conversation.item.create`
- Text route request: `{ sessionId, messages }`, where `messages` is non-empty `AgentMessage[]`
- Text route calls `agent-loop` directly; `agent-runtime` is reserved for durable session lifecycle
- `StatelessSessionStoreLayer` remains no-op scaffolding for future runtime persistence
- Route streams NDJSON token events to browser, including in-band `AgentError` failures
- Browser/client cancellation aborts active response body readers
- Providers use Effect `HttpClient`; app route provides `FetchHttpClient.layer`

## Current Provider

Hardcoded in `app/api/agent/route.ts`:

| Env | Values | Notes |
| --- | --- | --- |
| `AGENT_SYSTEM_PROMPT` | string | Optional override |

Provider is Codex OAuth, model is `gpt-5.4`. Use `makeAgentRuntimeLayerWithTools(providerLayer, toolExecutorLayer)` to provide provider/tool loop deps; keep provider choice at app boundary.

## Current Tools

- File: `tools/calculator-tool.ts`
- Tool name: `calculate`
- Supports `add`, `subtract`, `multiply`, `divide`
- App tool registry: `tools/registry.ts` resolves scoped toolsets via `@yolk/tool-registry`
- Tool context: `{ surface, route, userId }`; add policy gates via `ToolRegistration.isEnabled`
- Shared by text and Realtime voice smoke tests
- Smoke-test only; no durable transcript or product permissions yet

## JSON Boundaries

- Production encode/decode uses `Schema.UnknownFromJsonString` + Effect mapping.
- Avoid raw `JSON.parse/stringify` and `Effect.try` wrappers in providers/routes/packages.
- Browser-only Realtime hook may use raw JSON for data-channel/fetch payloads.
- Direct JSON helpers are fine in tests.

## Realtime Voice

- UI: mic mode in `app/agent/playground.tsx`; `/agent/voice` redirects to `/agent`
- Hook: `app/agent/use-realtime-voice.ts`
- SDP route: `app/api/agent/realtime/call/route.ts`
- Tool route: `app/api/agent/realtime/tool/route.ts`
- Adapter helpers: `realtime/openai-realtime.ts`, `realtime/tool-bridge.ts`
- Model: `gpt-realtime-2`; voice: `marin`; reasoning effort: `low`
- Input transcription: `gpt-realtime-whisper`; completed user transcripts append to shared messages
- Event names: user transcripts `conversation.item.input_audio_transcription.*`; assistant transcript `response.output_audio_transcript.*`; tool calls in `response.done`
- Uses `OPENAI_API_KEY`, not Codex OAuth
- OpenRouter is not supported for Realtime voice: no `gpt-realtime-2`/Realtime endpoints there
- Voice tool context route is `/agent`; `/agent/voice` is legacy redirect only
- Browser owns WebRTC mic/audio/data channel; server owns OpenAI key and tool execution
- Guard stale async WebRTC starts/stops; close peer/data/media resources on cancel/failure
- `@yolk/voice-runtime` owns provider-neutral tool execution bridge
- OpenAI Realtime/WebRTC specifics stay in app-layer adapter files

## OpenAI API-Key Provider

- File: `providers/openai-provider.ts`
- Not wired to `/api/agent` while provider/model are hardcoded
- Uses `https://api.openai.com/v1/chat/completions`
- Requires `OPENAI_API_KEY`
- Supports text + image user input; no audio
- Dormant scaffold; tests inject an Effect `HttpClient` layer

## OpenAI Codex OAuth Provider

- File: `providers/openai-codex-provider.ts`
- Used for ChatGPT Plus/Pro/Max subscription access
- Does **not** use `OPENAI_API_KEY`
- Requires per-user Codex OAuth token from `lib/core/agent/openai-codex-auth.ts`
- Tokens stored in Better Auth `account` table with `providerId = 'openai-codex'`

Codex backend quirks:

- Endpoint: `https://chatgpt.com/backend-api/codex/responses`
- Request must set `store: false`
- Request must set `stream: true`
- Do not send `max_output_tokens`
- Send `originator: opencode`
- Send `ChatGPT-Account-Id` when token has account id
- Response may be SSE even with `content-type: text/plain`; detect by raw `event:`/`data:` body

## Tests

- Provider tests: `providers/*-provider.test.ts`
- Route encoding/schema tests: `route-handler.test.ts`
- Keep regression tests for provider quirks close to provider implementation.
- Mock HTTP with `HttpClient` test layers, not fetch-style helpers.
