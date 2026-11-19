---
'@yolk-sdk/harness': minor
---

A message admitted right after an interrupt is no longer dropped from scheduling. An owner that had already passed its stopping check could still run `Inbox.beginDrain` and consume the pending intent of a steer or input admitted after the interrupt; the successor started for that message then skipped, leaving it queued with no execution. Coordinator drains now receive a `stopping` read of their execution, Driver forwards it to `Inbox.beginDrain(runId, scope, stopping?)`, and `beginDrain` returns `Skip` without consuming intent when it reads true under the admission gate. An Inbox implementation must read `stopping` under the same lock that consumes intent and, when it is true, return `Skip` without touching pending intent; a wrapper must forward it. Driver now runs `beginDrain` uninterruptibly, so keep it short and non-blocking.

Driver now issues the drain token and calls `endDrain` as one `Effect.acquireUseRelease`, so an interrupt landing between them can no longer leave the token live with no drain. The owner's `beginDrain`, including its wait for the Inbox gate, is therefore uninterruptible; an interrupt arriving there is delivered once it returns.
