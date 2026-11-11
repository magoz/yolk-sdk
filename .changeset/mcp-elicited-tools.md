---
'@yolk-sdk/mcp': minor
---

`makeMcpToolServer` serves elicited tools: a tool built with `makeMcpServerElicitedTool` asks the user a form through MCP form elicitation (`2026-07-28`) before it runs, and `execute` gets the answer decoded with the form's Effect Schema plus a per-prompt `elicitationId` for once-only execution. Forms (`mcpServerForm`) hold required yes/no (`mcpFormBoolean`), single-choice (`mcpFormChoice`) and multi-select (`mcpFormMultiSelect`) fields; an answer that does not fit (a value not offered, a duplicate, an empty or too long selection, a missing field) asks again and runs nothing. Approval tools are the empty-form case and keep their wire shape and API.

Every asking tool (approval or elicited) now rebuilds its prompt on the answering round and binds the signed `requestState` to a digest of the prompt shown: an accept of a prompt whose message or form changed answers `changedPromptMessage` and runs nothing. A prompt over `mcpServerMaxPromptBytes` (64 KiB) answers `oversizedPromptMessage` and is never cut. The state payload changed (`formDigest`, `elicitationId`), so a prompt signed by an earlier version is asked again.

New exports: `makeMcpServerElicitedTool`, `mcpServerForm`, `mcpFormBoolean`, `mcpFormChoice`, `mcpFormMultiSelect`, `changedPromptMessage`, `oversizedPromptMessage`, `mcpServerMaxPromptBytes`, and the types `McpServerElicitedTool`, `McpServerElicitation`, `McpServerPrompt`, `McpServerToolAnswered`, `McpServerForm`, `McpServerFormField`, `McpServerFormOption`. `McpServerTool` gains the `McpServerElicitedTool` member: code that narrows the union on `approval` alone must also handle `elicit`.
