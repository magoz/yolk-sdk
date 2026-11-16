---
'@yolk-sdk/vercel-workflows': patch
---

`VercelWorkflows.start` takes optional `{ attributes }` (new `VercelWorkflowStartOptions`), seeding Workflow run attributes at creation. `TestWorkflowWorld` records them in `inspect(runId).attributes`.
