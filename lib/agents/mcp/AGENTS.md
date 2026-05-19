# App MCP Config Source

Filesystem boundary for app-owned remote MCP server configuration.

## Source

- Reads `.yolk/mcp.json` or `.opencode/mcp.json` from project root.
- Config shape is an array of remote MCP servers: name, type, url, headers, enabled.
- App supports remote MCP only; local stdio stays in `@yolk-sdk/mcp/client` package tests/core.

## Boundaries

- Next app reads project files and passes parsed configs into tool modules.
- Cloudflare does not read filesystem/env for MCP; Next passes remote MCP configs in bootstrap.
- Invalid config should warn and omit tools, not crash the agent surface.

## Security

- Remote URLs require `https:` except package-level dev-local policies.
- Headers are config data; avoid logging secrets.
- Generated tool names are namespaced as `<server>_<tool>` downstream.

## Tests

- Keep source tests fake-file/project-scoped; do not call real MCP servers.
