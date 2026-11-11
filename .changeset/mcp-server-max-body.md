---
'@yolk-sdk/mcp': patch
---

`makeMcpToolServer` takes `maxRequestBodySize`: the most bytes of a request body its SDK path reads (every request with `MCP-Protocol-Version`, both eras), passed to the SDK's `createMcpHandler` and to its era routing. Since MCP SDK 2.4.0 (canary.129) that path answers `413` over 4 MiB, so a host that accepts larger bodies (inline attachments) passes its own cap. An unusable value (not a positive finite number) answers a 500 error naming it, instead of a `RangeError` on every request. Omitted, the SDK's 4 MiB applies, as before.
