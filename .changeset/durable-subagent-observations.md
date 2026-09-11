---
'@yolk-sdk/agent': patch
'@yolk-sdk/vercel-workflows': patch
---

Reject disabled question calls without entering HITL, and distinguish matching subagent
observations from terminal child completion without charging nested usage. Supply deterministic
zero-based read/sleep attempt indices to `awaitWorkflowChild` so durable hosts can bound
observation polling and apply capped backoff while preserving existing zero-argument callbacks.
