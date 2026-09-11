---
'@yolk-sdk/agent': minor
'@yolk-sdk/connectors': minor
'@yolk-sdk/knowledge': minor
'@yolk-sdk/mcp': minor
'@yolk-sdk/sandbox': minor
'@yolk-sdk/vercel-workflows': minor
---

Add host-only connector file downloads/exports and bounded Dropbox, OneDrive and conditional R2 byte writes. Preserve existing GET adapters, base64 actions and R2 presigning. OneDrive replacement explicitly acknowledges unconditional overwrite; Dropbox revisions and R2 ETags remain strict provider/host preconditions. Add Fortnox supplier-file and Todoist comment metadata discovery, document consent/streaming/concurrency limits and reuse existing Afloat/Figma MCP file operations. No generic agent byte actions or app wiring.
