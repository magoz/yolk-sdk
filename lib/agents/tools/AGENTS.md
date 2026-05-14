# Agent Tools

Runtime-portable app tool modules consumed by Next, Workflow, voice, and Cloudflare adapters.

## Tool Matrix

| Tool/module | Text | Voice | Cloudflare | Notes |
| ----------- | ---- | ----- | ---------- | ----- |
| `web_fetch` | yes | yes | yes | public URL fetch only |
| `web_search` | yes | yes | yes | Exa/Parallel MCP endpoints |
| `skill` | yes | no | generated bundle only | project skill command/runtime tool |
| remote MCP | yes | no | via bootstrap | namespaced `<server>_<tool>` |
| `task` | yes | no | no | top-level subagent delegation; no recursive task in v1 |

## Rules

- No Node-only imports/deps and no raw `fetch()` in this directory.
- Use Effect `Config`, `HttpClient`, Schema, and runtime-injected adapters.
- Tool modules receive context `{ surface, route, userId }`; add policy via `isEnabled`.
- Text task execution also receives `sessionId`; subagent runs set `subagent: true` and intentionally omit task from their own tool modules.
- Resolve caller-provided modules through `resolveAgentToolSet`; do not hide tools in globals.
- Keep tool result content model-visible and protocol-shaped.

## Security

- `web_fetch` blocks localhost/private/reserved IPs and revalidates redirects before fetching.
- `web_search` chooses provider by checksum unless `YOLK_WEBSEARCH_PROVIDER` overrides.
- Invalid/unavailable remote MCP config logs warning and omits tools.
- Local stdio MCP is package-level only; never import `@yolk/mcp/client/node` here.

## Tests

- Mock HTTP with `HttpClient` layers.
- Cover portability, SSRF/redirect rejection, config fallback, toolset resolution, and Cloudflare parity.
