---
'@yolk-sdk/agent': patch
---

Omit `is_error` from Anthropic tool-result blocks when the tool result carries no flag, instead of serializing it as `undefined` and failing request-body JSON validation on the turn after every successful tool call.
