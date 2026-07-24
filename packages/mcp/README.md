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
import { execPath } from 'node:process'
import { Effect } from 'effect'
import { listMcpToolsNode } from '@yolk-sdk/mcp/client/node'

const tools = await Effect.runPromise(
  listMcpToolsNode(
    [
      {
        name: 'local-tools',
        type: 'local',
        command: [execPath, './mcp-server.mjs'],
        environment: { LOG_LEVEL: 'error' }
      }
    ],
    {
      securityPolicy: {
        allowLocalServers: true,
        allowDevHttpLocalhost: false
      }
    }
  )
)
```

`@yolk-sdk/mcp/client/node` may use Node process APIs. Keep Worker/browser imports on `@yolk-sdk/mcp/client`.
Local servers are denied by default; opt in with `securityPolicy.allowLocalServers: true` only in a
trusted Node host. The child receives only the explicit `environment` map, not the host environment.
Prefer an absolute executable such as `execPath`; a bare executable or `/usr/bin/env` shebang needs
an explicitly allowlisted `PATH` in `environment`.

## Server

```ts
import { makeMcpToolServer, runStdioMcpServer } from '@yolk-sdk/mcp/server'
```

The server is tool-only. Hosts own HTTP routes, auth, deployment, and tool policy.
Protocol document parts are exposed as MCP resource blocks with encoded `file:///...` URIs.
`runStdioMcpServer` is for CLI hosts that provide an Effect `Stdio` layer.

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
