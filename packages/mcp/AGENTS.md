# MCP Package

`@yolk-sdk/mcp` is the top-level package for Model Context Protocol client/server APIs.

## Subpaths

| Subpath | Source | Role |
| --- | --- | --- |
| `@yolk-sdk/mcp/client` | `src/client` | MCP client/config/tool adapters |
| `@yolk-sdk/mcp/client/node` | `src/client/node.ts` | Node convenience wrappers |
| `@yolk-sdk/mcp/protocol` | `src/client/protocol.ts` | JSON-RPC/MCP protocol helpers |
| `@yolk-sdk/mcp/server` | `src/server` | Tool-only MCP server primitives |

## Boundaries

- MCP is external protocol infrastructure, not agent-core.
- App auth, persisted config, policy, and product tool catalogs stay outside this package.
- Keep Node-specific helpers behind `@yolk-sdk/mcp/client/node`.
- Client/server may use `@yolk-sdk/agent/protocol` for generic `ToolDef`/`ToolResult`; agent loop/providers remain MCP-agnostic.
- Package architecture constraints live in `patterns/PACKAGE_ARCHITECTURE.md`.

## Tests

- Client transport/protocol tests live under `test/client`.
- Server protocol tests and stdio fixtures live under `test/server`.
