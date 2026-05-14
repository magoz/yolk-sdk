# Reusable Agent Stack

Reusable packages. Core agent packages stay domain-free. Provider/OAuth packages may model vendor auth mechanics and wire contracts, but must not own app users, teams, orgs, projects, billing, token storage, or product permissions.

## Packages

| Package               | Role                                                    | Depends on                                   |
| --------------------- | ------------------------------------------------------- | -------------------------------------------- |
| `@yolk/agent`         | Main agent package with protocol/loop/runtime/client/tools subpaths | Effect |
| `@yolk/rag`           | Domain-free retrieval/ingestion/chunking primitives     | `@yolk/agent/protocol`, `@yolk/agent/tools`, Effect |
| `@yolk/mcp`           | MCP client/server/protocol package with explicit subpaths | `@yolk/agent/protocol`, Effect |
| `@yolk/agent/protocol`      | Shared schemas, messages, tools, events                 | Effect                                       |
| `@yolk/agent/loop`    | Stateless LLM ⇄ tool turn loop                          | `@yolk/agent/protocol`, Effect                     |
| `@yolk/agent/runtime` | Session load/save orchestration over agent-loop         | `@yolk/agent/protocol`, `@yolk/agent/loop`, Effect |
| `@yolk/vercel-workflows-runtime` | Vercel Workflow durable model/tool step loop contract | Effect, workflow |
| `@yolk/agent/tools` | Scoped tool modules + executor layer                    | `@yolk/agent/protocol`, `@yolk/agent/loop`, Effect |
| `@yolk/skillset`      | Portable skill + command parsing/catalog primitives     | Effect                                       |
| `@yolk/voice-runtime` | Provider-neutral voice tool-call bridge                 | `@yolk/agent/protocol`, `@yolk/agent/loop`, Effect |
| `@yolk/agent/client`        | Effect stream transport + generic reducer/state helpers | `@yolk/agent/protocol`, Effect                     |
| `@yolk/react`         | Headless React hooks over client state/transport        | `@yolk/agent`, Effect                        |
| `@yolk/mcp/client`    | MCP JSON-RPC client + protocol/tool adapters            | `@yolk/agent/protocol`, Effect                     |
| `@yolk/mcp/server`    | MCP JSON-RPC tool server primitives + stdio/HTTP runner | `@yolk/agent/protocol`, `@yolk/mcp/client`, Effect |
| `@yolk/oauth`         | Generic OAuth token broker and credential-source contracts | Effect                                    |
| `@yolk/anthropic`     | Anthropic/Claude provider auth mechanics and reusable constants | `@yolk/oauth`, Effect               |
| `@yolk/openai`        | OpenAI/Codex provider auth mechanics and reusable constants | `@yolk/oauth`, Effect                    |

## Dependency Rule

```txt
app -> agent subpaths
app -> rag -> agent/protocol + agent/tools
app -> vercel-workflows-runtime -> Effect + workflow
app -> skillset -> Effect
app -> voice-runtime -> agent/loop + agent/protocol
app -> react -> agent/client + agent/protocol + Effect
app -> mcp -> mcp/client + mcp/server + Effect
app -> openai -> oauth + Effect
app -> anthropic -> oauth + Effect
app -> oauth + Effect
```

## Naming

- `agent/loop` = pure model/tool loop; messages in, events out.
- `agent` = main package; root stays tiny, feature APIs use subpaths.
- `rag` = knowledge retrieval/indexing core; agents consume it through tool boundaries.
- `mcp` = external MCP protocol package; keep separate from agent core.
- `agent/runtime` = server lifecycle: sessions, persistence, resume/fanout adapters.
- `vercel-workflows-runtime` = Vercel Workflow step-loop contract; app supplies routes/auth/providers/tools.
- `agent/client` = UI-side consumer; never runs the loop in production.
- Avoid `harness` for current packages; reserve for a future batteries-included agent kit if needed.
- Avoid `executor` for loop code; use for future sandbox/tool execution layer if needed.

## Boundaries

- App/server owns auth, prompts, domain context, tool policy, integrations, model choice.
- App/server owns token storage, user/session mapping, provider selection, and product policy.
- Provider packages may own reusable vendor mechanics: request lowering, stream parsing, OAuth token schemas, refresh helpers, and broker clients.
- OAuth packages define contracts only; they never own refresh tokens or storage.
- Runtime may be generic over opaque `Ctx`; it must not interpret product context.
- Vercel Workflow runtime must keep inputs/state plain serializable and avoid app imports.
- Import Vercel Workflow runtime APIs via `@yolk/vercel-workflows-runtime/workflow`; package root is intentionally empty.
- Vercel Workflow model/tool step retries are opt-in; default no retry avoids duplicate streamed chunks unless host/client de-dupe is ready.
- `runVercelAgentWorkflow` returns terminal status; host apps still own persistence/conflict UX.
- Agent-loop must stay stateless: no persistence, sessions, WebSockets/SSE, compaction policy, or app context.
- Tool-registry owns generic tool metadata/scope resolution, not app/domain tools.
- Skillset owns generic skills/commands parsing, rendering, manifests, and merge helpers; no source adapters or runtime policy.
- Client transport should work for Next UI and Chrome extension by consuming protocol events from a server endpoint; app UI may own richer parts state.
- React package owns headless hooks only: no components, styling, auth chrome, or provider-specific UI.
- Voice-runtime may bridge provider tool calls to `ToolExecutor`; provider/WebRTC specifics stay in app/adapters.
- Root dev deps are shared while packages are private; add package-local dev/peer deps during publish prep.

## Reasoning

- `AgentReasoningEffort` is protocol-only request config; app chooses values, agent-loop/provider layers pass through.
- `agent-runtime` threads `reasoningEffort` and `capabilities`; `/api/agent` uses `Transcript`, Cloudflare DO uses `AppendInput`.
- `agent-runtime` supports stateless `Transcript` mode and append-backed `AppendInput` mode via `SessionEventStore`.
- `agent-loop` owns retry/usage aggregation; provider adapters classify retryable failures and normalize raw usage.
- Compaction remains host-owned via `ContextTransformer`; future durable compaction checkpoints belong in runtime/app storage, not loop core.
- `LLMReasoningDelta` is provider-supplied summary text only; never fabricate reasoning.
- `accumulateAssistantMessage` preserves ordered assistant parts: text, reasoning, host tool calls, provider tool calls/results.

## Content + Capabilities

- `Content = string | ContentPart[]`; parts currently `Text`, `Image`, `Audio`.
- Use protocol helpers (`contentText`, `contentPreview`, `contentParts`, `isContentEmpty`, `appendTextToContent`) instead of app-local duplication.
- `AgentModelCapabilities` is protocol-only; app/provider config chooses text-only vs text+image and agent-loop rejects unsupported input before provider calls.
- Provider adapters map protocol content to provider-specific request parts; packages must not import provider SDKs.

## Tool Registry

- Host apps define `ToolModule<Context>` and `ToolRegistration<Context>`.
- `resolveTools(modules, context)` filters enabled tools and rejects duplicate names.
- `makeToolExecutorLayer(toolSet)` adapts resolved tools to `ToolExecutor`.
- Packages support route/runtime-provided tools; app-level AgentDefinition is optional host structure, not a package concern.
- `access: read | write | destructive` is metadata for policy/approvals; enforcement is host-owned.
- Prefer `Effect.forEach` + `Array`/`Option` helpers over mutable loop/push collection code.
- Prefer pure `map`/`flatMap` projections over mutable `push`/`set`/`add` helper accumulators.
- Lock projection refactors with semantic ordering/state tests, not implementation-shape tests.
- Test-local probe mutation (`requests.push`, `saved.push`, counters) is acceptable when it keeps spies clearer than Effect refs.
- Do not import auth, storage, provider SDKs, or product tool catalogs here.

## Skillset

- `@yolk/skillset` is the domain-free core for skills and commands.
- Core owns `SKILL.md` parsing, command markdown parsing, command argument rendering, manifest schemas, and deterministic merge helpers.
- Core must not import filesystem, Next.js, Cloudflare, DB, auth, provider SDKs, `@yolk/agent/tools`, or app code.
- Host apps own source adapters: filesystem, generated bundles, KV/R2, DB, or remote packages.
- Host apps own policy and runtime wiring: available-skills prompt injection, `skill` tool registration, and slash command UI/routes.
- Keep v1 scoped to skills and commands; do not broaden into tools, providers, models, agents, storage, or permissions.

## MCP

- `@yolk/mcp/client` is a domain-free host-executed MCP client; app decides config, auth, and policy.
- `@yolk/mcp/server` is a reusable tool-only MCP server; keep it generic for reuse across projects.
- Supports remote JSON-RPC over HTTP POST with JSON or SSE responses and local stdio servers.
- MCP server v1 supports `initialize`, `tools/list`, and `tools/call`; no resources, prompts, OAuth, or app auth.
- MCP server exposes both newline JSON-RPC (`handleLine`/stdio) and HTTP POST (`handleHttpRequest`) entrypoints.
- Remote MCP depends on `HttpClient`; package tests inject a fake client, app adapters provide `FetchHttpClient.layer`.
- Remote MCP requires `https:` by default; `http://localhost` is policy-gated for dev only.
- Local stdio uses Effect v4 process/stream APIs (`ChildProcess`, `Stdio`, `Stream`) plus `@effect/platform-node`; avoid raw `node:child_process`, `node:readline`, or direct `process.stdin/stdout/stderr`.
- Local stdio is policy-gated, receives explicit env only, sets `extendEnv: false`, and ignores stderr to avoid secret leaks.
- Local stdio must not inject default env; pass only `config.environment ?? {}`.
- MCP client core local helpers require `ChildProcessSpawner`; Node convenience helpers live at `@yolk/mcp/client/node`.
- Local MCP sessions must validate `initialize` response before trusting target request response.
- MCP server stdio runners depend on `Stdio.Stdio`; Node CLI/test fixtures provide `NodeStdio.layer` at the boundary.
- Local stdio responses are matched by JSON-RPC id; do not assume response order.
- JSON encode/decode uses Effect Schema (`UnknownFromJsonString`); avoid raw JSON in production MCP code. Decode wire JSON in two steps: JSON string → unknown → protocol schema.
- MCP server maps parse vs validation separately: JSON parse errors return `-32700`, invalid JSON-RPC/request params return `-32600`.
- MCP server stdio should not write internal errors to stderr; return protocol-shaped JSON-RPC errors when possible.
- Export normal `ToolDef`/`ToolResult`; agent-loop and providers stay MCP-agnostic.
- `listMcpTools` rejects duplicate generated tool names after server/tool sanitization.
- Prefer local/remote-specific helper APIs in tests (`listLocalMcpServerTools`, `callLocalMcpServerTool`, `listRemoteMcpServerTools`, `callRemoteMcpServerTool`) when the config kind is known; use union helpers at app boundaries.
- Test MCP transports below UI level: fake `HttpClient` layers for remote JSON/SSE, fake `ChildProcessSpawner` for core local behavior, and tiny checked-in stdio fixtures for real process behavior.
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

- Agent runtime pages use `@yolk/react` headless chat state; `@yolk/agent/client` owns lower-level protocol transport/state helpers.
- `AgentTranscript` is a non-empty protocol transcript owned by the client/UI.
- `AgentClientState.messages` stores stable protocol messages; `liveMessages` stores completed assistant turns during active runs.
- `text`/`reasoning` are current streaming drafts only; `AssistantMessageEvent` commits a live assistant turn and clears drafts.
- `AgentToolRun` is the single client tool lifecycle object: input streaming/ready, approval requested/denied, executing, completed, errored, provider-completed.
- Keep tool timing/result on `AgentToolRun`; avoid separate arrays that must be rejoined by id.
- Reducers/projections receive `nowMs`; do not call wall-clock APIs inside state reducers.
- `submitAgentUserMessage` appends user messages locally before transport starts.
- `streamAgentEventStream` = Effect `Stream` over NDJSON endpoint.
- `streamAgentRunEventStream` = Effect `Stream` over an existing run NDJSON endpoint for durable replay/resume.
- `cancelAgentRun` = HTTP `DELETE` helper for host-owned run cancellation endpoints.
- `streamAgentEvents` = async generator compatibility wrapper for browser UI.
- `collectAgentEventsEffect` = Effect-native collection helper.
- `collectAgentEvents` = async collection helper.
- Requests send a non-empty client-owned `AgentTranscript` (`messages`), not just the latest prompt.
- Optional `model` and `reasoningEffort` are forwarded to the server; provider support is app-owned.
- `StreamAgentEventsRequest.signal` interrupts Effect `HttpClient` request/body reads.
- Mock client HTTP with `HttpClient` layers, not fetch-style helpers.
- Keep parsing/schema errors typed as `AgentTransportError`.
- Use `Schema.UnknownFromJsonString` for NDJSON/body JSON boundaries.
- React default transport should use `streamAgentEventStream`; async iterable transport is compatibility/injection only.
- React hooks that fork Effect streams must retain and interrupt fibers on stop/unmount.

## React

- `@yolk/react` is the headless React layer for app builders.
- It wraps `@yolk/agent/client` transport and exposes render-ready chat state.
- `chatMessages` is the primary UI model; `messages` is derived protocol replay for transport/debugging.
- `AgentChatState.sessionEvents` records local UI/session edits: submitted/appended messages, turn deletion, regeneration, user edits.
- `editUserMessage` replaces a user message, truncates later messages, and reruns from the edited transcript.
- `AgentChatAction` is the deterministic reducer command surface; keep submit/delete/regenerate behavior pure.
- `useAgentChat` exposes `deleteTurn`, `regenerateFrom`, and `editUserMessage`; regeneration and edit start transport.
- `chat-session-events.ts` defines UI/session edit audit records, distinct from runtime `SessionEventStore` events.
- `AgentChatPart` covers text, reasoning, tool call/result, and error parts; no DOM assumptions.
- `buildAgentChatItems` is a convenience flat projection, not a required UI structure.
- Keep actual components, styling, auth panels, provider controls, and app chrome outside this package.
- Default transport is injectable; host apps can point at any compatible agent endpoint.
- `useAgentChat` owns runtime clock injection via `nowMs`; pure chat reducers stay deterministic.
- App local chat files may re-export this package to keep example tests close to the UI.

## Test Helpers

- `@yolk/agent/loop/testing` exports `FauxProvider`, `Reply`, and `TestToolExecutor` for tests.
- Keep test helpers behind explicit `./testing` subpath exports; do not grow the production root API casually.
- Package exports point to TypeScript source (`src/index.ts`), not `dist`.
- Node-specific package APIs use explicit subpath exports (for example `@yolk/mcp/client/node`) so core imports stay portable.
- Package-internal relative imports use explicit `.ts` extensions, matching Alchemy's source style. `packages/tsconfig.base.json` enables `rewriteRelativeImportExtensions` so future emit rewrites them safely; this also lets Node/Alchemy load source exports directly during deploy-time stack evaluation.
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

## Dist Build Plan

- Keep TypeScript source exports while packages are private and APIs are still moving quickly.
- Before the first public npm release, curate explicit public exports and remove accidental root `export *` surface.
- During release prep, add `tsdown`, emit `dist`, switch package exports to `dist`, add `files`, `publishConfig`, `publint`, READMEs, and peer deps.
- Publish an alpha/canary only after validating install/import behavior from a separate fixture app.
- Add Turbo only if package/app build times, CI orchestration, or affected-only builds become painful; use pnpm recursive scripts until then.

## Package Publishing TODOs

Use this order when preparing the first public alpha/canary release:

1. **Freeze public surface**
   - Keep root exports explicit; do not add broad `export *` barrels.
   - Review every exported symbol as public API.
   - Move test-only helpers behind explicit `./testing` subpaths.

2. **Declare package metadata**
   - Add package `description`, `license`, `repository.directory`, `engines`, and keywords.
   - Add `files` entries for publishable artifacts only.
   - Add package READMEs with install/import examples.

3. **Model host-owned dependencies**
   - Add peer deps for runtime singletons and host frameworks: `effect`, `react`, and platform/runtime deps where relevant.
   - Keep dev deps pinned via catalogs for local package tests/builds.
   - Keep internal `@yolk/*` deps as `workspace:^`.

4. **Add dist build**
   - Add `tsdown` per package once publishing is imminent.
   - Emit ESM + `.d.ts` into `dist`.
   - Switch package `exports` from `src/index.ts` to `dist` outputs.
   - Keep local dev source exports only if using an Effect-style `publishConfig.exports` override.

5. **Add release tooling**
   - Add Changesets with a fixed/lockstep group for all public `@yolk/*` packages.
   - Set `updateInternalDependencies: "patch"`.
   - Add root scripts for package build, package validation, versioning, and publish dry-run.

6. **Validate package artifacts**
   - Add `publint` or equivalent export/package checks.
   - Run `pnpm packages:check`, `pnpm tsc`, `pnpm lint`, and `pnpm test:run`.
   - Run a local `pnpm pack`/install smoke test in a separate fixture app.

7. **Publish alpha/canary**
   - Remove `private: true` only after artifact validation passes.
   - Publish with provenance if available.
   - Treat the first alpha as API feedback, not stability commitment.

## Reference Repo Gap TODOs

Use these before broadening package scope:

1. **Add protocol conformance tests**
   - Initial coverage added in `packages/agent/test/protocol/wire.test.ts`.
   - Continue covering new message/event/tool/usage variants as they are added.
   - Cover schema round-trips and invalid wire payloads.
   - Keep tests semantic and provider-agnostic.

2. **Improve MCP result fidelity**
   - Architecture: preserve agent-readable `ToolResult.content` plus generic `ToolResult.structuredContent`.
   - Do not leak MCP-specific result types into protocol unless UI/runtime needs typed artifacts.
   - MCP client preserves `structuredContent`, `isError`, and text/image/audio/resource/resource_link content for model self-correction and UI state.
   - MCP server preserves protocol text/image/audio content, `structuredContent`, and `isError` when serving tool results.

3. **Design durable runtime append store**
   - PRD tracked in `.opencode/state/durable-runtime-append-store/prd.md`; initial `SessionEventStore` contract exists.
   - `AppendInput` runtime mode records input, run start, completion, and failure.
   - `appendRuntimeSessionEventsToLog` centralizes append-log revision/id generation for package and host stores.
   - `latestIncompleteRuntimeRun` lets host adapters mark stale active runs interrupted on reconnect/cleanup.
   - Cloudflare tests cover multiple persisted turns, event log contents, and reconnect interruption.
   - Runtime README documents `Transcript` vs `AppendInput` and host-owned storage responsibilities.

4. **Rich tool lifecycle events**
   - Implemented in protocol/client/react/agent-loop; PRD tracked in `.opencode/state/tool-lifecycle-events/prd.md`.
   - Provider adapters can emit `LLMToolInputStart`/`LLMToolInputDelta` and `LLMProviderToolResult` for hosted tools.
   - Packages model approval events only; host apps still own policy/enforcement.

5. **Assess reusable provider adapter package**
   - Avoid moving app providers prematurely.
   - Extract only stable OpenAI/Codex request lowering, streaming parse, and provider quirks.

6. **Plan product/session UX layer separately**
   - Keep packages headless.
   - App layer owns persisted drafts, threads, model picker, attachment recovery, virtualization, and command palette.

7. **Freeze package API before publish prep**
   - Decide root vs subpath exports.
   - Add READMEs, metadata, dist builds, and artifact validation after API review.
