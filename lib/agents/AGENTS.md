# App Agent Wiring

App-owned provider/runtime glue over the domain-free `packages/*` agent stack.

## Current Mode

- Text-only `/agent` UI and `/api/agent` route
- Realtime voice `/agent/voice` UI and `/api/agent/realtime/*` routes
- Calculator tool wired for tool-call smoke tests
- No durable transcript: `StatelessSessionStoreLayer` loads empty, save is no-op
- Route streams NDJSON token events to browser, including in-band `AgentError` failures
- Browser/client cancellation aborts active response body readers
- Providers use Effect `HttpClient`; app route provides `FetchHttpClient.layer`

## Current Provider

Hardcoded in `app/api/agent/route.ts`:

| Env | Values | Notes |
| --- | --- | --- |
| `AGENT_SYSTEM_PROMPT` | string | Optional override |

Provider is Codex OAuth, model is `gpt-5.4`. Use `makeAgentRuntimeLayerWithTools(providerLayer, toolExecutorLayer)` when tools are enabled; keep provider choice at app boundary.

## Current Tools

- File: `tools/calculator-tool.ts`
- Tool name: `calculate`
- Supports `add`, `subtract`, `multiply`, `divide`
- Shared by text and Realtime voice smoke tests
- Smoke-test only; no durable transcript or product permissions yet

## Realtime Voice

- UI: `app/agent/voice/voice-playground.tsx`
- SDP route: `app/api/agent/realtime/call/route.ts`
- Tool route: `app/api/agent/realtime/tool/route.ts`
- Adapter helpers: `realtime/openai-realtime.ts`, `realtime/tool-bridge.ts`
- Model: `gpt-realtime-2`; voice: `marin`; reasoning effort: `low`
- Uses `OPENAI_API_KEY`, not Codex OAuth
- OpenRouter is not supported for Realtime voice: no `gpt-realtime-2`/Realtime endpoints there
- Browser owns WebRTC mic/audio/data channel; server owns OpenAI key and tool execution
- Package integration is only shared `ToolDef`/`ToolCall`/`ToolResult` + `ToolExecutor`
- Keep OpenAI Realtime/WebRTC specifics in app layer until a provider-neutral voice runtime emerges

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
