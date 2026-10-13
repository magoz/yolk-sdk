---
'@yolk-sdk/agent': patch
---

Bind tool approval to the call instead of the tool's current policy. Previously `prepareApprovalCall` checked whether the tool still required approval before reading the recorded answer, so a tool whose policy flipped to automatic between the request and the answer ran even when the human denied it. Now a recorded `ToolApprovalResponse` always wins (denied: the denied result, never executed; approved: executed). New optional `awaitingRequests` (the resumed pause's `AgentAwaitingInput.requests`) on `run`, `runToolBatch` and `prepareToolBatch` keeps an unanswered approval request pending even when the tool no longer requires approval; `runRuntime` passes its logged pause automatically.
