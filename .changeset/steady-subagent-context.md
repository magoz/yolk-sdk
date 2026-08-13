---
'@yolk-sdk/agent': patch
'@yolk-sdk/vercel-workflows': patch
---

Classify Codex context-window failures as context overflow, support endpoint-specific input budgets, expose subagent usage and typed error summaries (including partial failed-run usage), and clarify that ChatGPT Codex ignores output-token configuration. Carry tool-owned nested-model usage through durable workflow state and HITL failures.
