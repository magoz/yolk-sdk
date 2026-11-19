---
'@yolk-sdk/harness': minor
---

A message admitted right after an interrupt is no longer dropped from scheduling. An owner that had already passed its stopping check could still run `Inbox.beginDrain` and consume the pending intent of a steer or input admitted after the interrupt; the successor started for that message then skipped, leaving it queued with no execution. Coordinator drains now receive a `stopping` read of their execution, Driver forwards it to `Inbox.beginDrain(runId, scope, stopping?)`, and `beginDrain` returns `Skip` without consuming intent when it reads true under the admission gate. Inbox wrappers must forward the new optional argument.

Driver now issues the drain token and calls `endDrain` as one `Effect.acquireUseRelease`, so an interrupt landing between them can no longer leave the token live with no drain. The owner's `beginDrain`, including its wait for the Inbox gate, is therefore uninterruptible; an interrupt arriving there is delivered once it returns.
