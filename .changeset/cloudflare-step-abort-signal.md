---
'@yolk-sdk/vercel-workflows': minor
---

Cloudflare runtime: cancelling a run now ends its running steps and lets the run's execution settle.

- `getStepSignal()` (new, from `@yolk-sdk/vercel-workflows/cloudflare/workflow`; not part of Vercel's `workflow`, so import it from this subpath) returns the running step's `AbortSignal`. `run.cancel()` aborts it with a `WorkflowRunCancelledError` as the reason. Pass it to a step's fetch or model call so a cancelled run's step stops instead of running to its end for an outcome that is dropped.
- A step waiting to retry stops at once when its run is cancelled, instead of after its backoff.
- A run cancelled while its workflow module was still loading stays `cancelled`; before, its status was overwritten with `running` (or `failed` for a missing module) and a later alarm or `settled()` could run it again.
- A cancelled run's body still stops where it waits, but its execution now ends once its steps in flight are done, instead of never settling. `WorkflowExecution.kick()` returns a promise that settles when the execution ends (it never rejects).
