---
'@yolk-sdk/agent': patch
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

Advance in lockstep with `@yolk-sdk/vercel-workflows` and `@yolk-sdk/codemode`: Workflow `executionId`s must be unique per execution of a step body, cancelled Cloudflare runs abort their running steps (`getStepSignal()`) and settle, and Cloudflare code mode keeps the output a script sent before hitting its CPU limit. These packages have no direct changes in this release.
