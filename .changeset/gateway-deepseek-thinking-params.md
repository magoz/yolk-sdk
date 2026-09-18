---
'@yolk-sdk/agent': patch
---

Allow overriding the Vercel AI Gateway reasoning-effort wire format and merging a thinking toggle into the request body, so DeepSeek-style hosts can receive `reasoning_effort` and `thinking` instead of the default Anthropic `reasoning` object. Defaults are unchanged.
