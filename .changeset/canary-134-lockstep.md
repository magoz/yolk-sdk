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
'@yolk-sdk/pool': patch
'@yolk-sdk/sandbox': patch
'@yolk-sdk/vercel-workflows': patch
---

Advance in lockstep with `@yolk-sdk/agent`, whose tool argument validation errors now name a number or boolean the model sent as a JSON string, with the literal to send instead. The tools of `@yolk-sdk/connectors`, `@yolk-sdk/knowledge`, `@yolk-sdk/sandbox` and `@yolk-sdk/files` already append that hint, so their errors gain the line. These packages have no direct changes in this release.
