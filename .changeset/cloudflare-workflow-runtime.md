---
'@yolk-sdk/vercel-workflows': minor
---

Add a Vercel Workflow-compatible runtime on Cloudflare Durable Objects, so code written with `'use workflow'`, `'use step'`, `workflow` and `workflow/api` runs on Workers without a Vercel backend.

- `./cloudflare`: the `WorkflowRun` Durable Object class (bind it as `WORKFLOW_RUNS`, a SQLite class), `registerWorkflowModules` (load workflow modules when a run needs them, not at Worker startup), `WorkflowExecution`, `makeMemoryRunStore`, `makeSqliteRunStore`, `workflowRunsBinding`, the step errors and run store types.
- `./cloudflare/workflow` and `./cloudflare/api`: drop-in `workflow` (`createHook`, `sleep`, `getWritable`, `getStepMetadata`, `getWorkflowMetadata`, `FatalError`, `RetryableError`) and `workflow/api` (`start`, `getRun`, `resumeHook`) modules hosts alias in server environments.
- `./cloudflare/directives` and `./cloudflare/vite`: the `workflowDirectives` Vite plugin compiles top-level `'use step'` and `'use workflow'` functions to `workflowStep`/`workflowEntry` calls (`runtime` defaults to `@yolk-sdk/vercel-workflows/cloudflare/directives`).
- Semantics follow the platform: each run's body runs in its object with a SQLite journal (replay after eviction), devalue serialization, at-least-once steps with `maxRetries` (default 3), `RetryableError` and `FatalError`, exhausted steps wrapped in `FatalError`, hooks through a `hook:<token>` index, durable sleeps on alarms, a per-run stream (`getReadable({ startIndex })`, `getTailIndex()`), and cancellation (`WorkflowRunCancelledError`).
- Requires the Worker's `nodejs_compat` flag. Adds `devalue` as a dependency and `vite` (`>=6`) as an optional peer (types of `./cloudflare/vite`). See the README section "Cloudflare runtime".
