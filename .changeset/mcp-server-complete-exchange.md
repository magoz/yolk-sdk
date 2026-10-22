---
'@yolk-sdk/mcp': patch
---

Fix `makeMcpToolServer().handleHttpRequest` running tools after its Effect returned. The official SDK answers 2025-era Streamable HTTP requests (and `2026-07-28` requests whose handler sends a related message) with an SSE stream that it fills after returning the `Response`, so tools ran with the caller's context after the caller's scope had closed: resources from a scoped request layer (an HTTP agent, a database pool) were already released, and outbound requests failed. `handleHttpRequest` now reads such a stream to its end before returning and answers with the same status, headers and events (a read failure answers 500 with JSON-RPC `-32603`); `subscriptions/listen` streams are still returned as they open. Tool Effects now also run with the SDK's request signal, so a request the client cancels (on Streamable HTTP, by closing its response stream) interrupts the tool, as the specification asks.
