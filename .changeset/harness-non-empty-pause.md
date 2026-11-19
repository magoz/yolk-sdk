---
'@yolk-sdk/harness': minor
---

Breaking (0.x minor): `Driver.pause` and `Inbox.park` take a non-empty request id list (`Array.NonEmptyReadonlyArray<string>` from `effect`), so an empty pause no longer type-checks (#321). A park with no request ids was Ready at once: the drain that paused then kept its claim (as for a Ready park whose continuation failed) and nothing woke the run, although a human pause releases the claim. `ParkedState.requestIds` and `StepOutcome.AwaitingInput` `requests` (from `attemptToolBatch`) are non-empty too, so a tool batch's request ids map straight to a pause with `Array.map(outcome.requests, request => request.requestId)`; the native `.map` returns `string[]` and no longer fits. Hosts that pause from their own list check it with `Array.isReadonlyArrayNonEmpty` first and do not pause on an empty one. Custom `InboxApi` / `DriverApi` implementations take the narrower parameter, and hand-built `StepOutcome.AwaitingInput` values need at least one request.
