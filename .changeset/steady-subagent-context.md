---
'@yolk-sdk/agent': patch
'@yolk-sdk/vercel-workflows': patch
---

Classify Codex context-window failures as context overflow, support endpoint-specific input budgets, expose subagent usage and typed error summaries, and clarify that ChatGPT Codex ignores output-token configuration. Carry tool-owned nested-model usage into subsequent durable workflow state.
