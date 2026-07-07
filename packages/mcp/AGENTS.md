# MCP Package

`@yolk-sdk/mcp` is the top-level package for Model Context Protocol client/server APIs.

## Subpaths

| Subpath                     | Source                   | Role                                                    |
| --------------------------- | ------------------------ | ------------------------------------------------------- |
| `@yolk-sdk/mcp/client`      | `src/client`             | MCP client/config/tool adapters                         |
| `@yolk-sdk/mcp/client/node` | `src/client/node.ts`     | Node convenience wrappers                               |
| `@yolk-sdk/mcp/protocol`    | `src/client/protocol.ts` | JSON-RPC/MCP protocol helpers                           |
| `@yolk-sdk/mcp/server`      | `src/server`             | Tool-only MCP server primitives and Effect stdio runner |

## Boundaries

- MCP is external protocol infrastructure, not agent-core.
- App auth, persisted config, policy, and product tool catalogs stay outside this package.
- Keep Node-specific helpers behind `@yolk-sdk/mcp/client/node`.
- Client/server may use `@yolk-sdk/agent/protocol` for generic tool/content adapters; agent loop/providers remain MCP-agnostic.
- Package architecture constraints live in `patterns/PACKAGE_ARCHITECTURE.md`.

## Client/server rules

- Remote MCP uses Effect `HttpClient`; tests inject fake clients, apps provide runtime layers.
- Remote MCP requires `https:` by default; `http://localhost` is dev-policy gated.
- Local stdio lives behind `@yolk-sdk/mcp/client/node`; use Effect platform process/stream APIs, not raw `node:child_process`.
- Local stdio receives explicit env only, uses `extendEnv: false`, ignores stderr, validates `initialize`, and matches responses by JSON-RPC id.
- Decode wire JSON in two steps: JSON string → unknown (`Schema.UnknownFromJsonString`) → protocol schema.
- Server maps JSON parse errors to `-32700`; invalid JSON-RPC/request params to `-32600`.
- Server stdio runner uses Effect `Stdio`; hosts provide the platform layer.
- Preserve MCP `structuredContent`, `isError`, and supported content blocks when adapting tool results.
- Server maps protocol documents to MCP resource blocks with encoded `file:///...` URIs.
- Export normal tool results/content; agent loop/providers stay MCP-agnostic.

## Tests

- Client transport/protocol tests live under `test/client`.
- Server protocol tests and stdio fixtures live under `test/server`.
