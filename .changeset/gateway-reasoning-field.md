---
'@yolk-sdk/agent': patch
---

Preserve normalized `reasoning` thinking output from OpenAI-compatible hosts such as Vercel AI Gateway in streaming and single-shot chat completions when `reasoningContent` is enabled. Prefer `reasoning_content` when both are present, so reasoning surfaces as events instead of being dropped.
