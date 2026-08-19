---
'@yolk-sdk/vercel-workflows': patch
---

Require `workflow@^5.0.0-beta.42`: the 5.x line makes Vercel Workflow runs region-pinned
(multi-region default since 5.0.0-beta.33), serving storage, queuing, and durable streams
region-locally instead of routing through `iad1`. Verified against the real v5 local world by the
package directive integration tests.
