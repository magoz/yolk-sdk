# Agent Providers

App-owned provider adapters from protocol requests to vendor APIs.

## Providers

| File | Role |
| ---- | ---- |
| `openai-codex-provider.ts` | Active ChatGPT Codex OAuth provider (`gpt-5.4`) |
| `anthropic-claude-provider.ts` | Active Claude OAuth provider (`claude-sonnet-4-6`) |
| `openai-provider.ts` | Dormant API-key Chat Completions scaffold |

## Model policy

- Text model/reasoning/capabilities live in `examples/next/lib/agents/text-agent-config.ts`.
- Active text providers: Codex OAuth (`gpt-5.4`) and Anthropic Claude OAuth (`claude-sonnet-4-6`).
- Provider choice is app boundary policy; providers implement `LLMProvider` only.
- Text UI sends per-request `reasoningEffort` (`minimal`/`low`/`medium`/`high`/`xhigh`).
- Codex requests set `reasoning.summary = 'auto'`; summaries are optional provider output.

## Boundaries

- Providers implement `LLMProvider`; they do not choose model policy or tools.
- Token lookup/refresh stays in `examples/next/lib/core/agent/*-auth.ts`; providers receive valid access tokens via runtime wiring.
- Use Effect `HttpClient`; tests inject fake clients.
- Normalize all usage into protocol `AgentUsage`.
- Mark retryability at provider boundary; loop owns retry policy.

## Codex quirks

- Endpoint: `https://chatgpt.com/backend-api/codex/responses` unless trusted proxy override is supplied.
- Request uses `store: false`, `stream: true`, `originator: opencode`, and no `max_output_tokens`.
- Forward `ChatGPT-Account-Id` when token has account id.
- Treat SSE as valid even when content-type is `text/plain`; parse by body shape.
- Function calls may arrive before completion as `response.output_item.done`; emit tool use immediately.
- If any function call streamed, final `LLMDone` is `tool_use` even with empty final output.
- Reasoning summaries come only from provider events/final summaries; never fabricate reasoning.

## Anthropic Claude OAuth quirks

- Used for Claude Pro/Max subscription access via `claude-sonnet-4-6`.
- Does **not** use `ANTHROPIC_API_KEY`.
- Requires per-user token from `examples/next/lib/core/agent/anthropic-claude-auth.ts`.
- Requests use Bearer auth with Claude Code headers/betas (`claude-code-20250219`, `oauth-2025-04-20`).
- Request shape must mimic Claude Code OAuth fingerprinting:
  - `system[]` contains only `You are Claude Code, Anthropic's official CLI for Claude.`
  - app/system instructions are prepended to the first user message
  - tools are sent as PascalCase `mcp_` names (`weather` → `mcp_Weather`)
  - model tool calls are unprefixed back to app tool names
- Anthropic can return misleading 429/usage errors when this fingerprint drifts.

## OpenAI Codex OAuth quirks

- Used for ChatGPT Plus/Pro/Max subscription access.
- Does **not** use `OPENAI_API_KEY`.
- Requires per-user token from `examples/next/lib/core/agent/openai-codex-auth.ts`.
- Cloudflare Codex calls use brokered access tokens from Next, then stream through the internal Next Codex response proxy by default.
- Direct DO ↔ Codex WebSocket code is retained only for unproxied experiments.

## Tests

- Keep vendor event-shape regressions near provider implementation.
- Cover request lowering, images, tool calls, reasoning deltas, usage, empty responses, cancellation.
- Anthropic Claude provider tests cover multimodal/tool transcript lowering, thinking/tool-use response events, cache usage normalization, and retryable rate-limit errors.
- OpenAI Codex provider tests cover malformed SSE JSON, invalid tool-call arguments, and provider-emitted SSE error events.
