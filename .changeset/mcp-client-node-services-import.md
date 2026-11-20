---
'@yolk-sdk/mcp': patch
---

`@yolk-sdk/mcp/client/node` imports `NodeServices` from `@effect/platform-node/NodeServices` instead of the package root, so importing it no longer evaluates every Node platform module (about 2.6 MB less on import).
