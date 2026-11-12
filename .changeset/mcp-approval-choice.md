---
'@yolk-sdk/mcp': minor
---

Approval tools now ask one required approve/deny choice (`approvalForm`) instead of an empty form. Some MCP clients accept an empty form without showing it (OpenCode answers `accept` with `{}`), so the tool would run without the user ever choosing. Approve runs the tool as before (`execute` and `approvalId` unchanged). Deny answers `declinedApprovalMessage` and runs nothing, like a declined form. An accept without the choice asks again. The prompt changed, so a prompt shown by an earlier version and accepted after the upgrade answers `changedPromptMessage`; the user is asked again on the next call.

`mcpServerForm({})` now lists a problem ("a form needs a field"), so an elicited tool never asks an empty form; every form lists `required`. New exports: `approvalForm`, `declinedApprovalMessage`.
