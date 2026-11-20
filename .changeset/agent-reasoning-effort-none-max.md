---
'@yolk-sdk/agent': minor
---

`AgentReasoningEffort` adds `none` and `max`, which OpenAI, Anthropic and Vercel AI Gateway document for reasoning models (support is model dependent). Earlier values keep decoding; data written with the new values does not decode on an earlier canary. OpenAI chat, Responses (Codex, Grok, OpenCode Go `responses`) and Gateway pass both through. Anthropic Messages (Claude, OpenCode Go `messages`) sends `max` as `output_config.effort` and rejects `none` with a non-retryable `validation_error` `LLMError` before any request, since leaving it out would apply the model's default effort, which reasons. Exhaustive matches or `Record`s keyed by `AgentReasoningEffort` need the two new cases.
