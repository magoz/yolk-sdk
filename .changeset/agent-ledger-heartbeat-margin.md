---
'@yolk-sdk/agent': patch
---

`@yolk-sdk/agent/tools`: the tool ledger keeps a renewal margin for one failed or hung heartbeat at every `leaseMs` and `heartbeatIntervalMs`. Each heartbeat is now bounded by `toolLedgerCompleteTimeoutMs` (5 s) or a sixth of `leaseMs`, whichever is shorter, and `heartbeatIntervalMs` is clamped to half the lease minus that bound (it was clamped to half the lease). Before, a lease of about 15 s or less, or an interval near half the lease, let one heartbeat that failed or timed out lapse the lease of a running call: a concurrent duplicate then reported the call as abandoned ("may already have been applied") while it ran and recorded its success. The defaults (30 s lease, 10 s interval, 5 s heartbeat timeout) are unchanged.
