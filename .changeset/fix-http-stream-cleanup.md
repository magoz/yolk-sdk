---
'@yolk-sdk/agent': patch
---

Upgrade the Effect runtime to beta.80 so rejected HTTP response bodies retain their typed transport errors instead of becoming cleanup defects and leaving durable-run streams pending. Keep the Effect platform packages aligned with that runtime.

Ensure HTTP callback producers forward all failure causes to consumers, including unexpected host callback defects, without wrapping defects as recoverable transport errors.
