---
'@yolk-sdk/harness': minor
---

Add Inbox/Driver HITL pause, resume, and user-stop on the existing coordinator, with payload-free park tokens and outcome protocol-match helpers. Memory Inbox waiting state is process-local, including Durable Object snapshot-claim factories.

Canary API tightening: `Inbox.takePromotable(runId, scope, drainToken)` requires the live drain token (same explicit-token rule as `park`) and checks ownership atomically with dequeue. Missing, empty, inactive, stale, or wrong-run tokens do not take an item. There is no optional/unchecked take. `beginDrain(runId, scope)` and `wakeIfUnblocked(runId, scope, wake)` record/consume scope-aware pending intent; input subsumes steer, and a steer drain does not consume a later input wake.
