# Reusable Agent Stack

Domain-free packages. No users, teams, orgs, projects, billing, OAuth, knowledge stores, or product permissions here.

## Packages

| Package               | Role                                                    | Depends on                                   |
| --------------------- | ------------------------------------------------------- | -------------------------------------------- |
| `@yolk/protocol`      | Shared schemas, messages, tools, events                 | Effect                                       |
| `@yolk/agent-loop`    | Stateless LLM ⇄ tool turn loop                          | `@yolk/protocol`, Effect                     |
| `@yolk/agent-runtime` | Session load/save orchestration over agent-loop         | `@yolk/protocol`, `@yolk/agent-loop`, Effect |
| `@yolk/tool-registry` | Scoped tool modules + executor layer                    | `@yolk/protocol`, `@yolk/agent-loop`, Effect |
| `@yolk/voice-runtime` | Provider-neutral voice tool-call bridge                 | `@yolk/protocol`, `@yolk/agent-loop`, Effect |
| `@yolk/client`        | Effect stream transport + generic reducer/state helpers | `@yolk/protocol`, Effect                     |
| `@yolk/react`         | Headless React hooks over client state/transport         | `@yolk/client`, `@yolk/protocol`, Effect     |
| `@yolk/mcp`           | MCP JSON-RPC client + protocol/tool adapters            | `@yolk/protocol`, Effect                     |
| `@yolk/mcp-server`    | MCP JSON-RPC tool server primitives + stdio/HTTP runner | `@yolk/protocol`, `@yolk/mcp`, Effect        |

## Dependency Rule

```txt
app -> agent-runtime -> agent-loop -> protocol
app -> agent-loop -> protocol
app -> tool-registry -> agent-loop -> protocol
app -> voice-runtime -> agent-loop -> protocol
app -> client -> protocol + Effect
app -> react -> client -> protocol + Effect
app -> mcp -> protocol + Effect
mcp-server -> mcp + protocol + Effect
```

## Naming

- `agent-loop` = pure model/tool loop; messages in, events out.
- `agent-runtime` = server lifecycle: sessions, persistence, resume/fanout adapters.
- `client` = UI-side consumer; never runs the loop in production.
- Avoid `harness` for current packages; reserve for a future batteries-included agent kit if needed.
- Avoid `executor` for loop code; use for future sandbox/tool execution layer if needed.

## Boundaries

- App/server owns auth, prompts, domain context, tool policy, integrations, model choice.
- App/server owns LLM provider implementations, OAuth flows, and token storage (`lib/agents`, `lib/services/*oauth*`).
- Runtime may be generic over opaque `Ctx`; it must not interpret product context.
- Agent-loop must stay stateless: no persistence, sessions, WebSockets/SSE, compaction policy, or app context.
- Tool-registry owns generic tool metadata/scope resolution, not app/domain tools.
- Client transport should work for Next UI and Chrome extension by consuming protocol events from a server endpoint; app UI may own richer parts state.
- React package owns headless hooks only: no components, styling, auth chrome, or provider-specific UI.
- Voice-runtime may bridge provider tool calls to `ToolExecutor`; provider/WebRTC specifics stay in app/adapters.
- `packages/harness/` is stale/empty and not a real workspace package unless a `package.json` is added.

## Reasoning

- `AgentReasoningEffort` is protocol-only request config; app chooses values, agent-loop/provider layers pass through.
- `agent-runtime` does not yet thread `reasoningEffort`; text `/api/agent` calls agent-loop through app route helpers.
- `LLMReasoningDelta` is provider-supplied summary text only; never fabricate reasoning.
- `accumulateAssistantMessage` stores collected reasoning on `Assistant.reasoning`.

## Content + Capabilities

- `Content = string | ContentPart[]`; parts currently `Text`, `Image`, `Audio`.
- Use protocol helpers (`contentText`, `contentPreview`, `contentParts`, `isContentEmpty`, `appendTextToContent`) instead of app-local duplication.
- `AgentModelCapabilities` is protocol-only; app/provider config chooses text-only vs text+image and agent-loop rejects unsupported input before provider calls.
- Provider adapters map protocol content to provider-specific request parts; packages must not import provider SDKs.

## Tool Registry

- Host apps define `ToolModule<Context>` and `ToolRegistration<Context>`.
- `resolveTools(modules, context)` filters enabled tools and rejects duplicate names.
- `makeToolExecutorLayer(toolSet)` adapts resolved tools to `ToolExecutor`.
- `access: read | write | destructive` is metadata for policy/approvals; enforcement is host-owned.
- Prefer `Effect.forEach` + `Array`/`Option` helpers over mutable loop/push collection code.
- Do not import auth, storage, provider SDKs, or product tool catalogs here.

## MCP

- `@yolk/mcp` is a domain-free host-executed MCP client; app decides config, auth, and policy.
- `@yolk/mcp-server` is a reusable tool-only MCP server; keep it generic for reuse across projects.
- Supports remote JSON-RPC over HTTP POST with JSON or SSE responses and local stdio servers.
- MCP server v1 supports `initialize`, `tools/list`, and `tools/call`; no resources, prompts, OAuth, or app auth.
- MCP server exposes both newline JSON-RPC (`handleLine`/stdio) and HTTP POST (`handleHttpRequest`) entrypoints.
- Remote MCP depends on `HttpClient`; package tests inject a fake client, app adapters provide `FetchHttpClient.layer`.
- Remote MCP requires `https:` by default; `http://localhost` is policy-gated for dev only.
- Local stdio uses Effect v4 process/stream APIs (`ChildProcess`, `Stream`) plus `@effect/platform-node`; avoid raw `node:child_process`.
- Local stdio is policy-gated, receives explicit env only, sets `extendEnv: false`, and ignores stderr to avoid secret leaks.
- Local stdio responses are matched by JSON-RPC id; do not assume response order.
- JSON encode/decode uses Effect Schema (`UnknownFromJsonString`); avoid raw JSON in production MCP code.
- Export normal `ToolDef`/`ToolResult`; agent-loop and providers stay MCP-agnostic.
- `listMcpTools` rejects duplicate generated tool names after server/tool sanitization.
- Prefer local/remote-specific helper APIs in tests (`listLocalMcpServerTools`, `callLocalMcpServerTool`, `listRemoteMcpServerTools`, `callRemoteMcpServerTool`) when the config kind is known; use union helpers at app boundaries.
- Test MCP transports below UI level: fake `HttpClient` layers for remote JSON/SSE and tiny checked-in stdio fixture servers for local process behavior.
- Cover protocol/transport error paths: malformed JSON-RPC, JSON-RPC error responses, non-2xx remote responses, local stdio early exit, policy rejection, unknown methods/tools, invalid params, and tool failures.
- Use Playwright for MCP only when browser-visible `/agent` behavior is under test; avoid it for protocol/client transport coverage.

## Voice Runtime

- `VoiceToolCallRequest` accepts provider-normalized `{ callId, name, arguments }`.
- `executeVoiceToolCall` decodes/encodes JSON via `Schema.UnknownFromJsonString`.
- `VoiceToolExecutionResult.output` is a JSON string envelope: `{ result }` or `{ error }`.
- Voice string tool results are truncated before encoding to keep Realtime responses live.
- Provider adapters convert `VoiceToolExecutionResult` into provider-specific tool output events.
- Do not import OpenAI Realtime, WebRTC, auth, or app tool catalogs here.

## Client Transport

- `/agent` uses app-local parts state (`app/agent/agent-chat-messages.ts`) and imports `@yolk/client` primarily for transport.
- `AgentTranscript` is a non-empty protocol transcript owned by the client/UI.
- `AgentClientState.messages` stores stable protocol messages; `liveMessages` stores completed assistant/tool turns during active runs.
- `text`/`reasoning` are current streaming drafts only; `AssistantMessageEvent` commits a live assistant turn and clears drafts.
- `AgentToolRun` is the single client tool lifecycle object: `Called` → `Running(startedAtMs)` → `Completed(result, startedAtMs, endedAtMs)`.
- Keep tool timing/result on `AgentToolRun`; avoid separate arrays that must be rejoined by id.
- `submitAgentUserMessage` appends user messages locally before transport starts.
- `streamAgentEventStream` = Effect `Stream` over NDJSON endpoint.
- `streamAgentEvents` = async generator compatibility wrapper for browser UI.
- `collectAgentEventsEffect` = Effect-native collection helper.
- `collectAgentEvents` = async collection helper.
- Requests send a non-empty client-owned `AgentTranscript` (`messages`), not just the latest prompt.
- Optional `reasoningEffort` is forwarded to the server; provider support is app-owned.
- `StreamAgentEventsRequest.signal` interrupts Effect `HttpClient` request/body reads.
- Mock client HTTP with `HttpClient` layers, not fetch-style helpers.
- Keep parsing/schema errors typed as `AgentTransportError`.
- Use `Schema.UnknownFromJsonString` for NDJSON/body JSON boundaries.

## React

- `@yolk/react` is the headless React layer for app builders.
- It wraps `@yolk/client` transport and exposes render-ready chat state.
- `chatMessages` is the primary UI model; `messages` is derived protocol replay for transport/debugging.
- `AgentChatPart` covers text, reasoning, tool call/result, and error parts; no DOM assumptions.
- `buildAgentChatItems` is a convenience flat projection, not a required UI structure.
- Keep actual components, styling, auth panels, provider controls, and app chrome outside this package.
- Default transport is injectable; host apps can point at any compatible agent endpoint.
- App local chat files may re-export this package to keep example tests close to the UI.

## Test Helpers

- `@yolk/agent-loop/testing` exports `FauxProvider`, `Reply`, and `TestToolExecutor` for tests.
- Keep test helpers behind explicit `./testing` subpath exports; do not grow the production root API casually.
- Package exports point to TypeScript source (`src/index.ts`), not `dist`.
- `pnpm packages:check` typechecks package `src`; package test files are exercised through `pnpm test:run`.

## Workspace Setup

- Shared dependency pins live in `pnpm-workspace.yaml` catalogs; use `catalog:` for Effect-family packages, TypeScript, and Vitest.
- Root `packageManager` pins pnpm for reproducible installs.
- Package tsconfigs extend `packages/tsconfig.base.json`; keep package-local configs to `outDir`, `rootDir`, and include/exclude overrides.
- Keep package dependencies explicit in each package manifest even when versions come from catalogs.
- Internal `@yolk/*` dependencies use `workspace:^`; pnpm links locally and publishes semver ranges later.

## Versioning Plan

- Before publishing, use Changesets fixed/lockstep versioning for all `@yolk/*` packages, mirroring Effect's `fixed` group model.
- Bump all public `@yolk/*` package versions together, even when only one package changed.
- Keep `updateInternalDependencies: "patch"` so internal dependency ranges stay compatible after releases.
- Prefer compatibility simplicity over per-package version precision; protocol/runtime/client packages are tightly coupled.

## Package Publishing TODOs

- Move publishable package exports from `src` to `dist` before npm publishing.
- Add `peerDependencies` for host-owned runtime singletons like `effect`.
- Add Changesets with fixed group for `@yolk/*` package versioning/release notes.
- Add package metadata: license, repository directory, engines, publishConfig.
- Add `publint` or equivalent package export validation.
- Add package READMEs before public npm release.
- Curate explicit public exports instead of broad root `export *`.
