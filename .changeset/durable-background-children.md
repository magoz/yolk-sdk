---
'@yolk-sdk/agent': patch
'@yolk-sdk/connectors': patch
'@yolk-sdk/knowledge': patch
'@yolk-sdk/mcp': patch
'@yolk-sdk/sandbox': patch
'@yolk-sdk/vercel-workflows': patch
---

Add opt-in background subagent acknowledgements without premature child-completion events,
public whole-batch HITL preflight, and generic bounded Workflow tool orchestration and durable
child read/sleep seams. Preserve inline subagent compatibility and logical usage identity.
The Next example wires independent foreground/background child workflows with owned durable
reservations/results and tombstone-first explicit Stop cancellation.
