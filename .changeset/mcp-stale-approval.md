---
'@yolk-sdk/mcp': patch
---

A direct tool of `makeMcpToolServer` now refuses a call that answers an approval prompt (it carries a `requestState` or an answer under `approvalInputKey`) with the error result `staleApprovalMessage`, and runs nothing. Such a call answers a prompt from when the tool was an approval tool: a host that rebuilds its tools per request may have changed the tool's policy between the prompt and the answer, and neither a declined answer nor a replayed accept may then run as a plain call. New export: `staleApprovalMessage`.
