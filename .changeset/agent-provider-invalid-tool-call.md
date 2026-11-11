---
'@yolk-sdk/agent': patch
---

A provider tool call with an empty or padded id or name now fails the request with a typed `LLMError` (`invalid_response`) instead of a defect.

The OpenAI-compatible chat, Responses (Codex, Grok, OpenCode Go `responses`) and Anthropic providers built their calls with `ToolCall.make`, which throws when the id or name is not a non-empty trimmed string. Models do return such calls (seen in production on a DeepSeek model over OpenCode Go chat completions); the throw escaped as a defect, past the loop's retries, a host's fallback model and its failure handling. The chat provider's failure carries `providerCode: 'invalid_tool_call'` (streamed or not), so OpenCode Go's one-time re-route applies to it when the stream fails before emitting any event.

The chat stream also keeps a call's id and name when a later chunk of that call repeats them as an empty string, rather than erasing them.
