# MCP Server

`@yolk/mcp-server` provides reusable tool-only MCP server primitives and stdio/HTTP entrypoints. It is generic infrastructure, not an app server.

## Role

- Serve MCP `initialize`, `tools/list`, and `tools/call`.
- Expose newline JSON-RPC handling for stdio servers.
- Expose HTTP POST handling for remote MCP servers.
- Adapt generic tool definitions/results into MCP JSON-RPC responses.

## Boundaries

- No resources, prompts, OAuth, app auth, or product permissions in v1.
- No concrete app tool catalogs; callers provide tool handlers.
- No framework-specific server dependency; HTTP entrypoint remains primitive/generic.
- No secret logging through stderr or errors.

## Public model

| Export area | Purpose                                |
| ----------- | -------------------------------------- |
| `server`    | Tool-only MCP JSON-RPC server behavior |
| `stdio`     | Line-oriented stdio runner helpers     |
| `errors`    | Typed MCP server errors                |

## Design rules

- Keep JSON-RPC id handling exact for responses and errors.
- Unknown methods/tools and invalid params must return protocol-shaped errors.
- Tool failures should be converted into safe MCP tool results/errors.
- Keep server primitives reusable across CLI, app routes, and tests.

## Tests

- Cover initialize, tools/list, tools/call, unknown method/tool, invalid params, line handling, and HTTP handling.
- Use simple fake tools only.
