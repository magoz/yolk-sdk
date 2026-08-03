# MCP Package

`@yolk-sdk/mcp` is the top-level package for Model Context Protocol client/server APIs.

## Subpaths

| Subpath                     | Source                   | Role                                                       |
| --------------------------- | ------------------------ | ---------------------------------------------------------- |
| `@yolk-sdk/mcp/client`      | `src/client`             | Official full-core client plus Effect/Yolk tool adapters   |
| `@yolk-sdk/mcp/client/node` | `src/client/node.ts`     | Official stdio transport plus NodeServices wrappers        |
| `@yolk-sdk/mcp/core`        | `src/core.ts`            | Official MCP v2 wire schemas                               |
| `@yolk-sdk/mcp/protocol`    | `src/client/protocol.ts` | Yolk JSON-RPC/MCP adapter helpers                          |
| `@yolk-sdk/mcp/server`      | `src/server`             | Official full-core server plus Yolk tool-server primitives |
| `@yolk-sdk/mcp/server/node` | `src/server/node.ts`     | Official dual-era stdio server entrypoint                  |

## Boundaries

- MCP is external protocol infrastructure, not agent-core.
- App auth, persisted config, credential storage, policy, and product catalogs stay outside this package. Generic MCP OAuth protocol helpers may be re-exported from the official SDK.
- Keep NodeServices convenience wrappers behind `@yolk-sdk/mcp/client/node`; local client core stays in `@yolk-sdk/mcp/client`.
- Client/server may use `@yolk-sdk/agent/protocol` for generic tool/content adapters; agent loop/providers remain MCP-agnostic.
- Package architecture constraints live in `patterns/PACKAGE_ARCHITECTURE.md`.

## Client/server rules

- Effect/Yolk remote tool helpers use the official MCP v2 client over an Effect `HttpClient` fetch bridge; tests inject fake clients and apps provide runtime layers.
- Official `Client` defaults remain unchanged; callers must select `versionNegotiation: { mode: 'auto' }` or pin `2026-07-28` to use the modern protocol.
- Full-core server HTTP uses `createMcpHandler`; modern stdio uses `serveStdio` from the Node subpath. Both preserve legacy serving unless explicitly rejected.
- Remote MCP requires `https:` by default; `http://localhost` is dev-policy gated.
- Local stdio client core uses Effect platform process/stream APIs, not raw `node:child_process`; Node wrappers only provide `NodeServices.layer`.
- Local stdio receives explicit env only, uses `extendEnv: false`, ignores stderr, validates `initialize`, and matches responses by JSON-RPC id.
- Decode wire JSON in two steps: JSON string → unknown (`Schema.UnknownFromJsonString`) → protocol schema.
- Server `handleHttpRequest` maps JSON parse errors to `-32700`; invalid JSON-RPC/request params to `-32600`.
- Server stdio runner uses Effect `Stdio`; hosts provide the platform layer.
- Preserve discovered MCP `title`, input/output schemas, and annotations when adapting tools.
- Preserve MCP `structuredContent`, `isError`, and supported content blocks when adapting tool results.
- Server maps protocol documents to MCP resource blocks with encoded `file:///...` URIs.
- Export normal tool results/content; agent loop/providers stay MCP-agnostic.

## Tests

- Client transport/protocol tests live under `test/client`.
- Server protocol tests and stdio fixtures live under `test/server`.
