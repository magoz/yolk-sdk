---
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

Advance unchanged public packages in lockstep with tool change previews in `@yolk-sdk/agent` (one before → after preview for approval-gated calls, shown on direct approvals and staged plan reviews). These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
