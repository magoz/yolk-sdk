---
'@yolk-sdk/codemode': patch
'@yolk-sdk/conformance': patch
'@yolk-sdk/extractors': patch
'@yolk-sdk/harness': patch
'@yolk-sdk/knowledge': patch
'@yolk-sdk/mcp': patch
'@yolk-sdk/sandbox': patch
'@yolk-sdk/vercel-workflows': patch
---

Advance unchanged public packages in lockstep with the Fortnox Developer Portal scopes in `@yolk-sdk/connectors` (91 actions across the article, price, costcenter, payment, offer, print, inbox, settings, and profile scopes), the matching `@yolk-sdk/emulators` Fortnox read routes, and provider prompt caching in `@yolk-sdk/agent` (ADR 0008). These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
