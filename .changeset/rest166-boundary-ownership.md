---
'@yolk-sdk/agent': patch
'@yolk-sdk/mcp': patch
'@yolk-sdk/sandbox': patch
'@yolk-sdk/vercel-workflows': patch
---

Keep each Workflow tool-batch HITL response array independent from the loop's accumulator, preserving response order and element identity. Normalize custom React chat transport rejections through the existing transport error owner, retaining their underlying cause and recognizing aborts.

Return a JSON-RPC invalid-request response when a legacy MCP HTTP request body cannot be read. Precisely narrow missing-sandbox SDK errors to HTTP 404/410 without assuming an object-shaped error payload or discarding other API errors.
