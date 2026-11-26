---
'@yolk-sdk/agent': patch
'@yolk-sdk/codemode': patch
'@yolk-sdk/conformance': patch
'@yolk-sdk/connectors': patch
'@yolk-sdk/emulators': patch
'@yolk-sdk/extractors': patch
'@yolk-sdk/files': patch
'@yolk-sdk/harness': patch
'@yolk-sdk/knowledge': patch
'@yolk-sdk/mcp': patch
'@yolk-sdk/pool': patch
'@yolk-sdk/sandbox': patch
---

Advance in lockstep with `@yolk-sdk/vercel-workflows`: its Cloudflare runtime can prepare a run's object before the run starts (`prepareRun`, `startWithRunId`, `registerRunPreloads`). These packages have no direct changes in this release.
