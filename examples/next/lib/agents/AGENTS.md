# App Agent Wiring

App-owned provider/runtime glue over the domain-free `packages/*` agent stack.

## Current Mode

- `/agent` runtime chooser; `/agent/next`, `/agent/cloudflare`, and `/agent/workflow` share text+image input and mic voice mode.
- Text `/api/agent` route, Workflow text `/api/agent/workflow` route, and Realtime voice `/api/agent/realtime/*` routes.
- Default text prompt says tools run in parallel and distinguishes durable user knowledge from storage sources.
- Next text runtime has no durable transcript: client sends full protocol transcript each turn.
- Workflow text runtime has durable execution/streaming; product transcript is still client-owned per turn in v1.
- Cloudflare direct WS uses append-backed runtime. Missing env/bootstrap is explicit; no `/api/agent` fallback.
- Route/runtime adapters choose package provider layers + tool modules explicitly; do not hide model/tool policy in globals.
- Route streams NDJSON token events to browser, including `UsageUpdate`, `AgentRetry`, compaction lifecycle, and in-band `AgentError` failures.
- Browser/client cancellation aborts active response body readers.

## Map

| Area | Docs |
| --- | --- |
| Providers | `providers/AGENTS.md` |
| Tools | `tools/AGENTS.md` |
| MCP config source | `mcp/AGENTS.md` |
| Skillset sources | `skillset/AGENTS.md` |
| Workflow runtime | `workflow-runtime/AGENTS.md` |
| Realtime voice adapters | `realtime/AGENTS.md` |
| Agent UI | `examples/next/app/agent/AGENTS.md` |
| Agent API routes | `examples/next/app/api/agent/AGENTS.md` |

## Models + Providers

- Configured in `text-agent-config.ts`; UI/routes import `agentTextModelOptions`, `agentTextCapabilities`, and reasoning defaults from there.
- Package providers are Codex OAuth (`@yolk-sdk/openai/codex-provider`) and Anthropic Claude OAuth (`@yolk-sdk/anthropic/claude-provider`).
- Providers accept text+image user input; audio is rejected by text capabilities.
- Providers use Effect `HttpClient`; app runtimes provide `FetchHttpClient.layer`.
- Providers normalize raw usage into `AgentUsage` and mark retryable errors; loop owns retry policy.
- Show reasoning only from `LLMReasoningDelta` / assistant reasoning parts; never synthesize or label missing reasoning as available.

## Runtime Contracts

- Text route request: `{ sessionId, messages, hitlResponses?, model?, reasoningEffort? }`, where `messages` is non-empty `AgentMessage[]`.
- Text route calls stateless `@yolk-sdk/agent/runtime` transcript mode; Cloudflare DO uses append-backed runtime mode.
- Next/Workflow/Cloudflare text runtimes expose package `question` HITL; Next/Workflow also expose package `task` for top-level subagent delegation.
- Task subagent types are `general` and `explore` in `workflow-runtime/text-response.ts`; subagents run normal text tools but without `task`, so recursive subagents are disabled in v1.
- Task results include structured subagent metadata for status, timing, model, and ids.
- Parallel task execution requires multiple `task` calls in the same assistant turn; `parallel_tool_calls: true` is a hint.
- Workflow text runtime exposes run id in Activity; replay uses `GET /api/agent/workflow/:runId`; HITL resume posts one response; stop calls `DELETE`.
- Voice seeds current protocol transcript into Realtime via `conversation.item.create`.

## JSON Boundaries

- Use Effect Schema at production JSON boundaries; prefer `Schema.UnknownFromJsonString` for unknown JSON strings.
- Avoid raw `JSON.parse/stringify` and `Effect.try` wrappers in providers/routes/packages.
- Browser-only Realtime hook may use raw JSON for data-channel payloads; HTTP uses Effect `HttpClient`.
- Direct JSON helpers are fine in tests.

## Tests

- Provider tests: `providers/*-provider.test.ts`.
- Route encoding/schema tests: `route-handler.test.ts`.
- Workflow source guard: `workflow-runtime/run-agent-workflow.test.ts` keeps Effect runtime calls out of `"use workflow"` orchestration; put Effect work in `"use step"` functions only.
- Mock HTTP with `HttpClient` test layers, not fetch-style helpers.
