---
'@yolk-sdk/agent': minor
'@yolk-sdk/codemode': minor
'@yolk-sdk/mcp': minor
---

Finish tool calls that paused for a person's input (ADR 0014). A tool whose remote call paused (an MCP server asking a form over `2026-07-28` multi round-trip requests) stores the pause and returns `makeInputRequiredToolResult`: an error result carrying `{ code: 'input_required', inputRequired: { reviewToolName, pauseIds } }` (`toolInputRequired` reads it back). The new `makeInputReviewTool` interaction (`review_input({ pauseIds })`, renderer `input_review`) loads the stored pauses through a host `InputReviewHost`, admits one answer per pause, and resumes each pause once; its result lists every pause as `completed`, `input_required` (asked again), `not_sent` or `unknown` (`InputReviewOutcome`). Plan apply reports such calls with the new `input_required` status (with their ref, never stopping the apply; `ToolPlanCallCounts.input_required` is optional so earlier outcomes still decode), and code mode reports them in `structuredContent.codemode.inputRequired` and a notice even when the script caught the rejection. Yolk's MCP server gains forwarding tools (`forward: true`, optional `approval`): a remote tool's pause is asked of the server's own client under a signed, stateless forward state and resumed with its answers (`McpForwardRound`).
