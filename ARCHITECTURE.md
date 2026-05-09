# Yolk — Package Architecture

Reusable agent stack. Domain-free below the app layer.

## Packages

```
packages/
  protocol/       shared schemas, events, wire types
  harness/        pure LLM <> tool loop
  agent-runtime/  reusable session/runtime shell
  client/         browser/client SDK
app/              Yolk product layer at repo root
```

## Dependency rule

```txt
app ───────────────▶ agent-runtime ─▶ harness ─▶ protocol
 │                         ▲
 └──────────────▶ client ──┘
```

- `protocol` imports nothing from Yolk packages.
- `harness` depends only on `protocol` + Effect.
- `agent-runtime` depends on `harness` + `protocol`.
- `client` depends on `protocol` only by default.
- `app` owns all product/domain assumptions.

No users, teams, orgs, projects, billing, or product-specific permissions below `app`.

---

## `@yolk/protocol`

Shared contract.

Owns:
- `AgentMessage`
- `ContentPart`
- `ToolCall`
- `ToolResult`
- `AgentEvent`
- wire envelopes
- serializable errors
- session/run identifiers

Does not own:
- persistence
- transport implementation
- domain metadata
- React state

Keep it boring. Stable schemas beat clever abstractions.

---

## `@yolk/harness`

Pure loop mechanics.

Conceptual API:

```typescript
const run = (config: {
  messages: ReadonlyArray<AgentMessage>
  systemPrompt: string
  tools: ReadonlyArray<ToolDef>
  model: string
}): Stream<AgentEvent, HarnessError, LLMProvider | ToolExecutor | ContextTransformer | LoopConfig>
```

Owns:
- LLM <> tool turn loop
- provider interface
- tool executor interface
- context transformer interface
- event emission
- response accumulation
- cancellation via Effect interruption
- max-turn safety
- faux provider test layer

Does not own:
- sessions
- persistence
- WebSocket/SSE
- auth
- app context
- compaction policy
- tool permissions policy
- knowledge stores
- integration credentials

Rule: if it needs durable state or project context, it is not harness.

---

## `@yolk/agent-runtime`

Reusable orchestration shell around the harness.

Generic over project context:

```typescript
type RuntimeRequest<Ctx> = {
  readonly sessionId: string
  readonly input: AgentMessage
  readonly context: Ctx
}
```

`Ctx` is opaque. Runtime passes it to adapters but never interprets it.

Owns:
- session load/save orchestration
- transcript reducer
- resumable runs
- event fanout
- usage aggregation
- generic compaction hook
- generic context provider hook
- generic tool resolver hook
- generic permission hook
- platform adapters (Cloudflare DO, Node later)

Does not own:
- meaning of `Ctx`
- user/team/org/project concepts
- domain permissions
- billing policy
- product-specific tool definitions
- product-specific context injection

Adapter sketch:

```typescript
createAgentRuntime<Ctx>({
  sessionStore,
  llmProvider,
  toolResolver,
  contextProvider,
  permissionPolicy,
  compactionStrategy,
})
```

Interfaces stay domain-free:

```typescript
interface ToolResolver<Ctx> {
  resolve(input: { context: Ctx; session: SessionSnapshot }): Effect<ReadonlyArray<ToolDef>>
}

interface ContextProvider<Ctx> {
  build(input: { context: Ctx; session: SessionSnapshot }): Effect<ReadonlyArray<AgentMessage>>
}

interface CompactionStrategy<Ctx> {
  compact(input: { context: Ctx; session: SessionSnapshot }): Effect<CompactionResult>
}
```

The runtime can provide defaults: no compaction, no extra context, no extra tools, in-memory session store.

---

## `@yolk/client`

Browser/client protocol SDK.

Owns:
- connect to runtime transport
- send user messages
- receive `AgentEvent`s
- reduce events into local UI state
- optimistic pending state
- reconnect/resume helpers
- framework-neutral client
- optional React hooks package later

Does not own:
- harness execution in normal production
- LLM providers
- server persistence
- auth semantics
- domain state

Default assumption: browser uses shared protocol and talks to runtime. It does not run the harness loop.

---

## `app`

Project-specific product layer.

Owns:
- auth
- users
- teams
- orgs
- projects
- billing
- integration OAuth
- credential storage
- knowledge stores
- product-specific tools
- product-specific context
- UI
- deployment choices

It adapts domain state into runtime `Ctx`.

Example:

```typescript
type AppContext = {
  readonly actorId: string
  readonly workspaceId: string
  readonly requestId: string
}
```

The runtime should not know what those fields mean.

---

## Request flow

```txt
Browser
  @yolk/client sends message
    ↓
App route / Worker / DO
  auth + domain lookup
  builds opaque AppContext
    ↓
@yolk/agent-runtime
  loads session
  gets context/tools via adapters
  runs harness
  saves transcript + usage
  streams events
    ↓
@yolk/harness
  loops LLM <> tools
```

---

## Why this split

- Reusable across projects.
- Harness remains small and testable.
- Runtime solves common session/transport/persistence problems once.
- Product assumptions stay out of shared packages.
- Browser and server share protocol without sharing execution concerns.

Short version:

| Layer | Responsibility |
|---|---|
| Protocol | Shared language |
| Harness | Loop mechanism |
| Agent runtime | Generic session orchestration |
| Client | Browser transport + state |
| App | Domain policy |
