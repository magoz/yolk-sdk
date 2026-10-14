---
'@yolk-sdk/conformance': patch
'@yolk-sdk/emulators': patch
'@yolk-sdk/extractors': patch
'@yolk-sdk/harness': patch
'@yolk-sdk/knowledge': patch
'@yolk-sdk/sandbox': patch
'@yolk-sdk/vercel-workflows': patch
---

Advance unchanged public packages in lockstep with tool exposure and catalog instructions in `@yolk-sdk/agent` and `@yolk-sdk/codemode` (ADR 0007: deferred tool loading with `tool_search`, stage-only tools, the code mode catalog as a host instruction), deferred loading through `@yolk-sdk/mcp` and `@yolk-sdk/connectors` exposure, and the Claude Code 2.1.299 identity in `@yolk-sdk/agent`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
