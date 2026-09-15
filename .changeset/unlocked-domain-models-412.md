---
'@yolk-sdk/agent': minor
---

Claude lowering requires `ToolDef.parameters` and `ToolCall.params` to decode as `Schema.Json`; non-JSON fails non-retryable `LLMError` `provider_error`. Lone-surrogate rewrite is re-decoded as JSON (failure, not skip). HTTP non-JSON errors still classify from status.

`useAgentChat` dispatches/returns the existing `AgentChatAction` and hook-result constructors (`Data.taggedEnum` plains, `_tag` last, not Equal/Hash classes). Prefer constructors and `$is`; omit absent optionals. `Schema.TaggedStruct.make` still validates duration plains.
