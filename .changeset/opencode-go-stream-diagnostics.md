---
'@yolk-sdk/agent': patch
---

Harden OpenAI-compatible chat streaming against non-SSE 2xx responses and add optional safe stream diagnostics to `ProviderErrorInfo`.

A chat streaming response with an explicit non-SSE `Content-Type` (JSON, HTML) now fails before the body is consumed with `invalid_response` `providerCode: 'unexpected_content_type'` (non-retryable, safe numeric status attached). A missing `Content-Type` keeps the existing lenient SSE parsing. `ProviderErrorInfo.stream` optionally carries closed-enum `ProviderStreamDiagnostics` (`protocol`, `responseFormat`, `receivedBytes`, `bufferedChars`, `outputStarted`, `terminalSeen`) on `unexpected_content_type` and `incomplete_stream` chat errors so counters survive provider sanitization and wire serialization; no transcript bytes, raw headers, or body fragments are retained. Unterminated streams at EOF still fail `incomplete_stream` and never emit `Done`.
