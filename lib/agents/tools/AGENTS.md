# Agent Tools

Runtime-portable app tool modules consumed by Next, Workflow, voice, and Cloudflare adapters.

## Tool Matrix

| Tool/module | Text | Voice | Cloudflare | Notes |
| ----------- | ---- | ----- | ---------- | ----- |
| `web_fetch` | yes | yes | yes | public URL fetch only |
| `web_search` | yes | yes | yes | Exa/Parallel MCP endpoints |
| `skill` | yes | no | generated bundle only | project skill command/runtime tool |
| `just_bash` | yes | no | yes | just-bash virtual FS; network on; no host FS |
| `search_storage` | yes | no | no | authenticated user storage RAG search |
| remote MCP | yes | no | via bootstrap | namespaced `<server>_<tool>` |
| `task` | yes | no | no | top-level subagent delegation; no recursive task in v1 |

## Rules

- No Node-only imports/deps and no raw `fetch()` in this directory.
- Use Effect `Config`, `HttpClient`, Schema, and runtime-injected adapters.
- Tool modules receive context `{ surface, route, userId }`; add policy via `isEnabled`.
- `just_bash` accepts script/cwd/stdin/timeout only; pass ad hoc data through stdin or script heredocs, not host files.
- `search_storage` is Next/Workflow-only; it uses app RAG adapters from route runtime wiring, not Cloudflare bootstrap.
- Text task execution also receives `sessionId`; subagent runs set `subagent: true` and intentionally omit task from their own tool modules.
- Resolve caller-provided modules through `resolveAgentToolSet`; do not hide tools in globals.
- Keep tool result content model-visible and protocol-shaped.

## Security

- `web_fetch` blocks localhost/private/reserved IPs and revalidates redirects before fetching.
- `web_search` chooses provider by checksum unless `YOLK_WEBSEARCH_PROVIDER` overrides.
- `just_bash` uses a fresh in-memory virtual filesystem per call; network is enabled with literal private/loopback hosts denied; DNS rebinding checks are disabled for portable browser/Worker runtime; no host filesystem, JS, or Python.
- Invalid/unavailable remote MCP config logs warning and omits tools.
- Local stdio MCP is package-level only; never import `@yolk/mcp/client/node` here.

## Tests

- Mock HTTP with `HttpClient` layers.
- Cover portability, SSRF/redirect rejection, config fallback, toolset resolution, and Cloudflare parity.
