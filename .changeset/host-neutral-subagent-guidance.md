---
'@yolk-sdk/agent': patch
---

Make background subagent parameter and acceptance guidance host-neutral instead of instructing models to call status/wait tools that the SDK does not register. Preserve model-visible lookup identities, structured acceptance metadata, and zero-usage launch acknowledgement semantics. Hosts continue to own completion delivery and observation policy.
