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
'@yolk-sdk/vercel-workflows': patch
---

Republish every public package in lockstep after an incomplete `0.1.0-canary.117` publish: npm held `@yolk-sdk/extractors@0.1.0-canary.117`, so `@yolk-sdk/extractors`, `@yolk-sdk/pool`, `@yolk-sdk/sandbox` and `@yolk-sdk/vercel-workflows` were never published at that version. This release contains no implementation changes beyond `0.1.0-canary.117`; install this version (with all `@yolk-sdk/*` packages on it) instead of `0.1.0-canary.117`.
