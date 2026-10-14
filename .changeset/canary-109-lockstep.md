---
'@yolk-sdk/agent': patch
'@yolk-sdk/conformance': patch
'@yolk-sdk/connectors': patch
'@yolk-sdk/emulators': patch
'@yolk-sdk/extractors': patch
'@yolk-sdk/harness': patch
'@yolk-sdk/knowledge': patch
'@yolk-sdk/mcp': patch
'@yolk-sdk/sandbox': patch
'@yolk-sdk/vercel-workflows': patch
---

Advance unchanged public packages in lockstep with the `@yolk-sdk/codemode` fix that makes every stageable tool searchable and describable from code mode scripts, including model-callable and deferred ones. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
