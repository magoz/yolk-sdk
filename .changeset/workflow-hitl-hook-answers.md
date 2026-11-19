---
'@yolk-sdk/vercel-workflows': patch
---

`TestWorkflowWorld` hooks now behave as on the platform (#304). `resumeHook` succeeds for every payload sent to a live hook, as Vercel does, instead of throwing `TestWorkflowHookConflictError` from the second one: `await hook` reads the first payload and the rest are dropped when the hook is disposed. Resuming a disposed hook, or a hook whose run ended, now fails with `TestWorkflowHookNotFoundError` (before: `TestWorkflowHookConflictError`, or success for an ended run's undisposed hook), and a token resumed in an earlier run no longer blocks a later run's hook with the same token. `resumeHook` no longer throws `TestWorkflowHookConflictError`; host tests that expected it for a repeated answer now see the answer accepted and unused.

The "Awaiting input" docs now state the host rules these semantics imply (#306): give every pause its own hook token (a token shared by several pauses hands a late duplicate of an earlier answer to the next pause), and do not read `resumeHook` success as "the answer was used": record the answer durably for its pause before resuming.
