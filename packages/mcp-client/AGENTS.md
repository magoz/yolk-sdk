# MCP Client

`@yolk/mcp-client` is a domain-free host-executed MCP client and adapter layer. Apps decide config, auth, policy, and which MCP servers are available.

## Role

- Connect to remote JSON-RPC MCP servers over HTTP POST/SSE responses.
- Connect to local stdio MCP servers through Effect platform process APIs.
- List MCP tools and adapt them to protocol `ToolDef`s.
- Call MCP tools and normalize results/errors.
- Enforce local/remote policy gates encoded in config.

## Boundaries

- No app auth, product permissions, persisted config store, or UI.
- No raw `node:child_process`; use Effect platform APIs.
- No raw JSON parsing in production paths; use Effect Schema boundaries.
- Agent-loop and providers remain MCP-agnostic.

## Public model

| Export area | Purpose                                                |
| ----------- | ------------------------------------------------------ |
| `config`    | Local/remote MCP server config and policy types        |
| `client`    | List/call helpers for local, remote, and union configs |
| `protocol`  | MCP JSON-RPC protocol helpers/types                    |
| `errors`    | Typed MCP client/transport/protocol errors             |

## Design rules

- Remote MCP requires `https:` by default; localhost `http:` must be explicit dev policy.
- Local stdio receives explicit env only and must not inherit arbitrary env.
- Match stdio responses by JSON-RPC id; never assume response order.
- Reject duplicate generated tool names after server/tool sanitization.
- Keep host policy decisions outside this package except generic config gates.

## Tests

- Test remote transports with fake `HttpClient` layers.
- Test local stdio with tiny checked-in fixture servers.
- Cover malformed JSON-RPC, JSON-RPC errors, non-2xx remote responses, early exit, policy rejection, duplicate names, invalid params, and tool failures.
