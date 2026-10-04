---
'@yolk-sdk/agent': minor
---

Add per-request `LLMRequest.maxOutputTokens` and a `completeText` loop helper. The request cap overrides the configured provider default for one call and lowers to each adapter's native field (`max_tokens`, `max_completion_tokens`/`max_tokens`, `max_output_tokens`); omitted requests send byte-identical bodies, and ChatGPT Codex keeps ignoring the limit. `completeText(request, { maxCharacters, timeout })` runs a bounded single-shot call against the current `LLMProvider`, concatenating assistant text only, summing usage, and returning `{ text, usage, finishReason, truncated }` with the stream cancelled when a ceiling is hit.
