---
'@yolk-sdk/emulators': patch
'@yolk-sdk/agent': patch
---

Add `@yolk-sdk/emulators/openai`: `makeOpenAiEmulator`, an experimental fetch-handler emulator of OpenAI Chat Completions (`POST /v1/chat/completions` on `https://api.openai.com`) with the OpenAI error envelope `{ error: { message, type, param, code } }` (404 `model_not_found` for unknown models, 401 `invalid_api_key` without a bearer credential), plus `openAiEmulatorRoutes`, its unverified route evidence manifest linked to the new OpenAI chat conformance cases. Reasoning models are not emulated for `/openai` yet. It shares an internal Chat Completions core with the Gateway emulator, whose API and wire behaviour are unchanged except that both ledgers now also record the output-token limit (`max_tokens` for the Gateway, `max_completion_tokens` for OpenAI) as `maxCompletionTokens`, without validating it.

Add `@yolk-sdk/agent/providers/openai/conformance`: four synthetic, unverified OpenAI Chat Completions wire fixtures and four read-only conformance cases for the generic OpenAI-compatible chat provider (streamed plain text, tool-call argument assembly, the error envelope, and non-streamed JSON plain text) that run against replay, an emulator, or a host-provided live `HttpClient` via `OpenAiConformanceConfig`.
