---
'@yolk-sdk/agent': patch
'@yolk-sdk/codemode': patch
'@yolk-sdk/conformance': patch
'@yolk-sdk/emulators': patch
'@yolk-sdk/extractors': patch
'@yolk-sdk/harness': patch
'@yolk-sdk/knowledge': patch
'@yolk-sdk/mcp': patch
'@yolk-sdk/sandbox': patch
'@yolk-sdk/vercel-workflows': patch
---

Advance unchanged public packages in lockstep with Gmail draft attachments in `@yolk-sdk/connectors` (optional `attachments` on `gmail.draft_compose`, `gmail.draft_update`, and `gmail.draft_reply`) and the matching `@yolk-sdk/emulators` README note: the Google emulator does not emulate the Gmail draft media upload, so a draft with attachments answers its unrecognised 400. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
