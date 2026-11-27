---
'@yolk-sdk/codemode': patch
'@yolk-sdk/conformance': patch
'@yolk-sdk/connectors': patch
'@yolk-sdk/emulators': patch
'@yolk-sdk/files': patch
'@yolk-sdk/harness': patch
'@yolk-sdk/knowledge': patch
'@yolk-sdk/mcp': patch
'@yolk-sdk/pool': patch
'@yolk-sdk/sandbox': patch
'@yolk-sdk/vercel-workflows': patch
---

Advance in lockstep with `@yolk-sdk/agent` and `@yolk-sdk/extractors`: `markChatRunStart` takes the chat Schemas' states under `exactOptionalPropertyTypes`, and `.docx` extraction works where mammoth's browser build is resolved, such as Cloudflare Workers under Vite. These packages have no direct changes in this release.
