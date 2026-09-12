---
'@yolk-sdk/harness': minor
---

Classify one model-turn attempt into Compacted, Retry, Continue, and RecoverFull without retrying.

`attemptModelTurn` isolates state per Effect execution. Incomplete streams recover only via kernel `responseIssue: 'missing_done'`. Continue keeps partial text/reasoning/completed calls without new IDs or tool execution. Durable overflow compact is persist-then-retry through `overflowCompactionAttempt` (once per logical step). Sink, compact, and Abort errors are not classified as provider failures.
