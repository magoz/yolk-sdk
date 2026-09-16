---
'@yolk-sdk/agent': patch
---

Stream OpenAI-compatible chat completions as server-sent events when enabled.

The shared chat provider was request/response-only, so hosts saw whole turns at once. `OpenAiProviderConfig.streaming` now requests incremental `chat.completion.chunk` deltas (with `stream_options.include_usage`) and folds them into text/reasoning/tool-call events plus terminal and usage events, mirroring the Responses SSE terminal policy: unterminated streams fail `invalid_response` and never emit `Done`. OpenCode Go chat models opt in; the default JSON behavior is unchanged.
