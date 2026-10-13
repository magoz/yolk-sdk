---
'@yolk-sdk/agent': minor
---

Enable provider prompt caching (ADR 0008). `LLMRequest` gains `cacheKey` (also on `RunConfig` and
`RuntimeConfig`), `turnContext` and `toolChoice`. Anthropic requests always carry `cache_control`
breakpoints (last tool, conversation end, previous request's end; native Messages also the system
prompt) with a configurable `promptCacheTtl` on the Claude provider, and the Claude session header
is derived from `cacheKey`. Codex and Grok send `prompt_cache_key` plus their session headers,
Vercel AI Gateway sends `caching: 'auto'` and `x-session-affinity`, and OpenCode Go sends
`x-opencode-session`. `turnContext` is appended after the conversation (after every Anthropic breakpoint); `toolChoice: 'none'` keeps
tool definitions while forbidding calls (on Anthropic it invalidates cached messages). The generic OpenAI-compatible chat provider sends nothing unless its new
optional `cacheKeyHeaders` config is set. The `@yolk-sdk/emulators` OpenCode Go Messages recording
now expects the cache markers.
