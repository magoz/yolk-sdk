---
'@yolk-sdk/agent': patch
---

Read `null` as absent in optional Chat Completions fields, and name the field a malformed stream chunk failed.

OpenAI-compatible hosts send `null` for optional fields they leave unset: `"tool_calls": null`, `"id": null` and `"name": null` on continuation tool-call deltas, `"delta": null`, `"usage": null` on every chunk before the usage chunk, and `null` usage details. The chat parser rejected all of these except `content` and `finish_reason`, failing the turn with `invalid_stream_chunk` (or `invalid_usage`). Every optional field in stream chunks, tool-call deltas, `message.tool_calls`, `usage`, and the usage details now reads `null` as absent. Required fields and `choices` stay strict, and a streamed tool call whose id or name never arrives still fails `invalid_tool_call`.

`ProviderStreamDiagnostics` gains optional `invalidField` (`ProviderStreamInvalidField`: `path`, `received`), set on `invalid_stream_chunk`. `path` names the first rejected field in the schema's own field names (`$.choices[].delta.tool_calls[].id`) and `received` its JSON type (`ProviderStreamFieldType`), never the value, so hosts can log which field broke.
