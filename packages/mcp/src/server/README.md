# @yolk/mcp/server

Reusable tool-only MCP server primitives.

## What it provides

- MCP `initialize`, `tools/list`, and `tools/call` handling.
- HTTP POST JSON-RPC entrypoint.
- Newline-delimited stdio runner over Effect `Stdio`.
- Tool-only server creation from generic Yolk tool handlers.

## Use it when

- You want to expose Yolk-compatible tools through MCP.
- You need a minimal MCP tool server for app routes, CLIs, or tests.

## Boundaries

- No MCP resources or prompts.
- No OAuth/app auth.
- No framework-specific server dependency.
- Node stdio CLIs provide `NodeStdio.layer` at the boundary.
