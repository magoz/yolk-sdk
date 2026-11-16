---
'@yolk-sdk/vercel-workflows': patch
---

`VercelWorkflows.start` takes optional `{ attributes }` (new `VercelWorkflowStartOptions`), seeding Workflow run attributes at creation. `TestWorkflowWorld`'s `sdk.start` checks them with the installed runtime's validator (an invalid one rejects with a FatalError and creates no run) and shows them in `inspect(runId).attributes`.
