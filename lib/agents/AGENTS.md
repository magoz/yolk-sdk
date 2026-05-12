# App Agent Wiring

App-owned provider/runtime glue over the domain-free `packages/*` agent stack.

## Current Mode

- Unified `/agent` UI with text+image input and mic voice mode
- `/agent` UI is app-local/headless-ready; see `app/agent/AGENTS.md` for chat render boundaries
- Text `/api/agent` route and Realtime voice `/api/agent/realtime/*` routes
- Optional Cloudflare direct-WS transport bootstraps from `/agent` when `CLOUDFLARE_AGENT_URL`, `YOLK_APP_URL`, and `YOLK_CLOUDFLARE_BRIDGE_SECRET` are set.
- Live text tools: SSRF-guarded URL fetch + direct Exa/Parallel MCP web search + optional configured MCP tools
- No durable transcript: text client sends full protocol transcript each turn
- Voice seeds current protocol transcript into Realtime via `conversation.item.create`
- Text route request: `{ sessionId, messages, reasoningEffort? }`, where `messages` is non-empty `AgentMessage[]`
- Text route calls stateless `agent-runtime` transcript mode; durable session lifecycle is deferred
- Route streams NDJSON token events to browser, including in-band `AgentError` failures
- Cloudflare DO streams protocol events over WS after `SessionSnapshot`; Next remains canonical Codex refresh owner.
- Route error tests cover canonical `AgentError` mapping for capability and tool failures.
- Route streams `UsageUpdate`, `AgentRetry`, and future compaction lifecycle events in-band.
- `context-budget.ts` owns app text model context window, reserved output, warning, and compaction thresholds.
- `context-transformer.ts` compacts oversized text transcripts with deterministic window-summary events before provider calls.
- Browser/client cancellation aborts active response body readers
- Providers use Effect `HttpClient`; app route provides `FetchHttpClient.layer`
- Providers normalize raw usage into `AgentUsage` and mark retryable errors; loop owns retry policy.

## Current Provider

Hardcoded in `app/api/agent/route.ts`:

| Env                   | Values | Notes             |
| --------------------- | ------ | ----------------- |
| `AGENT_SYSTEM_PROMPT` | string | Optional override |

Provider is Codex OAuth, model is `gpt-5.4`. Text model/reasoning/capabilities live in `text-agent-config.ts`; UI and route import `agentTextCapabilities` from there. Use `makeAgentRuntimeLayerWithTools(providerLayer, toolExecutorLayer)` to provide provider/tool loop deps; keep provider choice at app boundary. Codex provider accepts text+image user input; audio is rejected by capabilities.

Reasoning:

- Text UI sends per-request `reasoningEffort` (`minimal`/`low`/`medium`/`high`/`xhigh`).
- Codex request sets `reasoning.summary = 'auto'`; summaries are optional provider output.
- Show reasoning only from `LLMReasoningDelta` / assistant reasoning parts; never synthesize or label missing reasoning as available.

## Current Tools

- `tools/web-fetch-tool.ts`: `web_fetch`; text/voice public URL fetch; markdown/text/html; no search/browser automation/cookies
- `tools/web-search-tool.ts`: `web_search`; text/voice Exa/Parallel MCP web search; optional `EXA_API_KEY`, `PARALLEL_API_KEY`, `YOLK_WEBSEARCH_PROVIDER`
- `tools/mcp-tool-module.ts`: configured MCP servers; text-only; tools namespaced as `<server>_<tool>`
- Both app tools are enabled for text and voice surfaces
- Configured MCP tools are text-only for v1; voice MCP deferred
- No calculator tool is registered
- `web_fetch` blocks localhost/private/reserved IPs and manually revalidates redirects before fetching
- `web_search` calls provider MCP endpoints directly (`mcp.exa.ai`, `search.parallel.ai`); no Yolk backend proxy
- `web_search` chooses provider by query checksum unless `YOLK_WEBSEARCH_PROVIDER` is set; execution/timeout errors fall back only without override
- App tool registry: `tools/registry.ts` resolves scoped toolsets via `@yolk/tool-registry`
- Tool context: `{ surface, route, userId }`; add policy gates via `ToolRegistration.isEnabled`
- No durable transcript or product permissions yet

Configured MCP env:

Temporary dev/bootstrap source until persisted MCP connections are added (similar ownership boundary as Codex OAuth):

| Env                           | Values | Notes                                                     |
| ----------------------------- | ------ | --------------------------------------------------------- |
| `YOLK_MCP_SERVERS`            | JSON   | `[{ name,type:'remote',url,headers?,enabled? }]` or local |
| `YOLK_MCP_LOCAL_ENABLED`      | bool   | Enables local stdio MCP; default false                    |
| `YOLK_MCP_DEV_HTTP_LOCALHOST` | bool   | Allows `http://localhost` remote MCP; default false       |

MCP security:

- Remote URLs require `https:` unless localhost dev flag is set.
- Localhost dev flag permits `localhost`, `127.0.0.1`, and `[::1]` loopback URLs.
- Local config shape: `{ name, type:'local', command: string[], environment?, enabled? }`.
- Local commands are spawned directly, not through shell strings.
- Local MCP runs through Effect v4 `ChildProcess`/`Stream` APIs; app uses `@yolk/mcp-client/node` wrappers to provide Node services.
- Local servers receive only explicit `environment`; inherited env is disabled.
- Invalid config or unavailable servers log warning and omit those tools.

## JSON Boundaries

- Use Effect Schema at production JSON boundaries; prefer `Schema.UnknownFromJsonString` for unknown JSON strings, and use specific schemas (`Schema.fromJsonString(...)`) when the payload shape is known.
- Avoid raw `JSON.parse/stringify` and `Effect.try` wrappers in providers/routes/packages.
- Browser-only Realtime hook may use raw JSON for data-channel payloads; HTTP uses Effect `HttpClient`.
- Direct JSON helpers are fine in tests.

## Realtime Voice

- UI: mic mode in `app/agent/playground.tsx`; `/agent/voice` redirects to `/agent`
- Hook: `app/agent/use-realtime-voice.ts`
- SDP route: `app/api/agent/realtime/call/route.ts`
- Tool route: `app/api/agent/realtime/tool/route.ts`
- `/call` mints OpenAI Realtime SDP using `OPENAI_API_KEY`; `/tool` executes provider-neutral voice tool calls
- Adapter helpers: `realtime/openai-realtime.ts`, `realtime/tool-bridge.ts`
- Model: `gpt-realtime-2`; voice: `marin`; reasoning effort: `low`
- Input transcription: user-selectable in agent console via `transcriptionModel` query param; default `gpt-realtime-whisper`; also supports `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-mini-transcribe-2025-12-15`
- Prompted transcription models receive prompt `Transcribe English speech. Preserve exact words.`; `gpt-realtime-whisper` omits prompt
- Completed user transcripts append to shared messages
- Event names: input transcripts `conversation.item.input_audio_transcription.*`; assistant transcripts `response.output_audio_transcript.*` or `response.audio_transcript.*`; session config `session.created`/`session.updated`; tool calls are `function_call` items inside `response.done.response.output`
- Uses `OPENAI_API_KEY`, not Codex OAuth
- OpenRouter is not supported for Realtime voice: no `gpt-realtime-2`/Realtime endpoints there
- Voice tool context route is `/agent`; `/agent/voice` is legacy redirect only
- Browser owns WebRTC mic/audio/data channel; server owns OpenAI key and tool execution
- Guard stale async WebRTC starts/stops; close peer/data/media resources on cancel/failure
- `@yolk/voice-runtime` owns provider-neutral tool execution bridge; app voice toolset includes `web_fetch` and `web_search`
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
- Cloudflare token bridge returns access/account/expiry only; keep refresh token in Next/Postgres.
- Tokens stored in Better Auth `account` table with `providerId = 'openai-codex'`; `accountId` stores ChatGPT account id when present
- Device-flow server actions live in `lib/core/agent/*-action.ts`; they redirect unauthenticated users, save/delete tokens, and revalidate `/agent`
- `getValidOpenAiCodexToken()` refreshes expired tokens and persists the refreshed token before provider use

Route status conventions:

- Text route returns `401` unauthenticated, `409` missing/invalid Codex auth, `502` OAuth/provider failures

Codex backend quirks:

- Endpoint: `https://chatgpt.com/backend-api/codex/responses`
- Request must set `store: false`
- Request must set `stream: true`
- Do not send `max_output_tokens`
- Send `originator: opencode`
- Send `ChatGPT-Account-Id` when token has account id
- User `ImagePart` maps to Responses content `{ type: 'input_image', image_url: 'data:<mime>;base64,<data>' }`
- Response may be SSE even with `content-type: text/plain`; detect by raw `event:`/`data:` body
- Reasoning can arrive as `response.reasoning_summary_text.delta` / `response.reasoning_text.delta` or final `reasoning.summary`
- Text can arrive as `response.output_text.delta`, `response.content_part.delta`, or `response.output_item.done` message items; stream output items before completion
- Tool calls may arrive before completion as `response.output_item.done` with `item.type = 'function_call'`; parse immediately and tolerate empty final `response.completed`
- If any tool call streamed before completion, final loop `LLMDone` must be `tool_use` even when `response.completed.output` is empty

Image TODOs:

- `/api/agent` validates image count, MIME, base64 shape, per-image size, and total image payload before provider calls.
- Keep Codex image mapping covered by provider tests whenever Responses payload shape changes.
- If adding provider switching, derive image support from selected provider capabilities, not from UI assumptions.

## Tests

- Provider tests: `providers/*-provider.test.ts`
- Route encoding/schema tests: `route-handler.test.ts`
- Keep regression tests for provider quirks close to provider implementation.
- Mock HTTP with `HttpClient` test layers, not fetch-style helpers.
