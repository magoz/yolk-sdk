# @yolk-sdk/mcp/server

Full-core MCP v2 server exports plus reusable Yolk tool-server primitives.

## What it provides

- Official `McpServer`, `createMcpHandler`, resource and prompt registration, completions, MRTR, subscriptions, caching, and protocol helpers.
- Dual-era HTTP serving: stateless MCP `2026-07-28` plus initialize-based legacy clients.
- Official dual-era Node stdio through `@yolk-sdk/mcp/server/node`.
- `makeMcpToolServer` for exposing Yolk-compatible tools through a minimal API.
- Effect-native `runStdioMcpServer` for the minimal Yolk tool adapter.

Use the official server surface when you need resources, prompts, completions, MRTR, or subscriptions. Use `makeMcpToolServer` when you only need to expose an approved Yolk tool set.

## Boundaries

- No app authentication implementation, credential storage, deployment, or product policy.
- Hosts validate HTTP `Origin` and `Host`; the Yolk tool-only handler defaults browser origins to its endpoint hostname.
- Node stdio entrypoints remain behind `@yolk-sdk/mcp/server/node`.
