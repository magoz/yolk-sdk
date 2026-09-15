---
'@yolk-sdk/agent': minor
'@yolk-sdk/connectors': patch
---

OpenAI Chat Completions and Responses admit `ToolDef.parameters` and tool-call `params` as `Schema.Json` before transport. Non-JSON fails non-retryable `LLMError` `provider_error`. `ToolDef.parameters` admits a `ToolJsonSchema` representation at construction; tool-call params and results stay opaque. Public Codex `OpenAiCodexTool.parameters` remains `unknown`. Inbound HTTP JSON and Responses SSE JSON admit `Schema.Json`; non-object SSE JSON is ignored, malformed non-JSON event text fails `invalid_response`, and HTTP error bodies stay raw text.

`OpenAiProviderConfig.extraBody` now takes `OpenAiRequestExtras` JSON-object input, also used by Gateway. Request lowering snapshots surviving fields and discards canonical keys without reading their values. Surviving accessors and non-JSON values fail non-retryable `provider_error` with `Invalid … extraBody JSON: expected a JSON object`; getters are not invoked. Composed-body `Schema.Json` serialization after lone-surrogate rewriting remains the final finite-JSON defense.

Public Realtime `OpenAiRealtimeFunctionTool.parameters` and `openAiRealtimeToolParameters` now require `Schema.Json`. Non-JSON advertisement fails `VoiceToolBridgeError` (sync throw / Effect fail). Mapper defects stay defects. Union-root lowering merges own `__proto__` / `constructor` via `Map`.

Gmail `get_thread` / `list_attachments` MIME `payload` admits `Schema.Json` after JSON parse. Best-effort optional size omission and sibling preservation are unchanged. Raw HTTP `1e999` → `Infinity` rejects the whole payload (`ConnectorError` `validation_failed`). Public Gmail action classes and `gmail.get_attachment` are unchanged.
