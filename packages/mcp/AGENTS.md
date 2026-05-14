# MCP Package

`@yolk/mcp` is the top-level package for Model Context Protocol client/server APIs.

## Subpaths

| Subpath | Source | Role |
| --- | --- | --- |
| `@yolk/mcp/client` | `src/client` | MCP client/config/tool adapters |
| `@yolk/mcp/client/node` | `src/client/node.ts` | Node convenience wrappers |
| `@yolk/mcp/protocol` | `src/client/protocol.ts` | JSON-RPC/MCP protocol helpers |
| `@yolk/mcp/server` | `src/server` | Tool-only MCP server primitives |

## Boundaries

- MCP is external protocol infrastructure, not agent-core.
- App auth, persisted config, policy, and product tool catalogs stay outside this package.
- Keep Node-specific helpers behind `@yolk/mcp/client/node`.
- Client/server may use `@yolk/agent/protocol` for generic `ToolDef`/`ToolResult`; agent loop/providers remain MCP-agnostic.

## Tests

- Client transport/protocol tests live under `test/client`.
- Server protocol tests and stdio fixtures live under `test/server`.
