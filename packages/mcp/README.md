# @yolk-sdk/mcp

Domain-free Model Context Protocol client/server/protocol adapters.

Root export is intentionally tiny. Import client, protocol, and server APIs from explicit subpaths.

## Install

```bash
pnpm add @yolk-sdk/mcp@canary @yolk-sdk/agent@canary effect
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Subpaths

| Subpath                     | Purpose                                                          |
| --------------------------- | ---------------------------------------------------------------- |
| `@yolk-sdk/mcp/client`      | Remote/local MCP config, tool listing/calling, protocol adapters |
| `@yolk-sdk/mcp/client/node` | Node-only local stdio convenience helpers                        |
| `@yolk-sdk/mcp/protocol`    | JSON-RPC/MCP wire helpers                                        |
| `@yolk-sdk/mcp/server`      | Tool-only MCP server primitives                                  |

## Imports

```ts
import { listMcpTools } from '@yolk-sdk/mcp/client'
import { listMcpToolsNode } from '@yolk-sdk/mcp/client/node'
import { makeJsonRpcRequest } from '@yolk-sdk/mcp/protocol'
import { makeMcpToolServer } from '@yolk-sdk/mcp/server'
```

## Remote client

```ts
import { Effect } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { listRemoteMcpServerTools } from '@yolk-sdk/mcp/client'

const tools = listRemoteMcpServerTools({
  name: 'docs',
  type: 'remote',
  url: 'https://example.com/mcp'
}).pipe(Effect.provide(FetchHttpClient.layer))

// Host chooses HttpClient layer and auth policy.
Effect.runPromise(tools)
```

## Local stdio client

```ts
import { listMcpToolsNode } from '@yolk-sdk/mcp/client/node'
```

`@yolk-sdk/mcp/client/node` may use Node process APIs. Keep Worker/browser imports on `@yolk-sdk/mcp/client`.

## Server

```ts
import { makeMcpToolServer } from '@yolk-sdk/mcp/server'
```

The server is tool-only. Hosts own HTTP routes, auth, deployment, and tool policy.
Protocol document parts are exposed as MCP resource blocks with encoded `file:///...` URIs.

## Host responsibilities

- Own persisted MCP server config, auth, and product tool policy.
- Provide HTTP runtime layers and credentials for remote MCP.
- Keep Node stdio usage behind Node-only hosts.

## Boundaries

- App auth, persisted config, policy, and product tools stay outside this package.
- Node convenience wrappers stay behind `@yolk-sdk/mcp/client/node`.
- MCP may adapt to `@yolk-sdk/agent/protocol` tool types; agent loop/providers stay MCP-agnostic.
- Remote MCP requires `https:` by default; localhost HTTP is explicit dev policy.

## Tree-shaking

- ESM package with `sideEffects: false`.
- Explicit subpath exports only.
- No wildcard exports or root feature barrel.
