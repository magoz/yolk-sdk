# Provider Regression Tests

Provider adapters live in public packages. This directory keeps Next-owned integration regressions
that exercise package-backed providers through app runtime wiring.

## Providers

| Package subpath | Role |
| ---- | ---- |
| `@yolk-sdk/agent/providers/openai/codex-provider` | Active ChatGPT Codex OAuth provider (`gpt-5.5`) |
| `@yolk-sdk/agent/providers/anthropic/claude-provider` | Active Claude OAuth provider (`claude-sonnet-4-6`) |
| `@yolk-sdk/agent/providers/openai/provider` | Dormant API-key Chat Completions scaffold |

## Model policy

- Text model/reasoning/capabilities live in `examples/next/lib/agents/text-agent-config.ts`.
- Active text providers: Codex OAuth (`gpt-5.5`) and Anthropic Claude OAuth (`claude-sonnet-4-6`).
- Provider choice is app boundary policy; package providers implement `LLMProvider` only.
- Text UI sends per-request `reasoningEffort` (`minimal`/`low`/`medium`/`high`/`xhigh`).
- Codex requests set `reasoning.summary = 'auto'`; summaries are optional provider output.

## Boundaries

- Providers implement `LLMProvider`; they do not choose model policy or tools.
- Token lookup/refresh stays in `examples/next/lib/core/agent/*-auth.ts`; runtime wiring converts app token rows to `OAuthAccessToken` for package providers.
- Use Effect `HttpClient`; tests inject fake clients.
- Normalize all usage into protocol `AgentUsage`.
- Mark retryability at provider boundary; loop owns retry policy.
- Message envelope rendering belongs in package protocol helpers; app regressions may assert package providers preserve `createdAtMs`, `author.displayName`, and `annotations`.

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
- Requests use Bearer auth with Claude Code OAuth compatibility headers from `@yolk-sdk/agent/providers/anthropic`.
- Requests set `stream: true` and parse SSE/JSON by body shape; content-type may be misleading behind gateways.
- Request shape must mimic Claude Code OAuth fingerprinting:
  - `system[]` contains only Claude Code billing header + `You are Claude Code, Anthropic's official CLI for Claude.`
  - app/system instructions are prepended to the first user message
  - tools are sent as `mcp_` names with first letter uppercased (`weather` → `mcp_Weather`)
  - tool `input_schema` roots are provider-safe objects; top-level schema combinators are flattened in `@yolk-sdk/agent/providers/anthropic`
  - tool input JSON arrives as partial SSE deltas; concatenate before decoding
  - model tool calls are unprefixed back to app tool names
- Anthropic can return misleading 429/usage errors when this fingerprint drifts.

## OpenAI Codex OAuth quirks

- Used for ChatGPT Plus/Pro/Max subscription access.
- Does **not** use `OPENAI_API_KEY`.
- Requires per-user token from `examples/next/lib/core/agent/openai-codex-auth.ts`.
- Cloudflare Codex calls use brokered access tokens from Next, then stream through the internal Next Codex response proxy by default.
- Direct DO ↔ Codex WebSocket code is retained only for unproxied experiments.

## Tests

- Package unit tests live under `packages/agent/test/providers`.
- App regression tests here cover package providers through Next-style HTTP layers and runtime assumptions.
- Keep coverage for images, tool calls, reasoning deltas, usage, empty responses, cancellation, malformed SSE JSON, invalid tool-call arguments, and provider-emitted SSE errors.
