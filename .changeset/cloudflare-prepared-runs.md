---
'@yolk-sdk/vercel-workflows': minor
---

Cloudflare runtime: prepare a run's object before its start. Every run gets a new `WorkflowRun` Durable Object, so a start pays for creating the object and evaluating the workflow's module in its fresh isolate; a host that knows a run is coming (someone is typing) can now do that ahead of time.

New Cloudflare-only exports (not in Vercel's `workflow/api`, so import them from `@yolk-sdk/vercel-workflows/cloudflare/api`):

- `createRunId()` makes a run id (`wrun_` and 32 hex digits, the shape `start` uses); `isRunId(value)` checks one.
- `prepareRun(workflow, runId)` loads the workflow's module, and the modules registered with the new `registerRunPreloads({ name: () => import(...) })` (from `@yolk-sdk/vercel-workflows/cloudflare`), in the object that will run under `runId` (register them at the Worker entry's module scope, as plain `import()`s: every `prepareRun` calls them again). It stores nothing, so a prepared object that never starts costs only its preparation and is evicted; calling it again keeps a warm object resident.
- `startWithRunId(workflow, args, { runId })` starts the run under a chosen id only when no run lives under it, answering `{ status: 'created', run }`. Otherwise it changes nothing and answers `alreadyStarted` (with `run`) when that run has the same workflow and arguments, most likely the caller's own earlier call whose answer was lost, or `taken` (no handle) for another run, so two callers never share one run. Ids that are not run ids (`isRunId`) are refused.

`WorkflowRunStub` gains `startNew` (`StartNewOutcome`: `created`, `alreadyStarted` or `taken`) and `prepare`, so custom namespaces or stubs typed against it must add them. `start` is unchanged.
