---
'@yolk-sdk/agent': patch
---

`@yolk-sdk/agent/client`: blank NDJSON lines are heartbeats. They are still never events and never move the stream index, but each one restarts the `idleReconnect` wait, so a durable run whose server sends them while the model thinks or a tool runs keeps its connection instead of reconnecting every `idleTimeoutMs` (and spending `maxAttempts`). Servers that send none behave as before. The Workflow routes guide documents the route side: a leading blank line commits Next.js response headers before the first event, and periodic ones keep a quiet run's connection alive.
