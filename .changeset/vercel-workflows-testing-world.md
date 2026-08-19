---
'@yolk-sdk/vercel-workflows': minor
---

Add a `./testing` subpath exporting `TestWorkflowWorld`, a behavioral Vercel
Workflow platform emulator for host tests: run lifecycle, append-only durable
streams with close-once -> HTTP 409 "already completed" conflicts, a step
executor honoring `fn.maxRetries` with 1-based `getStepMetadata().attempt`
metadata, hooks/resume, cancellation, a `VercelWorkflowsSdkClient` adapter for
`VercelWorkflows.layerFromSdk`, and a `testWorkflowModule` surface for mocking
the ambient `workflow` module.
