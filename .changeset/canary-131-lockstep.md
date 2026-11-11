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
---

Advance in lockstep with `@yolk-sdk/agent`, whose providers now fail a returned tool call with an empty or padded id or name as a typed `invalid_response` instead of a defect, and `@yolk-sdk/vercel-workflows`, whose `TestWorkflowWorld` now stores step errors through the platform's serializer and records unstorable ones in `inspect(runId).unstorableStepErrors`. These packages have no direct changes in this release.
