---
'@yolk-sdk/codemode': patch
'@yolk-sdk/conformance': patch
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

Advance unchanged public packages in lockstep with `@yolk-sdk/connectors` and `@yolk-sdk/agent`, which now return email attachments above ~3 MB (the attachment base64 is no longer pattern-checked) and decode file bytes in one copy. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
