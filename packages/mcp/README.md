# @yolk/mcp

Domain-free Model Context Protocol client/server package.

Root export is intentionally tiny. Import client, protocol, and server APIs from explicit subpaths.

## Subpaths

```ts
import { listMcpTools } from '@yolk/mcp/client'
import { listMcpToolsNode } from '@yolk/mcp/client/node'
import { makeJsonRpcRequest } from '@yolk/mcp/protocol'
import { makeMcpToolServer } from '@yolk/mcp/server'
```

## Boundaries

- App auth, persisted config, policy, and product tools stay outside this package.
- Node convenience wrappers stay behind `@yolk/mcp/client/node`.
- MCP may adapt to `@yolk/agent/protocol` tool types; agent loop/providers stay MCP-agnostic.

## Tree-shaking

- ESM package with `sideEffects: false`.
- Explicit subpath exports only.
- No wildcard exports or root feature barrel.
