---
'@yolk-sdk/agent': minor
'@yolk-sdk/harness': patch
---

Add schema-backed typed input interactions through the existing HITL lifecycle. `makeInputTool`
keeps original call/response validators server-side while serializable descriptors identify app-owned
renderers. Hosts pass resolved input handlers to loop/runtime configs; input requests support submit,
cancel, validation correction, and first-valid-response replay without authorizing actions.

Preserve question compatibility, add HTTP/WebSocket and headless React input submission/projection,
and match input responses in harness outcomes. Input tools reject approval/background policy and
direct execution; voice remains approvals-only. React waits for server acceptance before creating
replayable results, including across failed submissions and pending-state hydration.
