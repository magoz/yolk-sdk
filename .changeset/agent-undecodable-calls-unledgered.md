---
'@yolk-sdk/agent': patch
---

`@yolk-sdk/agent/tools`: a call of a `makeTool` tool with `isReadCall` whose arguments do not decode now counts as a read (`toolCallAccess` is `read`, ledger policy input `readCall: true`). Its `execute` runs nothing and answers the validation error, so that error now reaches the model even when a host ledger refuses the tool's writes; before, the call counted as a write and such a ledger answered its own refusal instead. Raw `isReadCall` registrations, failing or dying classifiers, applied plan calls and background activations are unchanged.
