---
'@yolk-sdk/agent': minor
'@yolk-sdk/connectors': patch
---

OpenAI Chat Completions and Responses admit `ToolDef.parameters` and tool-call `params` as `Schema.Json` before transport. Non-JSON fails non-retryable `LLMError` `provider_error`. Protocol tool fields stay `Schema.Unknown`. Public Codex `OpenAiCodexTool.parameters` remains `unknown`. Inbound HTTP JSON and Responses SSE JSON admit `Schema.Json`; non-object SSE JSON is ignored, malformed non-JSON event text fails `invalid_response`, and HTTP error bodies stay raw text.

`OpenAiProviderConfig.extraBody` stays `Readonly<Record<string, unknown>>`. Canonical fields override after spread; `Schema.Json` admits the composed body at serialization after the existing lone-surrogate rewrite, so discarded override keys do not fail. Surviving non-JSON extras fail `provider_error` (`Could not serialize … request`) before transport. Nested getters are read once during rewriting, not by an extra lowering-time validation walk; unexpected getter throws remain defects. Gateway extraBody typing is unchanged.

Public Realtime `OpenAiRealtimeFunctionTool.parameters` and `openAiRealtimeToolParameters` now require `Schema.Json`. Non-JSON advertisement fails `VoiceToolBridgeError` (sync throw / Effect fail). Mapper defects stay defects. Union-root lowering merges own `__proto__` / `constructor` via `Map`.

Gmail `get_thread` / `list_attachments` MIME `payload` admits `Schema.Json` after JSON parse. Best-effort optional size omission and sibling preservation are unchanged. Raw HTTP `1e999` → `Infinity` rejects the whole payload (`ConnectorError` `validation_failed`). Public Gmail action classes and `gmail.get_attachment` are unchanged.
