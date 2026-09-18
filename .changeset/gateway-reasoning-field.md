---
'@yolk-sdk/agent': patch
---

Parse the normalized `reasoning` thinking field in OpenAI-compatible chat completions (streaming deltas and single-shot messages), preferring `reasoning_content` when both are present. Hosts that normalize provider thinking output (e.g. Vercel AI Gateway) now surface reasoning events instead of dropping them.
