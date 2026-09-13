---
'@yolk-sdk/harness': patch
---

Carry Coordinator settlement as a successful `Exit` payload and flatten it at public waiters so interruption can reach every observer on Effect 4.0.0-beta.80. This does not globally fix native `Deferred.done`.
