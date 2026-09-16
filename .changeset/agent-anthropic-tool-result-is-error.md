---
'@yolk-sdk/agent': patch
---

Omit `is_error` from Anthropic tool-result blocks when the tool result carries no flag, instead of serializing it as `undefined`, preventing request-body validation failures when replaying successful tool results without an error flag.
