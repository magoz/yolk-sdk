---
'@yolk-sdk/agent': minor
---

Add optional `LLMError.responseIssue: 'missing_done'` for kernel zero-Done completions, `collectModelTurnAttempt` for partial-failure model-turn collection, and shared overflow compaction that runs only before published output. `collectModelTurn` still finalizes `assistantMessage` only from `AssistantMessage` events.
