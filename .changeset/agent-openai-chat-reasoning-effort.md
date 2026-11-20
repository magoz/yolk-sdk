---
'@yolk-sdk/agent': minor
---

The OpenAI chat provider (`makeOpenAiProviderLayer`, `OpenAiProviderLayer`) no longer drops `LLMRequest.reasoningEffort` silently. On the native OpenAI endpoint (no `chatCompletionsUrl`, or `https://api.openai.com/v1/chat/completions`) `reasoningEffortFormat` now defaults to `reasoning-effort`, so the effort is sent as `reasoning_effort` (and an `extraBody.reasoning_effort` is dropped as a canonical key). Models without reasoning reject that field: stop sending an effort to them, or set the new `reasoningEffortFormat: 'omit'`, which never sends the effort and never fails (on any endpoint). Other endpoints stay opt-in: without `reasoningEffortFormat`, a request with an effort now fails with a non-retryable `validation_error` `LLMError` before any request (the same for `toOpenAiRequestBody` called without a format). Vercel AI Gateway and OpenCode Go chat set their format and are unchanged.
