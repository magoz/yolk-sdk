---
'@yolk-sdk/harness': minor
---

A park that stops blocking no longer strands work. New `Driver.clearPark(runId, generation)` drops a park without its answers and wakes the run when input was admitted while it blocked, so those messages are answered (#294). `Inbox.clearPark` now takes that wake effect as a third argument, as `acceptHitl` does; direct callers and custom `InboxApi` adapters must pass it. When the continuation of a Ready park (all HITL answers in) fails with a defect, the run keeps its claim, so `resumeSuspended` re-delivers the answers under `maxResumeAttempts` instead of leaving them parked with nothing scheduled (#296); `RunCoordinator.layer` gains the `keepClaimOnDefect` option behind this. Other drain defects still release the claim, and nothing retries automatically.
