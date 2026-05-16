# Agent Providers

App-owned provider adapters from protocol requests to vendor APIs.

## Providers

| File | Role |
| ---- | ---- |
| `openai-codex-provider.ts` | Active ChatGPT Codex OAuth provider (`gpt-5.4`) |
| `anthropic-claude-provider.ts` | Active Claude OAuth provider (`claude-sonnet-4-6`) |
| `openai-provider.ts` | Dormant API-key Chat Completions scaffold |

## Boundaries

- Providers implement `LLMProvider`; they do not choose model policy or tools.
- Token lookup/refresh stays in `lib/core/agent/*-auth.ts`; providers receive valid access tokens via runtime wiring.
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

## Tests

- Keep vendor event-shape regressions near provider implementation.
- Cover request lowering, images, tool calls, reasoning deltas, usage, empty responses, cancellation.
- Anthropic Claude provider tests cover multimodal/tool transcript lowering, thinking/tool-use response events, cache usage normalization, and retryable rate-limit errors.
- OpenAI Codex provider tests cover malformed SSE JSON, invalid tool-call arguments, and provider-emitted SSE error events.
