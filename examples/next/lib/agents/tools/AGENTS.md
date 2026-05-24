# Agent Tools

Runtime-portable app tool modules consumed by Next, Workflow, voice, and Cloudflare adapters.

## Tool Matrix

| Tool/module | Text | Voice | Cloudflare | Notes |
| ----------- | ---- | ----- | ---------- | ----- |
| `question` | yes | no | yes | package HITL question tool; loop pauses/resumes before executor |
| `web_fetch` | yes | yes | yes | public URL fetch only |
| `web_search` | yes | yes | yes | Exa/Parallel MCP endpoints |
| `skill` | yes | no | generated bundle only | project skill command/runtime tool |
| `manage_skills` | yes | no | no | authenticated user skill creation/list/update |
| `just_bash` | yes | no | yes | just-bash virtual FS; network on; no host FS |
| `list_knowledge_records` / `search_knowledge` / `get_knowledge_context` | yes | yes | no | authenticated user knowledge discovery, search, and chunk-window traversal |
| `search_storage` / `list_storage_sources` / `get_storage_source` | yes | yes | no | authenticated user storage search and source reads |
| `telegram_send_message` | yes | yes | no | optional Telegram connector tool; requires user config; available to task subagents |
| remote MCP | yes | no | via bootstrap | namespaced `<server>_<tool>` |
| `task` | yes | no | no | top-level subagent delegation; no recursive task in v1 |

## Rules

- No Node-only imports/deps and no raw `fetch()` in this directory.
- Use Effect `Config`, `HttpClient`, Schema, and runtime-injected adapters.
- Define model-visible tool parameters with Effect Schema annotations and `makeTool`; avoid duplicated hand-written JSON schemas.
- Optional model tool params should accept `null` as well as omission: use `Schema.optional(Schema.NullOr(...))`, then normalize `null` to `undefined` before handlers.
- Use `EmptyToolParams` from `@yolk-sdk/agent/tools` for no-arg tools.
- Tool modules receive context `{ surface, route, userId }`; add policy via `isEnabled`.
- `just_bash` accepts script/cwd/stdin/timeout only; pass ad hoc data through stdin or script heredocs, not host files.
- Storage tools are Next/Workflow/voice only; they use app knowledge search/DB adapters from route runtime wiring, not Cloudflare bootstrap.
- Knowledge tools are Next/Workflow/voice only; use `list_knowledge_records` to discover files/records, then `search_knowledge`, then `get_knowledge_context` to expand/continue nearby chunks.
- `manage_skills` is Next/Workflow-only; it uses app DB skill adapters from route runtime wiring, not Cloudflare bootstrap; UI refreshes slash commands after completed runs.
- Text task execution also receives `sessionId`; subagent runs set `subagent: true` and intentionally omit task from their own tool modules.
- Resolve caller-provided modules through `resolveAgentToolSet`; do not hide tools in globals.
- Keep tool result content model-visible and protocol-shaped.

## Security

- `web_fetch` blocks localhost/private/reserved IPs and revalidates redirects before fetching.
- `web_search` chooses provider by checksum unless `YOLK_WEBSEARCH_PROVIDER` overrides.
- `just_bash` uses a fresh in-memory virtual filesystem per call; network is enabled with literal private/loopback hosts denied; DNS rebinding checks are disabled for portable browser/Worker runtime; no host filesystem, JS, or Python.
- Invalid/unavailable remote MCP config logs warning and omits tools.
- Local stdio MCP is package-level only; never import `@yolk-sdk/mcp/client/node` here.

## Tests

- Mock HTTP with `HttpClient` layers.
- Cover portability, SSRF/redirect rejection, config fallback, toolset resolution, and Cloudflare parity.
