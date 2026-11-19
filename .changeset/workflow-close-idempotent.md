---
'@yolk-sdk/vercel-workflows': minor
---

Breaking (0.x minor): `TestWorkflowWorld` now treats a second close of a closed stream as Vercel does: it succeeds (still counted in `inspect(runId).streamCloseCount`) instead of throwing the 409 `TestWorkflowStreamConflictError`. Writes after close still throw that conflict. Host tests that expected a re-close to throw should expect it to succeed.

`runVercelAgentWorkflow` now retries the close step by default (`closeStreamRetry` defaults to the new `defaultCloseStreamRetry`, `{ maxAttempts: 3 }`, retrying any rejection including a `FatalError`; other steps still default to `noWorkflowStepRetry`). Closing a Workflow stream is idempotent on Vercel, so a close-only step's retry writes nothing. After a close step's platform attempts are used up with the close applied (for example its completion was lost), a later attempt that succeeds now completes the run instead of returning `CloseStreamFailed` and calling `writeError` for a stream the client saw end with `AgentEnd`. Keep `closeStream` close-only and safe to repeat, or pass `closeStreamRetry: noWorkflowStepRetry` to close once.
