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
- Core APIs must not provide `NodeServices.layer`; expose Node convenience through `@yolk/mcp-client/node`.
- No raw JSON parsing in production paths; use Effect Schema boundaries.
- Decode wire JSON in two steps: JSON string → unknown → JSON-RPC schema.
- Agent-loop and providers remain MCP-agnostic.

## Public model

| Export area | Purpose                                                  |
| ----------- | -------------------------------------------------------- |
| `config`    | Local/remote MCP server config and policy types          |
| `client`    | List/call helpers for local, remote, and union configs   |
| `node`      | Node convenience wrappers providing `NodeServices.layer` |
| `protocol`  | MCP JSON-RPC protocol helpers/types                      |
| `errors`    | Typed MCP client/transport/protocol errors               |

## Design rules

- Remote MCP requires `https:` by default; localhost `http:` must be explicit dev policy.
- Local stdio receives explicit env only and must not inherit arbitrary env.
- Do not inject default env into local stdio; use exactly `config.environment ?? {}` with `extendEnv: false`.
- Core local helpers require `ChildProcessSpawner`; Node wrappers provide it at the boundary.
- Match stdio responses by JSON-RPC id; never assume response order.
- Validate `initialize` JSON-RPC response before consuming target request response.
- Preserve MCP `isError` tool-call results as normal `ToolResult`s so the model can self-correct and UI can style tool-origin errors.
- Map MCP text/image/audio/resource/resource_link blocks into protocol content without leaking MCP-specific block types.
- Keep parse/encoding/validation causes distinct for transport debugging.
- Reject duplicate generated tool names after server/tool sanitization.
- Keep host policy decisions outside this package except generic config gates.

## Tests

- Test-local rules live in `test/AGENTS.md`.
- Test remote transports with fake `HttpClient` layers.
- Test core local stdio with fake `ChildProcessSpawner` layers when process behavior is not under test.
- Test local stdio with tiny checked-in fixture servers.
- Cover malformed JSON-RPC, JSON-RPC errors, non-2xx remote responses, early exit, policy rejection, duplicate names, invalid params, and tool failures.
