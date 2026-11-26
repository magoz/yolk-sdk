---
'@yolk-sdk/codemode': patch
---

`makeDynamicWorkerCodeModeExecutor`: a script stopped by its CPU limit keeps the output it sent before its last call, and its wall time should no longer stop where it started spinning (#419).

- The isolate now sends the output printed since its previous tool or global call with each call. An execution that ends without the isolate's answer (its CPU limit, a failed isolate, the timeout, an abort) returns the output printed before the script's last call (decoded and capped by the prelude's output limits, a prefix of what was printed), where it returned none. Output printed after that call is still lost: a spinning isolate shares the calling Worker's thread and can send nothing. A completed script returns all of its output, each item once, as before.
- A CPU-limit failure settles one timer turn later. A Worker's clock moves only at I/O and timers, so the run's wall time (`wallTimeMs`, `Script failed after … ms`) stopped where the script started spinning, for example 201 ms for a script that took 2.7 s. The timer turn lets the clock move first; local workerd does not enforce CPU limits, so it can only be checked on deployed Workers.
