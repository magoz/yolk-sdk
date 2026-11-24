---
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

Advance in lockstep with `@yolk-sdk/agent` and `@yolk-sdk/codemode`: hosts can run code mode scripts outside a model turn (`runCodeModeScript` over `ResolvedToolSet.nestedExecutor`), gate them to reads (`readOnlyNestedCallGate`), mark tools that call a model (`invokesModel`), and render annotated host messages from chat items. These packages have no direct changes in this release.
