# Agent Loop — Design Document

## What it is

Generic, portable agent loop. `packages/agent/src/loop/`. Orchestrates LLM <> tool cycles. Pure Effect. No Cloudflare, no Yolk domain logic. Don't publish until second consumer exists.

Terminology note: planning used “harness” as shorthand. Package name is `@yolk-sdk/agent/loop` because industry usage increasingly reserves “harness” for opinionated, batteries-included agent layers.

**Conceptual signature:**

```typescript
const run = (config: {
  messages: ReadonlyArray<AgentMessage>
  systemPrompt: string
  tools: ReadonlyArray<ToolDef>
}): Stream<AgentEvent, AgentLoopError, LLMProvider | ToolExecutor | ContextTransformer | LoopConfig>
```

Config in, event stream out. Consumer owns session persistence, transport (WebSocket, stdio, etc.), and UI. System prompt is a plain field — static for the duration of a run. Dynamic per-turn instructions go through `ContextTransformer`.

This package is one layer in the reusable stack. See `patterns/PACKAGE_ARCHITECTURE.md`.

```txt
protocol → agent-loop → agent-runtime → app
```

The agent loop is **not** the runtime. It does not load sessions, persist transcripts, expose WebSockets, compact context, or understand any project domain. Those live in `packages/agent/src/runtime/` or the app layer.

Hard boundary: no users, teams, orgs, projects, billing, OAuth, knowledge store, or product-specific permissions in this package.

### Agent loop vs agent runtime

| Concern                 | Agent loop     | Agent runtime            |
| ----------------------- | -------------- | ------------------------ |
| LLM <> tool loop        | Yes            | Calls agent loop         |
| Event taxonomy          | Emits          | Streams/reduces/persists |
| Provider interface      | Defines        | Provides/configures      |
| Tool executor interface | Defines        | Wraps with permissions   |
| Sessions                | No             | Yes, generic             |
| Persistence             | No             | Via `SessionStore`       |
| Transport               | No             | WS/SSE/RPC adapters      |
| Compaction              | No policy      | Strategy interface       |
| Context injection       | Interface only | Adapter orchestration    |
| Domain concepts         | Never          | Opaque `Ctx` only        |

---

## Inspirations

Two reference implementations studied in depth.

### Pi (`~/dev/docs/pi-mono`)

Minimal terminal coding agent by Mario Zechner. Plain TypeScript, Vitest, event-driven.

**Patterns we take:**

- `AgentMessage` vs `LLMMessage` separation — agent messages include non-LLM types (notifications, compaction summaries). `convertToLlm()` bridges the gap.
- Faux provider with scripted response queues — deterministic, offline, no HTTP.
- In-memory variants for all stateful components (`SessionManager.inMemory()`, `AuthStorage.inMemory()`).
- Well-defined event sequence: `agent_start -> turn_start -> message_start -> message_update* -> message_end -> tool_start -> tool_end -> turn_end -> agent_end`.
- Tool interception points (before/after/block).

**Patterns we skip:**

- Extension system (25+ hooks, plugin loading, hot-reload) — we own the code.
- TypeBox for schemas — Effect Schema instead.
- TUI, RPC mode, session tree — not agent-loop concerns.

### OpenCode (`~/dev/docs/opencode`)

Open-source coding agent. Effect v4 throughout. Bun runtime.

**Patterns we take:**

- `Context.Service` + `Layer` for all services with `defaultLayer` export.
- `BusEvent.define()` with Effect `Schema` for typed events.
- `Runner` state machine pattern (`SynchronizedRef`, `Deferred`, `Fiber`) for concurrent work coordination.
- `TestLLMServer` concept — queue-based fake LLM responses. But as a Layer, not an HTTP server.
- `testEffect()` helper bridging Effect to test runner.
- Scoped resource management (`Effect.addFinalizer`, `Scope`).
- `Data.TaggedError` for all error types. No try/catch.

**Patterns we skip:**

- `InstanceState` / `InstanceRef` / AsyncLocalStorage dual context — agent-loop is single-run. Consumer (runtime/DO) handles multi-tenancy.
- `AppRuntime` / `ManagedRuntime` — agent-loop is a library, not an app. Consumer provides the runtime.
- AI SDK interop / Zod bridging — agent-loop defines its own provider interface.
- SQLite / Drizzle — agent-loop is stateless. Consumer owns persistence.

---

## Core Design Decisions

### 1. Agent loop: Hybrid (imperative guts, Stream skin)

**Status: Decided.**

Three options evaluated:

**A) Pure Stream composition** — Agent loop as recursive `Stream.unfoldEffect`.

```typescript
const runTurn = (msgs: AgentMessage[]): Stream<AgentEvent, AgentLoopError, Requirements> =>
  pipe(
    Stream.make(AgentEvent.TurnStart()),
    Stream.concat(streamLLM(msgs)),
    Stream.concat(
      Stream.fromEffect(collectToolCalls).pipe(
        Stream.flatMap(calls =>
          calls.length === 0
            ? Stream.make(AgentEvent.TurnEnd('stop'))
            : pipe(
                executeTools(calls),
                Stream.concat(Stream.suspend(() => runTurn([...msgs, ...results])))
              )
        )
      )
    )
  )
```

Problem: Recursive stream composition gets unreadable fast. `collectToolCalls` needs state accumulated from `streamLLM`, but they're separate stream segments. Threading state requires `Ref` or restructuring. Not worth the elegance.

**B) Fiber + PubSub** — Long-running fiber pushes to `PubSub.unbounded<AgentEvent>()`.

Problem: No backpressure. Multiple consumers must subscribe before fiber starts or miss events. Return type awkward (you're returning the bus, not the result). Race condition-prone.

**C) Hybrid** — Imperative `Effect.gen` loop inside `Stream.asyncScoped`. **Winner.**

```typescript
const run = (
  msgs: AgentMessage[]
): Stream<AgentEvent, AgentLoopError, LLMProvider | ToolExecutor> =>
  Stream.asyncScoped(emit =>
    Effect.gen(function* () {
      const provider = yield* LLMProvider
      const executor = yield* ToolExecutor
      let current = msgs

      yield* emit.single(AgentEvent.AgentStart())

      while (true) {
        yield* emit.single(AgentEvent.TurnStart())

        // Stream LLM response, emit tokens as they arrive, accumulate
        const response = yield* provider.stream(toLLM(current)).pipe(
          Stream.tap(e => emit.single(toAgentEvent(e))),
          Stream.runFold(Accumulator.empty, Accumulator.add)
        )

        if (response.toolCalls.length === 0) {
          yield* emit.single(AgentEvent.TurnEnd('stop'))
          break
        }

        // Parallel tool execution with per-tool events
        const results = yield* Effect.forEach(
          response.toolCalls,
          tc =>
            pipe(
              emit.single(AgentEvent.ToolStart(tc)),
              Effect.andThen(() => executor.execute(tc)),
              Effect.tap(r => emit.single(AgentEvent.ToolEnd(tc, r)))
            ),
          { concurrency: 'unbounded' }
        )

        current = [...current, response.message, ...results]
        yield* emit.single(AgentEvent.TurnEnd('tool_use'))
      }

      yield* emit.single(AgentEvent.AgentEnd())
    })
  )
```

**Why Hybrid wins:**

| Property       | Hybrid delivers                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Readability    | Plain `while(true)` in `Effect.gen`. Anyone who's read Pi's loop recognizes the shape.                                             |
| Composability  | Consumer gets `Stream<AgentEvent>`. `Stream.tap`, `Stream.takeUntil`, `Stream.runCollect`.                                         |
| Cancellation   | Interrupt consuming fiber -> interrupts `asyncScoped` producer -> interrupts in-flight LLM/tools. Free via structured concurrency. |
| Backpressure   | `Stream.asyncScoped` respects consumer pace. Slow WebSocket? Producer waits.                                                       |
| Scoped cleanup | `asyncScoped` ties producer to `Scope`. Stream ends or interrupts -> finalizers run.                                               |
| Testing        | Stream is just data: `Stream.runCollect` -> assert on events.                                                                      |

**The one concern:** `Stream.asyncScoped` uses an internal queue. Producer buffering if faster than consumer. Non-issue for agent loops — LLM tokens are slow, tool results are bursty but bounded.

**Consumer usage patterns:**

```typescript
// Pipe to WebSocket (DO)
run(msgs).pipe(
  Stream.tap(e => ws.send(JSON.stringify(e))),
  Stream.runDrain
)

// Collect for testing
const events = yield * run(msgs).pipe(Stream.runCollect)

// Cancel after first turn
run(msgs).pipe(
  Stream.takeUntil(e => e._tag === 'TurnEnd'),
  Stream.runCollect
)
```

---

### 2. Message model: AgentMessage vs LLMMessage

**Status: Decided. Closed union, LLM-level types only.**

Studied both Pi (open union via declaration merging on `CustomAgentMessages`) and OpenCode (closed union, 2 roles, richness in 12 part types). Key finding from both: **the loop doesn't need to understand custom types.** It only cares about: can I send this to the LLM? Did the LLM return tool calls? What are the tool results?

Pi's loop stores and forwards `AgentMessage[]` without inspecting roles beyond `"assistant"` with `toolCalls`. OpenCode's loop only inspects parts for tool state. Everything else passes through opaquely or lives in a separate layer.

**Decision:** Harness defines a closed union of types it needs for the loop. Consumer converts domain types to core types before calling `run()`.

```typescript
const ContentPart = Schema.Union(
  Schema.TaggedStruct('Text', { text: Schema.String }),
  Schema.TaggedStruct('Image', { data: Schema.String, mimeType: Schema.String }),
  Schema.TaggedStruct('Document', {
    data: Schema.String,
    mimeType: Schema.String,
    filename: Schema.String
  }),
  Schema.TaggedStruct('Audio', { data: Schema.String, format: AudioFormat })
)

type AudioFormat = 'pcm16' | 'wav' | 'mp3' | 'opus'

const Content = Schema.Union(Schema.String, Schema.Array(ContentPart))

const AgentMessage = Schema.Union(
  Schema.TaggedStruct('User', { content: Content }),
  Schema.TaggedStruct('Assistant', { content: Content, toolCalls: Schema.Array(ToolCall) }),
  Schema.TaggedStruct('ToolResult', { toolCallId: Schema.String, content: Content })
)
```

Three message types, multimodal content from day one. `Content` is either a plain string (shorthand for text-only) or an array of `ContentPart` (text, image, document, audio mixed). Voice support requires no message model changes later.

No `Notification`, `CompactionSummary`, `ContextInjection` — those are consumer concerns:

- Compaction summaries → consumer wraps as `User` messages before calling `run()`
- Context injections → happen in `ContextTransformer.transform()`, which prepends real `User` messages
- Notifications → UI-level, never enter the agent loop

`toLLMMessages` is agent-loop-internal, trivial — almost 1:1 mapping with minor format differences per provider (handled in `LLMProvider` layer, not in the conversion). Provider layer decides how to encode audio parts for the specific API (base64 for audio completions, PCM16 chunks for realtime).

Consumer's domain types (e.g., `KnowledgeResult`, `IntegrationEvent`) live in their session storage and UI layer. They convert to `AgentMessage` at the boundary before entering the agent loop.

---

### 3. Tool execution model

**Status: Decided.**

Tools execute in parallel by default (`concurrency: "unbounded"`). Interception via layer composition, not hooks.

#### Tool definition

Four required fields, one optional. Studied Pi (TypeBox schemas, `parallel` flag, `label`) and OpenCode (Effect Schema, `id`, confirmation metadata). The agent loop only needs fields that affect loop behavior. Display labels, confirmation, concurrency hints → consumer layers.

```typescript
interface ToolDef<Params, R> {
  readonly name: string
  readonly description: string
  readonly parameters: Schema.Schema<Params>
  readonly execute: (params: Params) => Effect<ToolResult, ToolError, R>
  readonly timeout?: Duration // agent loop wraps with Effect.timeout if provided
}
```

- `name` + `description` + `parameters` → sent to LLM as tool definitions
- `execute` → called by agent loop
- `timeout` → defense against runaway tools blocking the loop. Harness owns the execution fiber.
- Everything else (labels, confirmation, concurrency hints) → consumer layers

#### Interception via ToolExecutor layer

```typescript
// Service interface
class ToolExecutor extends Context.Service<ToolExecutor>()('@yolk-sdk/agent/loop/ToolExecutor') {
  readonly execute: (call: ToolCall) => Effect<ToolResult, ToolError>
}

// Default layer — just runs the tool
const DefaultLayer = Layer.succeed(ToolExecutor, {
  execute: call =>
    pipe(
      resolveAndValidate(call),
      Effect.flatMap(tool => tool.execute(call.params))
    )
})

// Permission-checking layer — wraps default
const PermissionLayer = Layer.effect(
  ToolExecutor,
  Effect.gen(function* () {
    const inner = yield* ToolExecutor // get the layer below
    const permissions = yield* Permissions
    return ToolExecutor.of({
      execute: call =>
        pipe(
          permissions.check(call),
          Effect.flatMap(() => inner.execute(call))
        )
    })
  })
)

// Logging layer — wraps whatever is below
const LoggingLayer = Layer.effect(
  ToolExecutor,
  Effect.gen(function* () {
    const inner = yield* ToolExecutor
    return ToolExecutor.of({
      execute: call =>
        pipe(
          Effect.log(`tool:start ${call.name}`),
          Effect.flatMap(() => inner.execute(call)),
          Effect.tap(() => Effect.log(`tool:end ${call.name}`))
        )
    })
  })
)
```

Consumer composes layers: `LoggingLayer.pipe(Layer.provide(PermissionLayer), Layer.provide(DefaultLayer))`.

**No hook registry. Effect's Layer system IS the extension system.**

#### Per-file mutation serialization

Pi pattern: serialize writes to the same file. In Effect, a `Semaphore` per path:

```typescript
const fileLocks = yield * Ref.make(new Map<string, Semaphore>())

const withFileLock = (path: string, effect: Effect<A, E, R>) =>
  pipe(
    Ref.get(fileLocks),
    Effect.flatMap(locks => {
      const lock = locks.get(path) ?? yield * Semaphore.make(1)
      // ... update map, acquire lock, run effect
    })
  )
```

---

### 4. Provider abstraction

**Status: Decided.**

Minimal interface. Harness doesn't know about Anthropic, OpenAI, etc. Consumer provides the layer.

```typescript
class LLMProvider extends Context.Service<LLMProvider>()('@yolk-sdk/agent/loop/LLMProvider') {
  readonly stream: (request: LLMRequest) => Stream<LLMEvent, LLMError>
}
```

`LLMRequest`:

```typescript
interface LLMRequest {
  readonly messages: ReadonlyArray<LLMMessage>
  readonly tools: ReadonlyArray<LLMToolDef>
  readonly model: string
  readonly maxTokens: number
  readonly systemPrompt: string
}
```

`LLMEvent` (discriminated union, multimodal):

```typescript
type LLMEvent =
  // Text
  | { readonly _tag: 'TextDelta'; readonly text: string }
  | { readonly _tag: 'ThinkingDelta'; readonly text: string }
  // Audio
  | { readonly _tag: 'AudioDelta'; readonly data: string } // base64 audio chunk
  | { readonly _tag: 'AudioDone' }
  | { readonly _tag: 'OutputTranscript'; readonly text: string } // transcript of model's audio
  // Tool calls
  | { readonly _tag: 'ToolCallStart'; readonly id: string; readonly name: string }
  | { readonly _tag: 'ToolCallDelta'; readonly id: string; readonly args: string }
  | { readonly _tag: 'ToolCallEnd'; readonly id: string }
  // Meta
  | { readonly _tag: 'Usage'; readonly input: number; readonly output: number }
  | { readonly _tag: 'Done'; readonly stopReason: StopReason }
```

Audio events are emitted by providers that support audio output (OpenAI audio completions, future Anthropic audio). Text-only providers never emit `AudioDelta`/`AudioDone`. The agent loop passes them through — it doesn't interpret audio data.

The agent loop accumulates `LLMEvent`s into a complete response (assistant message + tool calls) via `Accumulator.add`. Provider implementations live outside the agent-loop package.

---

### 5. Testing: Faux Layer, not HTTP server

**Status: Decided.**

OpenCode's `TestLLMServer` spins up real HTTP. Thorough but heavy. Pi's faux provider registers into a registry. Lighter but imperative.

Harness approach: **Faux as an `LLMProvider` Layer.** Tests swap the provider layer. No HTTP. No network. No registry. Just Effect.

```typescript
// Faux provider backed by a response queue
const FauxProvider = {
  layer: (...responses: FauxResponse[]): Layer<LLMProvider> =>
    Layer.effect(
      LLMProvider,
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<FauxResponse>()
        yield* Queue.offerAll(queue, responses)

        return LLMProvider.of({
          stream: _request =>
            Stream.fromEffect(Queue.take(queue)).pipe(
              Stream.flatMap(response => response.toStream())
            )
        })
      })
    )
}
```

**Response builders** (inspired by Pi's `fauxText`, `fauxToolCall`, OpenCode's `Reply.text().tool()`):

```typescript
const Reply = {
  text: (content: string): FauxResponse => ({
    toStream: () =>
      pipe(
        Stream.fromIterable(content.split("")),
        Stream.map((char) => LLMEvent.TextDelta({ text: char })),
        Stream.concat(Stream.make(LLMEvent.Done({ stopReason: "end_turn" }))),
      ),
  }),

  toolCall: (name: string, args: Record<string, unknown>): FauxResponse => ({
    toStream: () =>
      Stream.make(
        LLMEvent.ToolCallStart({ id: generateId(), name }),
        LLMEvent.ToolCallDelta({ id, args: JSON.stringify(args) }),
        LLMEvent.ToolCallEnd({ id }),
        LLMEvent.Done({ stopReason: "tool_use" }),
      ),
  }),

  // Compose multiple in one response
  message: (...parts: FauxPart[]): FauxResponse => ...
}
```

**Test usage:**

```typescript
const events =
  yield *
  run(msgs).pipe(
    Stream.runCollect,
    Effect.provide(
      FauxProvider.layer(
        Reply.text('Let me check that.'),
        Reply.toolCall('bash', { command: 'ls' }),
        Reply.text('Done. Found 3 files.')
      )
    ),
    Effect.provide(ToolExecutor.test) // tools that return canned results
  )

expect(events).toContainEqual(AgentEvent.TurnEnd({ reason: 'stop' }))
```

**Properties:**

- Deterministic. No network. No timing. No flake.
- Queue wraps around (like Pi) or errors on exhaustion — TBD.
- Supports `FauxResponseFactory` for dynamic responses based on request content.
- Token-by-token streaming simulation for testing consumer rendering.

---

### 6. Context transformation: Layer, not hook

**Status: Decided.**

Pi injects context via `before_agent_start` and `context` hooks. OpenCode has various injection points.

Harness: `ContextTransformer` service. Consumer provides the layer. Harness calls it before each LLM request.

```typescript
class ContextTransformer extends Context.Service<ContextTransformer>()(
  '@yolk-sdk/agent/loop/ContextTransformer'
) {
  readonly transform: (messages: ReadonlyArray<AgentMessage>) => Effect<ReadonlyArray<AgentMessage>>
}

// Default: identity
const DefaultLayer = Layer.succeed(ContextTransformer, {
  transform: msgs => Effect.succeed(msgs)
})
```

Consumer composes transformers:

```typescript
// Inject org knowledge before each LLM call
const KnowledgeLayer = Layer.succeed(ContextTransformer, {
  transform: msgs =>
    Effect.gen(function* () {
      const knowledge = yield* loadOrgContext()
      return [AgentMessage.User({ content: knowledge }), ...msgs]
    })
})
```

Multiple transformers compose via layer wrapping (same pattern as ToolExecutor interception).

---

### 7. Compaction: consumer concern

**Status: Decided. Not in the agent loop.**

Studied both Pi (compaction outside loop, `AgentSession` orchestrates) and OpenCode (compaction inside loop as first-class task). Key finding: **compaction requires an LLM call** — it's "summarize old messages," not "drop old messages." That makes it inherently opinionated (what to keep, how to summarize, which model to use). That opinion belongs in the consumer.

Pi's architecture validates this: the agent loop (`agent-loop.ts`) has zero compaction awareness. `AgentSession` — a layer above — handles detection, summarization, and retry.

The agent loop:

1. Surfaces `LLMError({ cause: "context_overflow" })` in the stream error channel
2. Emits `UsageReport` events with real token counts after each LLM step
3. Done

The consumer:

1. Watches `UsageReport` to proactively compact before overflow (Pi uses threshold: `contextTokens > contextWindow - reserveTokens`)
2. Catches `context_overflow` as last resort
3. Runs their own compaction (separate LLM call, structured summary, domain-specific strategy)
4. Re-calls `run()` with compacted messages

No `CompactionStrategy` service. No retry logic in the loop. Clean boundary.

---

### 8. Session persistence: consumer concern

**Status: Decided.**

Harness is stateless. It takes messages, produces events. Consumer decides how to persist.

The agent loop DOES emit enough events to reconstruct the final message list:

- `AgentEvent.AssistantMessage` contains the full accumulated assistant message.
- `AgentEvent.ToolResult` contains each tool result.
- Consumer appends these to their stored messages.

No `SessionStorage` service in the agent loop. No opinion on JSONL vs SQLite vs in-memory.

---

### 9. Error taxonomy

**Status: Decided.**

All errors as `Data.TaggedError`. Exhaustive. No `unknown` unless immediately re-tagged.

```typescript
class LLMError extends Data.TaggedError('LLMError')<{
  readonly cause: 'provider_error' | 'rate_limit' | 'context_overflow' | 'invalid_response'
  readonly message: string
  readonly retryable: boolean
}> {}

class ToolError extends Data.TaggedError('ToolError')<{
  readonly tool: string
  readonly message: string
  readonly cause: 'validation' | 'execution' | 'timeout' | 'permission'
}> {}

class AbortError extends Data.TaggedError('AbortError')<{
  readonly reason: 'user' | 'system' | 'max_turns'
}> {}

class SchemaError extends Data.TaggedError('SchemaError')<{
  readonly context: 'message' | 'tool_params' | 'llm_response'
  readonly message: string
}> {}

type AgentLoopError = LLMError | ToolError | AbortError | SchemaError
```

The stream type is `Stream<AgentEvent, AgentLoopError, Requirements>`. Consumer handles errors via `Stream.catchTag` or `Effect.catchTag` on the drain.

---

### 10. Event taxonomy

**Status: Decided.**

Discriminated union. Effect Schema for serialization (WebSocket, logging, replay).

```typescript
type AgentEvent =
  // Lifecycle
  | AgentStart
  | AgentEnd // carries final messages, turn count, usage
  | TurnStart
  | TurnEnd
  // LLM streaming — text
  | LLMStreamStart
  | LLMTextDelta
  | LLMThinkingDelta
  | LLMToolCallStart
  | LLMToolCallDelta
  | LLMToolCallEnd
  | LLMStreamEnd
  // LLM streaming — audio
  | LLMAudioDelta // audio chunk from provider
  | LLMAudioDone
  | LLMOutputTranscript // text transcript of model's audio output
  // Tool execution
  | ToolExecutionStart
  | ToolExecutionUpdate // progress from long-running tools
  | ToolExecutionEnd
  // Persistence helpers
  | AssistantMessage // full accumulated message (for persistence)
  | ToolResult // full tool result (for persistence)
  | UsageReport // token counts
  // Realtime session (v1.1, only emitted by RealtimeSession)
  | SessionCreated
  | SessionClosed
  | UserSpeechStarted // VAD detected speech
  | UserSpeechStopped
  | InputTranscript // STT transcript of user's audio
  | ResponseInterrupted // user interrupted model mid-speech
```

Text mode emits lifecycle + text + tool + persistence events. Audio completions add `LLMAudioDelta`/`LLMAudioDone`/`LLMOutputTranscript`. Realtime session adds session lifecycle + speech events. Consumer handles what they need — text-only consumers ignore audio events.

Sequence per turn (text mode):

```
TurnStart
  -> LLMStreamStart
    -> (LLMTextDelta | LLMThinkingDelta | LLMToolCallStart | LLMToolCallDelta | LLMToolCallEnd)*
  -> LLMStreamEnd
  -> AssistantMessage
  -> [if tool calls:]
    -> (ToolExecutionStart -> ToolExecutionUpdate* -> ToolExecutionEnd -> ToolResult)*
  -> UsageReport
TurnEnd
```

Sequence per turn (audio completions):

```
TurnStart
  -> LLMStreamStart
    -> (LLMTextDelta | LLMAudioDelta | LLMOutputTranscript | LLMToolCallStart | ...)*
  -> LLMAudioDone
  -> LLMStreamEnd
  -> AssistantMessage
  -> [if tool calls:]
    -> (ToolExecutionStart -> ... -> ToolResult)*
  -> UsageReport
TurnEnd
```

Wrapped by `AgentStart` / `AgentEnd` for the full run.

---

### 11. Extensibility model: Layers all the way down

**Status: Decided.**

No hook registry. No event system for extensibility. Effect's Layer system IS the extension system.

| Extension point              | Service               | Default                             |
| ---------------------------- | --------------------- | ----------------------------------- |
| Swap LLM provider            | `LLMProvider`         | None (consumer must provide)        |
| Intercept tool execution     | `ToolExecutor`        | Direct execution                    |
| Transform context before LLM | `ContextTransformer`  | Identity                            |
| Control max turns            | `LoopConfig`          | `{ maxTurns: 500 }`                 |
| Custom accumulator           | `ResponseAccumulator` | Default token accumulation          |
| Speech-to-text               | `STTProvider`         | None (optional, chained voice only) |
| Text-to-speech               | `TTSProvider`         | None (optional, chained voice only) |
| Native realtime              | `RealtimeProvider`    | None (optional, v1.1)               |

Consumer composes:

```typescript
const myLayers = pipe(
  AnthropicProvider.layer({ model: 'claude-sonnet-4-20250514' }),
  Layer.provideMerge(PermissionCheckingExecutor.layer),
  Layer.provideMerge(KnowledgeInjectionTransformer.layer),
  Layer.provideMerge(LoopConfig.layer({ maxTurns: 10 }))
)

const events = yield * run(messages).pipe(Stream.runCollect, Effect.provide(myLayers))
```

---

### 12. Hooks: deferred, but seams preserved

**Status: Decided. Not implemented. Architecture supports future addition.**

The agent loop has no hook registry or event-based extension system. Effect's Layer system handles all current interception needs. However, the loop preserves explicit seams where hooks would attach if ever needed:

| Loop call site                                         | Current layer         | Future hook                          |
| ------------------------------------------------------ | --------------------- | ------------------------------------ |
| `yield* executor.execute(call)`                        | `ToolExecutor`        | `beforeToolCall` / `afterToolCall`   |
| `yield* transformer.transform(msgs)`                   | `ContextTransformer`  | `beforeLLMCall`                      |
| `yield* emit.single(AgentEvent.AssistantMessage(...))` | Consumer reads stream | `afterLLMResponse`                   |
| `yield* provider.stream(request)`                      | `LLMProvider`         | `beforeLLMStream` / `afterLLMStream` |

**Invariant: the loop must always call through these services, never bypass them.** These are the hook attachment points. If a future `Hooks` convenience service is added, it wraps these existing layers — no loop changes needed.

A `Hooks` service would look like:

```typescript
// Future (not implemented)
Hooks.layer({
  beforeToolCall: (call) => ...,
  afterToolCall: (call, result) => ...,
  beforeLLMCall: (msgs) => ...,
})
// Internally wraps ToolExecutor + ContextTransformer layers
```

Multiple independent handlers (fan-out) would require a `PubSub`-based hook registry. Only needed if third-party extensibility becomes a requirement. Currently rejected — Yolk owns the code.

---

### 13. Abort: fiber interruption, no explicit handle

**Status: Decided.**

Consumer interrupts the fiber running `Stream.runDrain`. Effect structured concurrency propagates into the `asyncScoped` producer.

```typescript
// Consumer
const fiber = yield * run(msgs).pipe(Stream.runDrain, Effect.fork)
// ... user cancels via WebSocket
yield * Fiber.interrupt(fiber)
```

What happens on interrupt:

- **In-flight LLM stream** — provider's `Stream` gets interrupted. Provider layer's responsibility to close the HTTP connection cleanly.
- **In-flight tool execution** — `Effect.forEach` with `concurrency: "unbounded"` interrupts all child fibers. Each tool's `Effect` gets interrupted. Tool layer's responsibility to clean up (kill subprocesses, etc.).
- **Between turns** — interruption at next `yield*` point. Clean.
- **Partial events** — consumer may receive `TurnStart` without `TurnEnd`. Consumer handles incomplete sequences regardless of abort mechanism.

No explicit `abort()` handle. No `Deferred` signal. `run()` returns a `Stream`, period. Pi and OpenCode have explicit abort (`session.abort()`, `Runner.cancel()`) because their loops are long-lived fibers managed by a session layer. Our agent loop is stateless — each `run()` is a fresh stream, consumer owns the fiber.

For graceful stops (finish current turn but don't start another), consumer uses `Stream.takeUntil((e) => e._tag === "TurnEnd")`.

---

### 14. Voice: first-class, three architectures

**Status: Decided.**

Researched OpenAI Realtime API (GA, WebSocket/WebRTC, native speech-to-speech), OpenAI audio completions (same API as text, audio content parts), Google Gemini Live (WebSocket, bidirectional), Anthropic (no audio support), ElevenLabs (separate TTS/STT). Neither Pi nor OpenCode has any audio support.

Voice is first-class in the agent-loop design. Three architectures supported, sharing the same core:

**Architecture 1: Audio completions (same `LLMProvider`, multimodal content)**

No separate voice provider. The existing `LLMProvider.stream()` handles audio — it's just richer content parts in the request/response. Provider layer encodes audio for the specific API (base64 for OpenAI `gpt-audio`).

```
User speaks → STT → AgentMessage.User({ content: [Audio({ data, format: "pcm16" })] })
  → run() → LLMAudioDelta events → consumer plays audio
```

Works through the existing `run()` API unchanged. The multimodal `ContentPart` union (Text | Image | Document | Audio) makes this transparent.

**Architecture 2: Chained (STT → LLM → TTS)**

Works with any LLM including Claude (no native audio). The agent loop runs text mode as normal. Consumer wraps with STT/TTS at the boundaries.

```
Mic → STTProvider.transcribe() → text → run() → LLMTextDelta → TTSProvider.synthesize() → Speaker
```

`STTProvider` and `TTSProvider` are optional service interfaces. Consumer provides layers (ElevenLabs, OpenAI TTS, Deepgram, etc.).

```typescript
class STTProvider extends Context.Service<STTProvider>()('@yolk-sdk/agent/loop/STTProvider') {
  readonly transcribe: (audio: Stream<Uint8Array>) => Stream<TranscriptEvent>
}

class TTSProvider extends Context.Service<TTSProvider>()('@yolk-sdk/agent/loop/TTSProvider') {
  readonly synthesize: (text: Stream<string>) => Stream<Uint8Array>
}
```

Higher latency (~1-2s) than native realtime. More control over each component. Works today with zero agent-loop changes beyond the interfaces.

**Architecture 3: Native realtime (v1.1)**

For sub-second full-duplex voice. OpenAI Realtime API, Gemini Live. Fundamentally different protocol — persistent bidirectional WebSocket, LLM server drives the conversation.

Cannot fit into `run()` (which is one-shot, agent-loop-driven). Separate API:

```typescript
const session: (config: {
  systemPrompt: string
  tools: ReadonlyArray<ToolDef>
  voice: VoiceConfig
}) => Effect<RealtimeSession, AgentLoopError, RealtimeProvider | ToolExecutor>

interface RealtimeSession {
  readonly events: Stream<AgentEvent>
  readonly sendAudio: (chunk: Uint8Array) => Effect<void>
  readonly sendText: (text: string) => Effect<void>
  readonly interrupt: Effect<void>
  readonly close: Effect<void>
}
```

Shares with text mode: `ToolExecutor`, `ToolDef`, `AgentEvent` taxonomy, error types. The agent loop handles tool execution inside the session — when the realtime provider emits a tool call, the loop executes it and feeds the result back.

```typescript
class RealtimeProvider extends Context.Service<RealtimeProvider>()(
  '@yolk-sdk/agent/loop/RealtimeProvider'
) {
  readonly connect: (config: RealtimeConfig) => Effect<RealtimeConnection>
}

interface RealtimeConnection {
  readonly events: Stream<RealtimeEvent>
  readonly sendAudio: (chunk: Uint8Array) => Effect<void>
  readonly sendText: (text: string) => Effect<void>
  readonly sendToolResult: (result: ToolResult) => Effect<void>
  readonly interrupt: Effect<void>
  readonly close: Effect<void>
}
```

**Phasing:**

- v1: Multimodal content model + audio events + STT/TTS interfaces. Audio completions work through existing `run()`. Chained voice works via consumer piping.
- v1.1: `session()` API + `RealtimeProvider` interface for native realtime.

**Key insight: voice doesn't require a separate LLM provider in the common case.** The same `LLMProvider` handles text and audio completions. `RealtimeProvider` is only for the native realtime experience (persistent WebSocket). STT/TTS are only for chained mode.

---

### 15. Portability scope

**Status: Decided.**

"Portable" means:

- No Cloudflare dependencies (no DO, no R2, no Workers-specific APIs)
- No Node.js-specific APIs (no `fs`, no `child_process`)
- No Bun-specific APIs
- Only `effect` core packages (`effect`, `@effect/schema`, `@effect/platform` if needed)
- Must run in: Node.js, Bun, Cloudflare Workers (V8 isolates), browser (stretch goal)

Consumer packages (outside agent-loop) bridge to platform-specific APIs via layers.

---

## Agent Loop Package Structure (Planned)

```
packages/agent/src/loop/
  src/
    index.ts                  # Public API re-exports
    run.ts                    # Text mode agent loop (Stream.asyncScoped + Effect.gen)
    session.ts                # Realtime mode session (v1.1)
    content.ts                # ContentPart schema (Text | Image | Document | Audio)
    message.ts                # AgentMessage schema (User | Assistant | ToolResult)
    event.ts                  # AgentEvent schema (full discriminated union)
    error.ts                  # AgentLoopError types (Data.TaggedError)
    tool.ts                   # ToolDef, ToolCall, ToolResult types
    accumulator.ts            # LLMEvent -> accumulated response
    services/
      llm-provider.ts         # LLMProvider service (text + audio completions)
      realtime-provider.ts    # RealtimeProvider service (v1.1, native realtime)
      stt-provider.ts         # STTProvider service (optional, chained voice)
      tts-provider.ts         # TTSProvider service (optional, chained voice)
      tool-executor.ts        # ToolExecutor service + default layer
      context-transformer.ts  # ContextTransformer service + default layer
      loop-config.ts          # LoopConfig service + default layer
    testing/
      faux-provider.ts        # FauxProvider layer + Reply builders (text + audio)
      faux-realtime.ts        # FauxRealtimeProvider layer (v1.1)
      test-executor.ts        # Canned tool results for tests
  test/
    run.test.ts               # Text mode loop tests
    session.test.ts           # Realtime mode tests (v1.1)
    accumulator.test.ts       # Response accumulation
    tool-executor.test.ts     # Tool execution + interception
    faux-provider.test.ts     # Faux provider behavior
    content.test.ts           # Multimodal content round-trip
```

---

### 16. `Stream.asyncScoped` queue sizing: unbounded

**Status: Decided.**

Both Pi (`EventStream` with plain `T[]` buffer) and OpenCode (`PubSub.unbounded()`) use unbounded buffers. Neither has backpressure concerns in practice.

Agent loop event rates: LLM tokens at ~50-100/sec, tool results bursty but bounded. Even 10 turns deep, low thousands of events. Memory pressure is negligible. Bounded adds complexity: if consumer deadlocks, producer blocks forever.

Unbounded. Non-issue.

---

### 17. Final messages: `AgentEnd` carries them

**Status: Decided.**

Pi's low-level `agentLoop()` carries new messages in the `agent_end` event:

```typescript
await emit({ type: 'agent_end', messages: newMessages })
```

Pi's `Agent` class also reconstructs from `message_end` events into `state.messages`. OpenCode reads from DB (not applicable — agent-loop is stateless).

Our `AgentEnd` event carries the accumulated messages from this run. Consumer can also reconstruct from per-turn `AssistantMessage` + `ToolResult` events. Both paths available, `AgentEnd` is the convenience path.

```typescript
type AgentEnd = {
  readonly _tag: 'AgentEnd'
  readonly messages: ReadonlyArray<AgentMessage> // messages created during this run
  readonly turns: number
  readonly usage: { input: number; output: number }
}
```

---

### 18. Faux queue exhaustion: error

**Status: Decided.**

Pi errors strictly — creates `AssistantMessage` with `stopReason: "error"` and `errorMessage: "No more faux responses queued"`. Loop terminates. Tests fail visibly.

OpenCode auto-responds with `"ok"`. Silent. Masks bugs where the loop makes unexpected extra LLM calls.

Our faux provider errors on exhaustion. `Queue.take` on an empty queue produces `FauxExhaustedError`. Tests should know exactly how many LLM calls the loop will make. An unexpected call is a bug.

---

### 19. Max turns: hard limit, default 500

**Status: Decided.**

Pi has no limit (hook-based `shouldStopAfterTurn`, no default). OpenCode has a soft limit (prompt injection telling the model to stop, default `Infinity`). Neither has a real safety net.

Our agent loop enforces a hard limit via `LoopConfig.maxTurns` (default 500). When hit, emits `AbortError({ reason: "max_turns" })` in the stream error channel. Not advisory — the loop stops.

500 is generous enough to never hit during normal use. Defense against runaway loops on headless DOs where no human is watching. Token burn is the real risk — 500 LLM calls at $0.01-0.10/call = $5-50 wasted.

Consumer overrides:

```typescript
LoopConfig.layer({ maxTurns: 50 }) // tight for simple agents
LoopConfig.layer({ maxTurns: Infinity }) // opt out (not recommended for headless)
```

Consumer can also `Stream.takeUntil` for softer per-run control without changing the global default.
