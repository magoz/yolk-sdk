# @yolk-sdk/mcp/client

Domain-free MCP client and tool adapter.

## What it provides

- Remote MCP JSON-RPC over HTTP POST and SSE responses.
- Local MCP stdio process transport through Effect platform APIs.
- Node stdio convenience wrappers via `@yolk-sdk/mcp/client/node`.
- Tool listing and call helpers.
- MCP tool to Yolk `ToolDef`/`ToolResult` adapters.
- Security policy gates for local and remote transports.

## Use it when

- A host app wants to expose configured MCP server tools to a Yolk agent.
- You need local or remote MCP client behavior without app-specific config storage.

## Boundaries

- No persisted config store.
- No app auth or product permissions.
- No agent loop/provider imports.
- Core local APIs require platform services; Node wrappers provide them at host boundary.
- Local children receive only configured `environment` values (`extendEnv: false`). Prefer an
  absolute executable such as `process.execPath`; bare executables and `/usr/bin/env` shebangs need
  an explicitly allowlisted `PATH`.
- Local servers remain disabled unless `securityPolicy.allowLocalServers` is explicitly true.
