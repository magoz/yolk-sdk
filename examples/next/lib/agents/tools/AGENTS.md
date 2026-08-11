# Agent Tools

Runtime-portable app tool modules consumed by Next, Workflow, voice, and Cloudflare adapters.

## Tool Matrix

| Tool/module                                                               | Text | Voice | Cloudflare                             | Notes                                                                          |
| ------------------------------------------------------------------------- | ---- | ----- | -------------------------------------- | ------------------------------------------------------------------------------ |
| `question`                                                                | yes  | no    | yes                                    | package HITL question tool; loop pauses/resumes before executor                |
| `web_fetch`                                                               | yes  | yes   | yes                                    | public URL fetch only                                                          |
| `web_search`                                                              | yes  | yes   | yes                                    | Exa/Parallel MCP endpoints                                                     |
| `skill`                                                                   | yes  | no    | bootstrap-injected; generated fallback | project skill command/runtime tool                                             |
| `manage_skills`                                                           | yes  | no    | no                                     | authenticated user skill creation/list/update                                  |
| `just_bash`                                                               | yes  | no    | yes                                    | just-bash virtual FS; network on; no host FS                                   |
| `list_knowledge_documents` / `search_knowledge` / `get_knowledge_context` | yes  | yes   | no                                     | authenticated user knowledge discovery, search, and chunk-window traversal     |
| `search_storage` / `list_storage_sources` / `get_storage_source`          | yes  | yes   | no                                     | authenticated user storage search and source reads                             |
| `telegram_send_message`                                                   | yes  | yes   | no                                     | optional Telegram connector tool; requires user config; available to subagents |
| remote MCP                                                                | yes  | no    | via bootstrap                          | namespaced `<server>_<tool>`                                                   |
| `subagent`                                                                | yes  | no    | no                                     | top-level child-agent delegation; no recursive delegation in v1                |

## Rules

- No Node-only imports/deps and no raw `fetch()` in this directory.
- Use Effect `Config`, `HttpClient`, Schema, and runtime-injected adapters.
- Define model-visible tool parameters with Effect Schema annotations and `makeTool`; avoid duplicated hand-written JSON schemas.
- New provider-facing optional tool params should accept `null` as well as omission: use `Schema.optional(Schema.NullOr(...))`, then normalize `null` to `undefined` before handlers.
- Use `EmptyToolParams` from `@yolk-sdk/agent/tools` for no-arg tools.
- Recoverable/model-correctable failures use `modelVisibleToolError` or `ToolResult.isError`; execution `ToolError`s become model-visible failed tool results, so keep messages safe and non-secret.
- Tool modules receive context `{ surface, route, userId, sessionId?, subagent?, skillset? }`; add policy via `isEnabled`.
- `just_bash` accepts script/cwd/stdin/timeout only; pass ad hoc data through stdin or script heredocs, not host files.
- Storage tools are Next/Workflow/voice only; they use app knowledge search/DB adapters from route runtime wiring, not Cloudflare bootstrap.
- Knowledge tools are Next/Workflow/voice only; use `list_knowledge_documents` to discover files/documents, then `search_knowledge`, then `get_knowledge_context` to expand/continue nearby chunks.
- `manage_skills` is Next/Workflow-only; it uses app DB skill adapters from route runtime wiring, not Cloudflare bootstrap; UI refreshes slash commands after completed runs.
- Text subagent execution also receives `sessionId`; subagent runs set `subagent: true` and intentionally omit the subagent tool from their own tool modules.
- Resolve caller-provided modules through `resolveAgentToolSet`; do not hide tools in globals.
- Keep tool result content model-visible and protocol-shaped.

## Security

- `web_fetch` blocks localhost/private/reserved IPs and revalidates redirects before fetching.
- `web_search` chooses provider by checksum unless `YOLK_WEBSEARCH_PROVIDER` overrides.
- `just_bash` uses a fresh in-memory virtual filesystem per call; network is enabled with literal private/loopback hosts denied; DNS rebinding checks are disabled for portable browser/Worker runtime; no host filesystem, JS, or Python.
- Unavailable remote MCP servers log warning and omit tools; malformed config fails earlier at the MCP file-source boundary.
- Local stdio MCP is package-level only; never import `@yolk-sdk/mcp/client/node` here.

## Tests

- Mock HTTP with `HttpClient` layers.
- Cover portability, SSRF/redirect rejection, config fallback, toolset resolution, and Cloudflare parity.
- Cloudflare shares `makeTextToolModules` via `cloudflare/agent/src/tool-modules.ts`; keep base text tool parity tests in sync.
