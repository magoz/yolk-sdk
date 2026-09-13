---
'@yolk-sdk/harness': patch
---

Acknowledge Coordinator interruption by joining one FiberSet-owned request fiber (`yieldNow` then `interruptUnsafe`) inside the existing Inbox `invalidate` gate. LiveStopping reuses that same receipt. Explicit whole `undefined` factory options keep `E = never`.
