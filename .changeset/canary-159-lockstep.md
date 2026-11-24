---
'@yolk-sdk/conformance': patch
'@yolk-sdk/connectors': patch
'@yolk-sdk/emulators': patch
'@yolk-sdk/extractors': patch
'@yolk-sdk/files': patch
'@yolk-sdk/knowledge': patch
'@yolk-sdk/mcp': patch
'@yolk-sdk/pool': patch
'@yolk-sdk/sandbox': patch
---

Advance in lockstep with `@yolk-sdk/agent`, `@yolk-sdk/codemode`, `@yolk-sdk/harness` and `@yolk-sdk/vercel-workflows`: tool results can mark their nested usage incomplete (`ToolResult.usageIncomplete`), and durable model events name their execution's turn (`executionTurn`) so a client rebuilt from a snapshot mid-turn starts that turn. These packages have no direct changes in this release.
