---
'@yolk-sdk/mcp': patch
---

A forwarding tool (`forward: true`) no longer forwards one remote pause under two rounds. The forwarded prompt's `roundId` was random each time a pause was forwarded, so a host that answers a retried accept (once-only on `approvalId`) or a retried `McpForwardRound.Resume` (once-only on `roundId`) with the outcome it stored forwarded the same remote pause again under a new `roundId`, and answering both prompts resumed that remote pause twice (a remote `delete` ran twice). A remote pause's `roundId` is now the digest of where it came from (the approval, or the round it resumed) and the pause, so a replayed pause is asked in the same round (with a new expiry) and the host's `roundId` key resumes it once. A first round without `approval` has no once-only key, so its pause keeps a random `roundId`. `roundId` stays an opaque string; it is no longer a UUID.
