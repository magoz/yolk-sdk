---
'@yolk-sdk/vercel-workflows': minor
---

`runVercelAgentWorkflow` now retries the close step by default (`closeStreamRetry` defaults to the new `defaultCloseStreamRetry`, `{ maxAttempts: 3 }`; other steps still default to `noWorkflowStepRetry`). Closing a Workflow stream is idempotent on Vercel, so a close the platform applied before its step failed (the function died, or the step's completion was lost) now completes the run instead of returning `CloseStreamFailed` and calling `writeError` for a stream the client saw end with `AgentEnd`. Keep `closeStream` safe to repeat, or pass `closeStreamRetry: noWorkflowStepRetry` to close once.

`TestWorkflowWorld` now treats a second close of a closed stream as Vercel does: it succeeds (still counted in `inspect(runId).streamCloseCount`) instead of throwing the 409 `TestWorkflowStreamConflictError`. Writes after close still throw that conflict. Host tests that expected a re-close to fail should expect it to succeed.
