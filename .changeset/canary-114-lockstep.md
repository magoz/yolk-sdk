---
'@yolk-sdk/conformance': patch
'@yolk-sdk/emulators': patch
'@yolk-sdk/extractors': patch
'@yolk-sdk/harness': patch
'@yolk-sdk/knowledge': patch
'@yolk-sdk/vercel-workflows': patch
---

Advance unchanged public packages in lockstep with the file claim check (ADR 0009): agents move
files between tools by `fileId`, and the new `@yolk-sdk/files` package provides the object-storage
file store and file tools. These packages have no direct implementation changes in this release;
keep all `@yolk-sdk/*` dependencies on the same canary version.
