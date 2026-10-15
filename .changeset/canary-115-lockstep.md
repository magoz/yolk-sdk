---
'@yolk-sdk/codemode': patch
'@yolk-sdk/conformance': patch
'@yolk-sdk/connectors': patch
'@yolk-sdk/emulators': patch
'@yolk-sdk/extractors': patch
'@yolk-sdk/files': patch
'@yolk-sdk/harness': patch
'@yolk-sdk/knowledge': patch
'@yolk-sdk/mcp': patch
'@yolk-sdk/sandbox': patch
'@yolk-sdk/vercel-workflows': patch
---

Advance unchanged public packages in lockstep with `@yolk-sdk/agent`, which now reports one typed `AgentStatus` per run and per subagent (ADR 0010). These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
