# @yolk-sdk/mcp/client

Full-core MCP v2 client exports plus Effect/Yolk tool adapters.

## What it provides

- Official `Client` and Streamable HTTP APIs for MCP `2026-07-28`.
- Tools, resources, prompts, completions, MRTR, subscriptions, caching, and OAuth protocol helpers.
- Automatic modern-to-legacy negotiation when `versionNegotiation.mode` is `auto`.
- Effect `HttpClient`-backed remote Yolk tool listing and calling.
- Node stdio transports and convenience wrappers through `@yolk-sdk/mcp/client/node`.
- MCP tool-to-Yolk `ToolDef` / `ToolResult` adapters.

The official `Client` keeps its upstream legacy default. Select `versionNegotiation: { mode: 'auto' }` or pin `2026-07-28` for modern MCP.

## Boundaries

- No persisted config, credential store, app auth, or product permissions.
- Effect/Yolk remote helpers require a host-provided `HttpClient` layer.
- Local Yolk helpers require platform process services; Node wrappers provide them at the host boundary.
- Local children receive only configured `environment` values with `extendEnv: false`.
- Local servers remain disabled unless `securityPolicy.allowLocalServers` is explicitly true.
