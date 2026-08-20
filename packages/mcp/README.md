# @yolk-sdk/mcp

MCP v2 (`2026-07-28`) client/server/protocol APIs, Effect/Yolk adapters, and legacy compatibility.

The root export is intentionally empty. Import APIs from explicit subpaths.

## Install

```bash
pnpm add @yolk-sdk/mcp@canary @yolk-sdk/agent@canary effect
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.
Published package metadata requires Node.js 22+; `client/node` and `server/node` are Node-only.

## Subpaths

| Subpath                     | Purpose                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `@yolk-sdk/mcp/client`      | Official full-core client plus Effect/Yolk list and call helpers       |
| `@yolk-sdk/mcp/client/node` | Official stdio client transport plus NodeServices convenience wrappers |
| `@yolk-sdk/mcp/core`        | Official MCP v2 wire schemas                                           |
| `@yolk-sdk/mcp/protocol`    | Yolk JSON-RPC/MCP adapter helpers                                      |
| `@yolk-sdk/mcp/server`      | Official full-core server plus Yolk tool-only server primitives        |
| `@yolk-sdk/mcp/server/node` | Official dual-era stdio server entrypoint                              |

Use `core` for the official full MCP wire-schema surface. Use `protocol` only for Yolk adapters and
legacy JSON-RPC helpers; it is not a replacement for the full-core APIs.

## Imports

```ts
import { Client } from '@yolk-sdk/mcp/client'
import { listLocalMcpServerToolsNode } from '@yolk-sdk/mcp/client/node'
import * as McpCore from '@yolk-sdk/mcp/core'
import { McpServer } from '@yolk-sdk/mcp/server'
import { serveStdio } from '@yolk-sdk/mcp/server/node'
```

## Use the full MCP v2 client

The official client surface supports tools, resources, prompts, completions, MRTR, response caching, subscriptions, OAuth helpers, and legacy negotiation.

```ts
import { Client, StreamableHTTPClientTransport } from '@yolk-sdk/mcp/client'

const client = new Client(
  { name: 'my-app', version: '1.0.0' },
  { versionNegotiation: { mode: 'auto' } }
)

await client.connect(new StreamableHTTPClientTransport(new URL('https://example.com/mcp')))

const { tools } = await client.listTools()
```

`mode: 'auto'` prefers stateless MCP `2026-07-28` and falls back to an initialize-based server. Pin `{ pin: '2026-07-28' }` for modern-only behavior. The upstream `Client` default remains legacy for compatibility.

## Use Effect/Yolk tool adapters

The high-level remote helpers use the official v2 client over an Effect `HttpClient` bridge. They negotiate modern MCP automatically, aggregate paginated tool lists, honor v2 routing headers and cache hints, and fall back to legacy servers. Discovered tools preserve provider `title`, `inputSchema`, `outputSchema`, and `annotations` metadata.

```ts
import { Effect } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { listRemoteMcpServerTools } from '@yolk-sdk/mcp/client'

const tools = await Effect.runPromise(
  listRemoteMcpServerTools({
    name: 'docs',
    type: 'remote',
    url: 'https://example.com/mcp'
  }).pipe(Effect.provide(FetchHttpClient.layer))
)
```

Use `McpClientOptions.sdk` for official client options such as capabilities, MRTR, and shared response caching. Set `McpClientOptions.configureClient` to register elicitation or sampling handlers before connection. Use a persistent official `Client` directly for long-lived subscriptions and progress streams.

## Connect to a local stdio server

Node hosts can use the convenience wrappers from `client/node`:

```ts
import { Effect } from 'effect'
import { listLocalMcpServerToolsNode } from '@yolk-sdk/mcp/client/node'

const tools = await Effect.runPromise(
  listLocalMcpServerToolsNode(
    {
      name: 'local-tools',
      type: 'local',
      command: [process.execPath, './mcp-server.mjs'],
      environment: {}
    },
    { securityPolicy: { allowLocalServers: true, allowDevHttpLocalhost: false } }
  )
)
```

Local servers are disabled by default. The host must explicitly allow them, choose a trusted
command, and provide the complete child environment; configured environment values do not extend
the host environment.

## Build a full MCP server

Use the official server surface for tools, resources, prompts, completions, MRTR, and subscriptions:

```ts
import { McpServer, createMcpHandler } from '@yolk-sdk/mcp/server'

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'my-server', version: '1.0.0' })
  // Register tools, resources, and prompts here.
  return server
})

export default { fetch: handler.fetch }
```

`createMcpHandler` serves stateless `2026-07-28` and legacy initialize-based HTTP clients from one endpoint. Validate `Origin` and `Host` before calling `handler.fetch`.

For dual-era Node stdio, import `serveStdio` from `@yolk-sdk/mcp/server/node`. This subpath owns the
Node stdio transport only; the host owns authorization, process lifecycle, logging, and deployment
policy.

## Adapt Yolk tools into MCP

```ts
import { makeMcpToolServer, runStdioMcpServer } from '@yolk-sdk/mcp/server'
```

`makeMcpToolServer` exposes approved Yolk tools. Its HTTP handler accepts both stateless v2 and legacy requests, validates browser origins against the endpoint hostname by default, and preserves MCP content and structured results. `runStdioMcpServer` remains the Effect-native minimal stdio adapter; use `serveStdio` for the full modern stdio surface.

## Host responsibilities

- Own persisted server config, credentials, authorization policy, and enabled capabilities.
- Partition private MCP caches by authorization context.
- Validate HTTP `Origin` and `Host` at deployment boundaries.
- Keep Node stdio usage behind trusted Node hosts and explicitly control child commands and environments.
- Treat tool annotations, server identity, icons, and request state as untrusted input.

Remote MCP requires HTTPS by default; localhost HTTP is an explicit development policy.

## Boundaries

- MCP is external protocol infrastructure, not agent-loop or provider policy.
- `core`, `client`, and `server` expose protocol mechanics; Yolk adapters bridge generic tool and
  content contracts only.
- App auth, credential storage, persisted server config, and product catalogs remain host-owned.
- Node process and stdio conveniences stay behind `client/node` and `server/node`.
