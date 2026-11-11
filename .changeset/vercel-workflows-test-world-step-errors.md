---
'@yolk-sdk/vercel-workflows': patch
---

`TestWorkflowWorld` now passes step errors through the platform's own step-error serializer, as a deployment does.

`world.runStep` used to rethrow the step body's error object as is. It now stores each thrown value with the installed `workflow` runtime's serializer (`@workflow/core/serialization`, resolved through `workflow`, unaffected by `vi.mock('workflow')`) and throws only the value read back: error tags, prototypes and custom fields are gone and `cause` survives. It also follows the platform's FatalError rules: a FatalError (named `FatalError`, or with `fatal: true`; an `AbortError` is promoted to one) is never retried, and an exhausted step fails with the platform's FatalError (`Step "<name>" failed after N retries: ...`) whose `cause` is the last thrown value.

A thrown value the platform cannot store (a class instance anywhere in its `cause` chain, such as an Effect `Cause` or a schema issue) never reaches the workflow body. In production the queue handler fails on it and redelivers the step, which re-runs the body until its retries run out and fails with `Step "<name>" exceeded max retries (N retries)`. The world now does the same and records each such value in `world.inspect(runId).unstorableStepErrors`, so host tests catch an unstorable step error instead of passing while a deployment loops.

Tests that read a step's error, from a rejected `runStep` or from `inspect(runId).runError` when the workflow body rethrows it, now see the stored value: compare messages, names and plain-data causes, not identity or class. `runStep` loads the workflow runtime, so tests that execute steps need Vitest's Node environment, not jsdom.
