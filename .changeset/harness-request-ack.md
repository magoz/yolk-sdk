---
'@yolk-sdk/harness': patch
---

Acknowledge Coordinator interruption when the interruption-request fiber is joined: that receipt means the stop was delivered, not that the owner has settled. LiveStopping reuses the same outstanding request. Explicit whole `undefined` factory options keep `E = never`.
