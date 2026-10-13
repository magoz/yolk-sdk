# Prompt caching

Status: accepted.

Agent turns resend the whole conversation on every model request (`store: false`, no server-side
conversation state). Providers discount a repeated prefix, but only when the request asks for it
or is routed to the server that holds it. Yolk did neither: Anthropic received no `cache_control`
markers (Anthropic caches only marked prefixes, so every Claude request paid full price), Codex and
Grok received no conversation key, the Claude session header was random per provider layer (hosts
rebuild layers per durable step), and nothing let a host change per-request context without
rewriting the prefix.

## Decision summary

| Area          | Decision                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------- |
| Default       | Always on; no policy object. Markers and keys are cheap and providers ignore short prefixes |
| Identity      | `LLMRequest.cacheKey` (host session id), set once on `RunConfig`/`RuntimeConfig`            |
| Volatile data | `LLMRequest.turnContext`: appended after the conversation, never in the transcript          |
| Tool choice   | `LLMRequest.toolChoice: 'none'` forbids calls but keeps tool definitions                    |
| Anthropic TTL | Provider config `promptCacheTtl: '5m' \| '1h'`, default `5m`                                |

## Wire mapping

| Transport                      | Request                                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude subscription            | Markers on the last tool, the conversation end and the previous request's end (3); `X-Claude-Code-Session-Id` is a UUID derived from `cacheKey` |
| Native Messages (OpenCode Go)  | Same, plus the system prompt (4); `x-opencode-session`                                                                                          |
| Codex                          | `prompt_cache_key` and the `session-id` header (official CLI: `codex-api/src/requests/headers.rs`)                                              |
| Grok                           | `prompt_cache_key` and `x-grok-conv-id`                                                                                                         |
| Vercel AI Gateway              | `providerOptions.gateway.caching: 'auto'` (Gateway marks explicit-caching upstreams), `x-session-affinity`                                      |
| OpenCode Go chat / Responses   | `x-opencode-session`                                                                                                                            |
| Generic OpenAI-compatible chat | Nothing (strict endpoints may reject unknown fields); hosts can add `cacheKeyHeaders`                                                           |

`turnContext` follows every Anthropic breakpoint. Gateway's automatic markers land on the last
message (the turn context) and on the message before the last user message, so the stable prefix
before the turn context is still read.

The two conversation breakpoints (last message, and the message before the latest assistant turn)
make each request read exactly what the previous one wrote, even when a turn adds more blocks than
Anthropic's 20-block lookback. The Claude subscription relocates the system prompt into the first
user message after a per-conversation billing block, so a system marker there would only duplicate
the conversation breakpoints; tools come first in the prefix and are shared across conversations.

## Host responsibilities

Caching only pays if the prefix is byte-stable. Hosts:

- pass the session id as `cacheKey`; subagents, background children and compaction reuse the
  parent's key;
- keep the system prompt and tool list stable within a session (no clock or per-turn data in the
  system prompt; deterministic tool order);
- never rewrite earlier messages per request: fresh signed URLs, the current time and other
  per-request facts go in `turnContext`;
- compact with the same system prompt, tools and transcript plus a final summary instruction, so
  the summary request reads the cache instead of resending everything at full price. Keep tool
  choice unchanged: on Anthropic a changed `tool_choice` invalidates the cached messages. Instruct
  the model not to call tools and fall back to a standalone summary if it does. Overflow
  compaction cannot reuse the prefix (the full request does not fit) and stays standalone.

## Not done

- No cost accounting: `AgentInputUsage` already reports `cacheRead`/`cacheWrite`; prices are host
  data.
- No cache policy knobs beyond the Anthropic TTL until a host needs them.
- Gateway automatic caching uses the five-minute lifetime (the chat endpoint has no TTL field).
