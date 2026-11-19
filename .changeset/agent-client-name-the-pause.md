---
'@yolk-sdk/agent': patch
---

The `@yolk-sdk/agent/client` README (linked from the package README) now says how a Workflow HITL answer names its pause (#334): a request id alone is ambiguous, so put the pause (the `eventId` of the `AgentAwaitingInput` that asked) in the `endpoint` passed to the HITL resume helpers, for example `?pause=<eventId>`. Continuation reads reuse that endpoint, so the tail route ignores the parameter.
