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

Advance in lockstep with `@yolk-sdk/agent`: its new `@yolk-sdk/agent/chat` subpath is the chat projection without React, an event's cost no longer grows with the chat's history, the projection's state has Effect Schemas, and `seenEventIds` is an Effect `HashSet`. These packages have no direct changes in this release.
