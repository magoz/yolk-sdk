# App Agent Wiring

App-owned provider/runtime glue over the domain-free `packages/*` agent stack.

## Current Mode

- `/agent` runtime chooser; `/agent/next`, `/agent/cloudflare`, and `/agent/workflow` share text+image input and mic voice mode
- Agent UI is app-local/headless-ready; see `app/agent/AGENTS.md` for chat render boundaries
- Text `/api/agent` route, Workflow text `/api/agent/workflow` route, and Realtime voice `/api/agent/realtime/*` routes
- Cloudflare direct-WS transport bootstraps only from `/agent/cloudflare`; missing env/bootstrap is explicit, no `/api/agent` fallback.
- Next text runtime tools: runtime-portable public URL fetch + direct Exa/Parallel MCP web search + just-bash virtual shell + skill + optional remote MCP tools from project files.
- Next/Workflow text runtime exposes a package-owned `task` tool for top-level subagent delegation. Built-in subagent types are `general` and `explore`.
- Task subagents run with normal text tools but without the `task` tool, so recursive subagents are disabled in v1.
- Task subagents stream `ToolExecution*` plus `SubagentStarted`/`SubagentCompleted`; final task results include structured subagent metadata for status, timing, model, and ids.
- Parallel task execution requires the provider to emit multiple `task` calls in the same assistant turn; `parallel_tool_calls: true` is a hint, not a guarantee.
- Cloudflare text runtime wires the same runtime-portable base tools and optional remote MCP tools passed through bootstrap.
- Next text runtime has no durable transcript: client sends full protocol transcript each turn
- Workflow text runtime has durable execution/streaming, but product transcript is still client-owned per turn in v1
- Workflow durable model/tool loop contract imports from `@yolk/vercel-workflows-runtime/workflow`; app keeps route/auth/provider/tool wrappers, while package-owned directives are covered by Workflow Vitest integration tests.
- Workflow text runtime exposes run id in the Activity panel; stream replay uses `GET /api/agent/workflow/:runId`; stop also calls `DELETE /api/agent/workflow/:runId`.
- Voice seeds current protocol transcript into Realtime via `conversation.item.create`
- Text route request: `{ sessionId, messages, model?, reasoningEffort? }`, where `messages` is non-empty `AgentMessage[]`
- Text route calls stateless `@yolk/agent/runtime` transcript mode; Cloudflare DO uses append-backed runtime mode
- Routes/runtime adapters provide their tool modules explicitly; do not hide tool policy in a global resolver.
- Route streams NDJSON token events to browser, including in-band `AgentError` failures
- Cloudflare DO streams protocol events over WS after `SessionSnapshot`; Next remains canonical OAuth refresh owner/token broker and Codex HTTP stream proxy.
- Route error tests cover canonical `AgentError` mapping for capability and tool failures.
- Route streams `UsageUpdate`, `AgentRetry`, and compaction lifecycle events in-band.
- `context-budget.ts` owns app text model context window, reserved output, warning, and compaction thresholds.
- `context-transformer.ts` compacts oversized text transcripts for Next/Workflow text runtime; Cloudflare currently uses identity transformer.
- Browser/client cancellation aborts active response body readers
- Providers use Effect `HttpClient`; app route provides `FetchHttpClient.layer`
- Providers normalize raw usage into `AgentUsage` and mark retryable errors; loop owns retry policy.

## Current Providers

Provider-local rules live in `providers/AGENTS.md`.

Configured in `lib/agents/text-agent-config.ts`; selected by UI and routed in `app/api/agent/route.ts` / `cloudflare/agent/src/yolk-agent.ts`:

| Env                   | Values | Notes             |
| --------------------- | ------ | ----------------- |
| `AGENT_SYSTEM_PROMPT` | string | Optional override |

Providers are Codex OAuth (`gpt-5.4`) and Anthropic Claude OAuth (`claude-sonnet-4-6`). Text model/reasoning/capabilities live in `text-agent-config.ts`; UI and route import `agentTextModelOptions` / `agentTextCapabilities` from there. Use `makeAgentRuntimeLayerWithTools(providerLayer, toolExecutorLayer)` to provide provider/tool loop deps; keep provider choice at app boundary. Providers accept text+image user input; audio is rejected by capabilities.

Reasoning:

- Text UI sends per-request `reasoningEffort` (`minimal`/`low`/`medium`/`high`/`xhigh`).
- Codex request sets `reasoning.summary = 'auto'`; summaries are optional provider output.
- Claude OAuth requests use Bearer auth with Claude Code headers/betas (`claude-code-20250219`, `oauth-2025-04-20`).
- Show reasoning only from `LLMReasoningDelta` / assistant reasoning parts; never synthesize or label missing reasoning as available.

## Current Tools

Tool-local runtime portability rules live in `tools/AGENTS.md`.

- Tool ownership is per route/runtime adapter for now. A future app-layer `AgentDefinition` may centralize model/prompt/tools/skillset/MCP once product agent boundaries are clearer.
- App tools in `lib/agents/tools/*` must be runtime-portable: no Node-only imports, no raw `fetch()`, use Effect `Config`/`HttpClient`/Schema and injected adapters.
- `tools/web-fetch-tool.ts`: `web_fetch`; text/voice public URL fetch; markdown/text/html; no search/browser automation/cookies
- `tools/web-search-tool.ts`: `web_search`; text/voice Exa/Parallel MCP web search; optional `EXA_API_KEY`, `PARALLEL_API_KEY`, `YOLK_WEBSEARCH_PROVIDER`
- `tools/just-bash-tool.ts`: `just_bash`; text-only virtual shell with fresh per-call in-memory filesystem; script/cwd/stdin/timeout params only; curl enabled with literal private/loopback hosts denied; no host filesystem/JS/Python
- `tools/storage-rag-tool.ts`: storage source discovery + RAG search tools; Next/Workflow text-only over app RAG/DB adapters; omitted from Cloudflare bootstrap
- `tools/mcp-tool-module.ts`: configured remote MCP servers; text-only; tools namespaced as `<server>_<tool>`
- `mcp/file-source.ts`: filesystem boundary for `.yolk/mcp.json` / `.opencode/mcp.json`; pass parsed configs into tool modules/bootstrap.
- `tools/resolve-toolset.ts`: module-explicit resolver over `@yolk/agent/tools`; use this at new route/runtime boundaries.
- `web_fetch`/`web_search` are text+voice; `just_bash`, skill, and remote MCP tools are text-only.
- Configured MCP tools are text-only for v1; voice MCP deferred
- No calculator tool is registered
- `web_fetch` blocks localhost/private/reserved IPs and manually revalidates redirects before fetching
- `web_search` calls provider MCP endpoints directly (`mcp.exa.ai`, `search.parallel.ai`); no Yolk backend proxy
- `web_search` chooses provider by query checksum unless `YOLK_WEBSEARCH_PROVIDER` is set; execution/timeout errors fall back only without override
- App tool registry: `tools/registry.ts` exposes route-selectable runtime-portable tool module sets; `tools/resolve-toolset.ts` resolves caller-provided modules via `@yolk/agent/tools`
- Cloudflare adapter imports shared text tool composition via `cloudflare/agent/src/tool-modules.ts`; parity tests cover base tools and fake remote MCP.
- Tool context: `{ surface, route, userId }`; add policy gates via `ToolRegistration.isEnabled`
- Text tool context may include `sessionId` and `subagent` for delegated task execution/policy.
- Subagent runtime/tool failures should return `ToolResult.isError = true` so parent turns and sibling tasks can continue.
- No product permissions yet; durable transcript exists only in Cloudflare DO runtime

Configured MCP source:

- Next loads remote MCP servers from `.yolk/mcp.json` or `.opencode/mcp.json`.
- `/agent/cloudflare` passes the loaded remote MCP servers in the bootstrap payload; the Worker/DO must not read host env or filesystem.
- Config shape is a JSON array: `[{ "name": "docs", "type": "remote", "url": "https://example.com/mcp", "headers": {}, "enabled": true }]`.
- Tool modules receive MCP config as data (`makeMcpToolModule(configs)`); they never read env.

MCP security:

- Remote URLs require `https:`.
- Local stdio MCP remains package-level only; app tools must not import `@yolk/mcp/client/node` or provide Node process services.
- Invalid config or unavailable servers log warning and omit those tools.

## JSON Boundaries

- Use Effect Schema at production JSON boundaries; prefer `Schema.UnknownFromJsonString` for unknown JSON strings, and use specific schemas (`Schema.fromJsonString(...)`) when the payload shape is known.
- Avoid raw `JSON.parse/stringify` and `Effect.try` wrappers in providers/routes/packages.
- Browser-only Realtime hook may use raw JSON for data-channel payloads; HTTP uses Effect `HttpClient`.
- Direct JSON helpers are fine in tests.

## Realtime Voice

- UI: mic mode in `app/agent/playground.tsx`; no separate voice route
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
- Voice tool context route is `/agent`; runtime pages share voice UI
- Browser owns WebRTC mic/audio/data channel; server owns OpenAI key and tool execution
- Guard stale async WebRTC starts/stops; close peer/data/media resources on cancel/failure
- `@yolk/voice-runtime` owns provider-neutral tool execution bridge; app voice toolset includes `web_fetch` and `web_search`
- OpenAI Realtime/WebRTC specifics stay in app-layer adapter files

## OpenAI API-Key Provider

- File: `providers/openai-provider.ts`
- Dormant/default legacy API-key layer; active text routes use model-picked Codex/Claude OAuth providers
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
- Cloudflare Codex calls use brokered access tokens from Next, then stream through the internal Next Codex response proxy by default. Browser ↔ Worker/DO remains WebSocket; DO ↔ Next proxy is HTTP stream. Direct DO ↔ Codex WebSocket code is retained only for unproxied configs/experiments.
- Tokens stored in Better Auth `account` table with `providerId = 'openai-codex'`; `accountId` stores ChatGPT account id when present
- Device-flow server actions live in `lib/core/agent/*-action.ts`; they redirect unauthenticated users, save/delete tokens, and revalidate `/agent`
- `getValidOpenAiCodexToken()` refreshes expired tokens and persists the refreshed token before provider use

## Anthropic Claude OAuth Provider

- File: `providers/anthropic-claude-provider.ts`
- Used for Claude Pro/Max subscription access via model `claude-sonnet-4-6`
- Does **not** use `ANTHROPIC_API_KEY`
- Requires per-user Claude OAuth token from `lib/core/agent/anthropic-claude-auth.ts`
- Cloudflare token bridge returns access/expiry only; keep refresh token in Next/Postgres.
- Tokens stored in Better Auth `account` table with `providerId = 'anthropic-claude'`
- Manual PKCE server actions live in `lib/core/agent/*anthropic-claude*-action.ts`; verifier cookie name lives in non-`use server` module.
- `getValidAnthropicClaudeToken()` refreshes expired tokens and persists the refreshed token before provider use

Route status conventions:

- Text route returns `401` unauthenticated, `409` missing/invalid provider auth, `502` OAuth/provider failures

Codex backend quirks:

- Endpoint: `https://chatgpt.com/backend-api/codex/responses`
- Provider accepts an override `responsesUrl` and `extraHeaders` for trusted server-side proxies only.
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
- Workflow runtime source guard: `workflow-runtime/run-agent-workflow.test.ts` keeps Effect runtime calls out of `"use workflow"` orchestration; put Effect work in `"use step"` functions only.
- Keep regression tests for provider quirks close to provider implementation.
- Mock HTTP with `HttpClient` test layers, not fetch-style helpers.
