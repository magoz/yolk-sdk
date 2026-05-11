# PRD: MCP v1

**Date:** 2026-05-11

---

## Problem Statement

### What problem are we solving?

Yolk agents currently have only app-owned tools (`web_fetch`, `web_search`). Users cannot connect standard MCP servers like Figma, Sentry, Context7, local devtools, or project-specific tool servers without bespoke app code. This blocks tool ecosystem reuse and makes each integration expensive.

### Why now?

The agent stack now has protocol content, tool registry, image support, and capability gating. MCP is the next tool surface needed before adding more bespoke integrations. Reference repos (`opencode`, `vltra`, `kody`, `flue`, `ai-sdk`, `mcp-sdk`) show both remote and local MCP matter.

### Who is affected?

- **Primary users:** Yolk agent users who want project/app tools from MCP servers.
- **Secondary users:** Developers adding tools; they should configure MCP instead of writing one-off adapters.

---

## Proposed Solution

### Overview

Add a domain-free, self-authored MCP client package that supports both remote MCP and local stdio MCP for tool discovery and execution. App code adapts discovered MCP tools into existing `ToolModule`/`ToolRegistration` objects so `agent-loop` and providers remain MCP-agnostic.

### User Experience

Users configure MCP servers for the text agent. When a configured MCP server connects, its tools appear as normal agent tools. Tool calls stream through the existing chat/tool UI.

#### User Flow: Remote MCP Tool

1. User configures a remote MCP server URL and optional headers.
2. Yolk discovers tools via MCP `initialize` + `tools/list`.
3. User asks a question needing that tool.
4. Agent calls the namespaced MCP tool.
5. User sees normal tool running/completed UI.

#### User Flow: Local MCP Tool

1. User enables local MCP and configures a command.
2. Yolk spawns the command server-side and initializes over stdio.
3. Yolk discovers tools and exposes them to the agent.
4. Tool calls execute over the stdio session.
5. Process is cleaned up when the scope ends.

---

## End State

When this PRD is complete, the following will be true:

- [ ] A domain-free `@yolk/mcp` package exists.
- [ ] Remote MCP over HTTP POST works for `initialize`, `tools/list`, and `tools/call`.
- [ ] Remote SSE responses are parsed for JSON-RPC messages.
- [ ] Local stdio MCP works with spawned command processes.
- [ ] MCP tool definitions convert to `@yolk/protocol` `ToolDef`.
- [ ] MCP tool results convert to `ToolResult` text content.
- [ ] MCP tools plug into `@yolk/tool-registry` through app adapter code.
- [ ] Local MCP is denied unless explicitly enabled.
- [x] Tests cover remote, local, conversion, errors, and disabled-local policy.
- [x] Docs capture config shape, security limits, and non-goals.

---

## Success Metrics

### Quantitative

| Metric                          | Current          | Target                           | Measurement Method |
| ------------------------------- | ---------------- | -------------------------------- | ------------------ |
| MCP tool servers usable         | 0                | ≥2 local/remote fixtures passing | Automated tests    |
| Bespoke app code per MCP server | Full tool module | Config-only for basic servers    | Code review        |
| Package type safety             | N/A              | `pnpm packages:check` passes     | Local checks       |

### Qualitative

- Adding a basic MCP server feels like config, not feature work.
- Future OAuth/resources/prompts can layer onto the same client abstractions.
- Agent-loop remains provider/tool-protocol agnostic.

---

## Acceptance Criteria

### Feature: MCP Config

- [ ] Config supports remote servers: `{ name, type: 'remote', url, headers?, enabled? }`.
- [ ] Config supports local servers: `{ name, type: 'local', command, environment?, enabled? }`.
- [ ] Local servers require explicit app-level enablement.
- [ ] Server and tool names are sanitized deterministically.

### Feature: Remote MCP

- [ ] Client sends valid JSON-RPC 2.0 `initialize`.
- [ ] Client sends `notifications/initialized` after initialization.
- [ ] Client lists tools via `tools/list`.
- [ ] Client calls tools via `tools/call`.
- [ ] JSON and SSE remote responses are supported.
- [ ] HTTP errors, JSON-RPC errors, malformed responses, and timeouts are typed failures.

### Feature: MCP Server Package

- [x] Tool-only `@yolk/mcp-server` package exists.
- [x] Server handles `initialize`, `tools/list`, and `tools/call`.
- [x] Server supports newline JSON-RPC for stdio fixtures.
- [x] Server supports HTTP POST via `handleHttpRequest`.
- [x] Tests cover unknown methods, unknown tools, invalid params, tool failures, and non-POST requests.

### Feature: Local stdio MCP

- [ ] Client spawns configured command with explicit environment only.
- [ ] Client communicates via newline-delimited JSON-RPC over stdio.
- [ ] Concurrent request IDs route to the correct pending call.
- [ ] Process stderr is captured without leaking secrets.
- [ ] Process is closed/killed on scope finalizer or startup failure.

### Feature: Tool Registry Adapter

- [ ] MCP tools are exposed as normal `ToolRegistration<AgentToolContext>` values.
- [ ] Duplicate generated tool names fail deterministically.
- [ ] Tool access defaults to `read` unless app config marks otherwise.
- [ ] Text route can include MCP tools alongside existing tools.

---

## Technical Context

### Existing Patterns

- `packages/tool-registry/src/registry.ts` — host apps define `ToolModule<Context>`; registry resolves enabled tools and adapts execution.
- `lib/agents/tools/registry.ts` — app composes tool modules for text/voice surfaces.
- `lib/agents/tools/web-search-tool.ts` — existing direct MCP-ish JSON-RPC call to remote providers.
- `packages/voice-runtime/src/*` — provider-neutral bridge pattern; app owns provider specifics.
- `.repos/opencode/packages/opencode/src/mcp/index.ts` — reference for remote/local/OAuth/status behavior.
- `.repos/vltra/app/api/mcp/[projectId]/route.ts` — simple JSON-RPC MCP server shape.
- `.repos/mcp-sdk/packages/core/src/types/*` — protocol schemas and constants reference.

### Key Files

- `packages/` — add `mcp` package and package docs.
- `packages/protocol/src/*` — existing `ToolDef`, `ToolCall`, `ToolResult` schemas.
- `packages/tool-registry/src/registry.ts` — integration point, should need no core change unless metadata must expand.
- `lib/agents/tools/registry.ts` — include MCP module when configured.
- `lib/agents/tools/` — app adapter/config boundary for MCP tools.
- `lib/agents/AGENTS.md`, `packages/AGENTS.md` — update after implementation.

### System Dependencies

- Node process spawning for local stdio MCP.
- Effect HTTP client for remote MCP.
- No dependency on `@modelcontextprotocol/sdk` in runtime code for v1; `.repos/mcp-sdk` is reference only.

### Data Model Changes

- None in v1. Use environment/file config first.

---

## Risks & Mitigations

| Risk                          | Likelihood | Impact | Mitigation                                                                                |
| ----------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------- |
| MCP protocol drift            | Medium     | High   | Mirror SDK tests/schemas for v1 methods; keep `.repos/mcp-sdk` reference updated          |
| Local command execution risk  | High       | High   | Disabled by default; explicit env only; no shell string execution; command array config   |
| Remote SSRF/data exfiltration | Medium     | High   | HTTPS-only by default; block private IPs unless dev opt-in; redact headers/logs           |
| OAuth servers fail            | High       | Medium | OAuth explicitly out of scope; surface typed `NeedsAuth`/unsupported error where detected |
| Non-text content loss         | Medium     | Medium | v1 stringifies or summarizes unsupported content; document limitation                     |
| Tool names collide            | Medium     | Medium | Namespace by server; deterministic sanitization; duplicate failure tests                  |

---

## Alternatives Considered

### Alternative 1: Use `@modelcontextprotocol/sdk`

- **Description:** Wrap official SDK client/transports.
- **Pros:** Faster, robust transports, protocol compliance.
- **Cons:** Larger dependency surface; less control; harder Effect-native errors/lifecycle.
- **Decision:** Rejected for v1. Use SDK repo as protocol reference while owning implementation.

### Alternative 2: Remote-only MCP

- **Description:** Implement HTTP/SSE only; defer local stdio.
- **Pros:** Smaller, safer first release.
- **Cons:** Misses common local devtool/package MCP use cases and VLTRA/OpenCode install patterns.
- **Decision:** Rejected. Support both, but local remains opt-in.

### Alternative 3: Provider-native MCP tools

- **Description:** Use provider Responses MCP tool shape (e.g. OpenAI `type: 'mcp'`).
- **Pros:** Provider handles remote server execution/auth.
- **Cons:** Provider-specific; bypasses `ToolRegistry`; unusable for local stdio and other providers.
- **Decision:** Rejected for v1. Could be future optimization.

---

## Non-Goals (v1)

- OAuth/DCR/token storage — defer until basic servers work.
- MCP resources/prompts — tools only.
- MCP apps/UI resources — defer.
- Progress notifications and resumability — defer.
- `tools/list_changed` subscriptions — defer.
- Binary/image MCP content rendering — text-only result conversion in v1.
- DB/team/project MCP management UI — env/file config first.
- Provider-native MCP execution — host-executed only.

---

## Interface Specifications

### Config

```ts
type McpServerConfig =
  | {
      readonly name: string
      readonly type: 'remote'
      readonly url: string
      readonly headers?: Readonly<Record<string, string>>
      readonly enabled?: boolean
    }
  | {
      readonly name: string
      readonly type: 'local'
      readonly command: ReadonlyArray<string>
      readonly environment?: Readonly<Record<string, string>>
      readonly enabled?: boolean
    }
```

Initial app config may be env JSON:

```env
YOLK_MCP_SERVERS='[{"name":"docs","type":"remote","url":"https://example.com/mcp"}]'
YOLK_MCP_LOCAL_ENABLED=false
```

### Package API

```ts
discoverMcpTools(config): Effect.Effect<ReadonlyArray<McpTool>, McpError, R>
callMcpTool(client, call): Effect.Effect<ToolResult, McpError, R>
makeMcpToolModule(config): Effect.Effect<ToolModule<AgentToolContext>, McpError, R>
```

### MCP Methods

```txt
initialize
notifications/initialized
tools/list
tools/call
```

---

## Documentation Requirements

- [ ] `packages/AGENTS.md` documents `@yolk/mcp` boundaries.
- [ ] `lib/agents/AGENTS.md` documents MCP config and security defaults.
- [ ] Root `AGENTS.md` adds `@yolk/mcp` to capabilities/code map if needed.
- [x] Package README or AGENTS note links `.repos/mcp-sdk` protocol reference.

---

## Open Questions

| Question                                           | Owner | Due Date   | Status                                               |
| -------------------------------------------------- | ----- | ---------- | ---------------------------------------------------- |
| Config source: env JSON vs checked-in file?        | User  | 2026-05-11 | Resolved: env JSON first (`YOLK_MCP_SERVERS`)        |
| Should MCP tools be text-only or text+voice in v1? | User  | 2026-05-11 | Resolved: text route first; voice after stable       |
| Allow `http://localhost` remote MCP in dev?        | User  | 2026-05-11 | Resolved: only with explicit dev flag                |
| Should all MCP tools default `access: read`?       | User  | 2026-05-11 | Resolved: default `read`; app override can come next |

---

## Appendix

### Glossary

- **Remote MCP:** MCP server reached over HTTP/SSE.
- **Local MCP:** MCP server launched as a local child process and spoken to over stdio.
- **Host-executed tool:** Yolk executes the tool and sends result back to the LLM provider.
- **Provider-native MCP:** LLM provider directly connects to MCP server.

### References

- `.repos/mcp-sdk` — official TypeScript SDK/protocol reference.
- `.repos/opencode/packages/opencode/src/mcp/index.ts` — remote/local/OAuth reference.
- `.repos/flue/packages/sdk/src/session.ts` — custom tools adapted into core tool shape.
- `.repos/kody/packages/worker/src/mcp/*` — MCP server/tool orchestration reference.
- `../vltra/app/api/mcp/[projectId]/route.ts` — simple JSON-RPC tools-only server.
