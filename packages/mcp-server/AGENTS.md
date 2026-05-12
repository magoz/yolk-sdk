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
- Tool handler failures should return safe MCP `isError` tool results, not JSON-RPC errors, so callers can show error content to models.
- Convert protocol text/image/audio content and `structuredContent` back to MCP tool results without flattening media to text.
- Keep server primitives reusable across CLI, app routes, and tests.
- Use Effect platform `Stdio`/streams for stdio; callers provide `NodeStdio.layer` in Node CLIs.
- Do not use raw `node:readline` or direct `process.stdin/stdout/stderr` in package stdio code.
- Decode/encode JSON through `Schema.UnknownFromJsonString`; no raw JSON in production paths.
- Decode wire JSON in two steps: JSON string → unknown → JSON-RPC schema.
- Map parse vs validation separately: malformed JSON returns `-32700`; invalid JSON-RPC/params returns `-32600`.
- Do not write internal stdio errors to stderr; avoid leaking secrets and return JSON-RPC errors when possible.
- Keep `McpServerError.cause` granular enough to map protocol codes.

## Tests

- Cover initialize, tools/list, tools/call, unknown method/tool, invalid params, line handling, and HTTP handling.
- Use simple fake tools only.
- Stdio fixtures provide `NodeStdio.layer` explicitly.
