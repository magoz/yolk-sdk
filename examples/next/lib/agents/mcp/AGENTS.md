# App MCP Config Source

Filesystem boundary for app-owned remote MCP server configuration.

## Source

- Reads `.yolk/mcp.json` and `.opencode/mcp.json` from project root when present.
- Duplicate server names are last-wins; `.opencode/mcp.json` overrides `.yolk/mcp.json` by name.
- Config shape is an array of remote MCP servers: name, type, url, headers, enabled.
- App supports remote MCP only; local stdio stays behind `@yolk-sdk/mcp/client/node` package tests/core.

## Boundaries

- Next app reads project files and passes parsed configs into tool modules.
- Cloudflare does not read filesystem/env for MCP; Next passes remote MCP configs in bootstrap.
- Malformed config currently fails at the file-source boundary; unavailable remote MCP servers warn and omit tools.

## Security

- Remote URLs require `https:` except package-level dev-local policies.
- Headers are config data; avoid logging secrets.
- Generated tool names are namespaced as `<server>_<tool>` downstream.

## Tests

- Keep source tests fake-file/project-scoped; do not call real MCP servers.
