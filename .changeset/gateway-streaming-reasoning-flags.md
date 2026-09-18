---
'@yolk-sdk/agent': patch
---

Forward optional `streaming` and `reasoningContent` flags from the Vercel AI Gateway provider factory to the OpenAI-compatible transport, so hosts can opt into SSE deltas and reasoning output instead of single-shot JSON completions.
