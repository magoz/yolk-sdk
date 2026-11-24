---
'@yolk-sdk/agent': minor
'@yolk-sdk/codemode': minor
---

Mark tool-attributed usage that under-counts its nested work. `ToolResult` gains an optional `usageIncomplete: true`: `usage` misses (part of) a nested model call that completed without the usage report it was billed for (a child stream's `LLMStreamEnd.usageUnavailable`, a provider's `LLMDone.usageUnavailable`, a classification without usage). It may stand without `usage` (nothing was reported) and, like `usage`, is never model-visible: `toolResultMessageFromResult` drops it. Tools that run their own model calls set it.

The nested-call recorder carries it: `NestedToolCallInput.usageIncomplete` is kept on the call's `NestedToolCallRecord.usageIncomplete`, and `recordNestedToolCall` ORs it over every call, dropped ones included, so `nestedToolCallResultFields` returns `usageIncomplete: true` beside the summed `usage`. The result boundary, file capture and the tool ledger (its stored copy, the typed-too-large copy and replays) keep it with `usage`.

Code mode copies each nested result's `usageIncomplete` onto its record and the script's result. `makeClassifierTool` marks a classification the classifier answered without usage (a result, or `ClassificationResponseInvalid`) as `usageIncomplete`; request and provider errors, which billed nothing, are not marked.

The fields are absent when every report arrived and on results recorded before they existed, so stored results and ledger entries decode unchanged.
