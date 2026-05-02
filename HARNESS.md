# Harness — Design Document

## What it is

Generic, portable agent loop. `packages/harness/`. Orchestrates LLM <> tool cycles. Pure Effect. No Cloudflare, no Yolk domain logic. Don't publish until second consumer exists.

**Conceptual signature:**

```typescript
const run = (config: {
  messages: ReadonlyArray<AgentMessage>
  systemPrompt: string
  tools: ReadonlyArray<ToolDef>
}): Stream<AgentEvent, HarnessError, LLMProvider | ToolExecutor | ContextTransformer | LoopConfig>
```

Config in, event stream out. Consumer owns session persistence, transport (WebSocket, stdio, etc.), and UI. System prompt is a plain field — static for the duration of a run. Dynamic per-turn instructions go through `ContextTransformer`.

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
- TUI, RPC mode, session tree — not harness concerns.

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
- `InstanceState` / `InstanceRef` / AsyncLocalStorage dual context — harness is single-instance. Consumer (DO) handles multi-tenancy.
- `AppRuntime` / `ManagedRuntime` — harness is a library, not an app. Consumer provides the runtime.
- AI SDK interop / Zod bridging — harness defines its own provider interface.
- SQLite / Drizzle — harness is stateless. Consumer owns persistence.

---

## Core Design Decisions

### 1. Agent loop: Hybrid (imperative guts, Stream skin)

**Status: Decided.**

Three options evaluated:

**A) Pure Stream composition** — Agent loop as recursive `Stream.unfoldEffect`.

```typescript
const runTurn = (msgs: AgentMessage[]): Stream<AgentEvent, HarnessError, Requirements> =>
  pipe(
    Stream.make(AgentEvent.TurnStart()),
    Stream.concat(streamLLM(msgs)),
    Stream.concat(
      Stream.fromEffect(collectToolCalls).pipe(
        Stream.flatMap((calls) =>
          calls.length === 0
            ? Stream.make(AgentEvent.TurnEnd("stop"))
            : pipe(
                executeTools(calls),
                Stream.concat(Stream.suspend(() => runTurn([...msgs, ...results]))),
              )
        ),
      )
    ),
  )
```

Problem: Recursive stream composition gets unreadable fast. `collectToolCalls` needs state accumulated from `streamLLM`, but they're separate stream segments. Threading state requires `Ref` or restructuring. Not worth the elegance.

**B) Fiber + PubSub** — Long-running fiber pushes to `PubSub.unbounded<AgentEvent>()`.

Problem: No backpressure. Multiple consumers must subscribe before fiber starts or miss events. Return type awkward (you're returning the bus, not the result). Race condition-prone.

**C) Hybrid** — Imperative `Effect.gen` loop inside `Stream.asyncScoped`. **Winner.**

```typescript
const run = (
  msgs: AgentMessage[],
): Stream<AgentEvent, HarnessError, LLMProvider | ToolExecutor> =>
  Stream.asyncScoped((emit) =>
    Effect.gen(function* () {
      const provider = yield* LLMProvider
      const executor = yield* ToolExecutor
      let current = msgs

      yield* emit.single(AgentEvent.AgentStart())

      while (true) {
        yield* emit.single(AgentEvent.TurnStart())

        // Stream LLM response, emit tokens as they arrive, accumulate
        const response = yield* provider.stream(toLLM(current)).pipe(
          Stream.tap((e) => emit.single(toAgentEvent(e))),
          Stream.runFold(Accumulator.empty, Accumulator.add),
        )

        if (response.toolCalls.length === 0) {
          yield* emit.single(AgentEvent.TurnEnd("stop"))
          break
        }

        // Parallel tool execution with per-tool events
        const results = yield* Effect.forEach(
          response.toolCalls,
          (tc) =>
            pipe(
              emit.single(AgentEvent.ToolStart(tc)),
              Effect.andThen(() => executor.execute(tc)),
              Effect.tap((r) => emit.single(AgentEvent.ToolEnd(tc, r))),
            ),
          { concurrency: "unbounded" },
        )

        current = [...current, response.message, ...results]
        yield* emit.single(AgentEvent.TurnEnd("tool_use"))
      }

      yield* emit.single(AgentEvent.AgentEnd())
    }),
  )
```

**Why Hybrid wins:**

| Property | Hybrid delivers |
|---|---|
| Readability | Plain `while(true)` in `Effect.gen`. Anyone who's read Pi's loop recognizes the shape. |
| Composability | Consumer gets `Stream<AgentEvent>`. `Stream.tap`, `Stream.takeUntil`, `Stream.runCollect`. |
| Cancellation | Interrupt consuming fiber -> interrupts `asyncScoped` producer -> interrupts in-flight LLM/tools. Free via structured concurrency. |
| Backpressure | `Stream.asyncScoped` respects consumer pace. Slow WebSocket? Producer waits. |
| Scoped cleanup | `asyncScoped` ties producer to `Scope`. Stream ends or interrupts -> finalizers run. |
| Testing | Stream is just data: `Stream.runCollect` -> assert on events. |

**The one concern:** `Stream.asyncScoped` uses an internal queue. Producer buffering if faster than consumer. Non-issue for agent loops — LLM tokens are slow, tool results are bursty but bounded.

**Consumer usage patterns:**

```typescript
// Pipe to WebSocket (DO)
harness.run(msgs).pipe(
  Stream.tap((e) => ws.send(JSON.stringify(e))),
  Stream.runDrain,
)

// Collect for testing
const events = yield* harness.run(msgs).pipe(Stream.runCollect)

// Cancel after first turn
harness.run(msgs).pipe(
  Stream.takeUntil((e) => e._tag === "TurnEnd"),
  Stream.runCollect,
)
```

---

### 2. Message model: AgentMessage vs LLMMessage

**Status: Decided. Closed union, LLM-level types only.**

Studied both Pi (open union via declaration merging on `CustomAgentMessages`) and OpenCode (closed union, 2 roles, richness in 12 part types). Key finding from both: **the loop doesn't need to understand custom types.** It only cares about: can I send this to the LLM? Did the LLM return tool calls? What are the tool results?

Pi's loop stores and forwards `AgentMessage[]` without inspecting roles beyond `"assistant"` with `toolCalls`. OpenCode's loop only inspects parts for tool state. Everything else passes through opaquely or lives in a separate layer.

**Decision:** Harness defines a closed union of types it needs for the loop. Consumer converts domain types to core types before calling `run()`.

```typescript
const AgentMessage = Schema.Union(
  Schema.TaggedStruct("User", { content: Schema.String }),
  Schema.TaggedStruct("Assistant", { content: Schema.String, toolCalls: Schema.Array(ToolCall) }),
  Schema.TaggedStruct("ToolResult", { toolCallId: Schema.String, content: Schema.String }),
)
```

Three types. That's it. No `Notification`, `CompactionSummary`, `ContextInjection` — those are consumer concerns:
- Compaction summaries → consumer wraps as `User` messages before calling `run()`
- Context injections → happen in `ContextTransformer.transform()`, which prepends real `User` messages
- Notifications → UI-level, never enter the harness

`toLLMMessages` is harness-internal, trivial — almost 1:1 mapping with minor format differences per provider (handled in `LLMProvider` layer, not in the conversion).

Consumer's domain types (e.g., `KnowledgeResult`, `IntegrationEvent`) live in their session storage and UI layer. They convert to `AgentMessage` at the boundary before entering the harness.

---

### 3. Tool execution model

**Status: Decided.**

Tools execute in parallel by default (`concurrency: "unbounded"`). Interception via layer composition, not hooks.

#### Tool definition

Four required fields, one optional. Studied Pi (TypeBox schemas, `parallel` flag, `label`) and OpenCode (Effect Schema, `id`, confirmation metadata). The harness only needs fields that affect loop behavior. Display labels, confirmation, concurrency hints → consumer layers.

```typescript
interface ToolDef<Params, R> {
  readonly name: string
  readonly description: string
  readonly parameters: Schema.Schema<Params>
  readonly execute: (params: Params) => Effect<ToolResult, ToolError, R>
  readonly timeout?: Duration  // harness wraps with Effect.timeout if provided
}
```

- `name` + `description` + `parameters` → sent to LLM as tool definitions
- `execute` → called by harness
- `timeout` → defense against runaway tools blocking the loop. Harness owns the execution fiber.
- Everything else (labels, confirmation, concurrency hints) → consumer layers

#### Interception via ToolExecutor layer

```typescript
// Service interface
class ToolExecutor extends Context.Service<ToolExecutor>()("@harness/ToolExecutor") {
  readonly execute: (call: ToolCall) => Effect<ToolResult, ToolError>
}

// Default layer — just runs the tool
const DefaultLayer = Layer.succeed(ToolExecutor, {
  execute: (call) =>
    pipe(
      resolveAndValidate(call),
      Effect.flatMap((tool) => tool.execute(call.params)),
    ),
})

// Permission-checking layer — wraps default
const PermissionLayer = Layer.effect(
  ToolExecutor,
  Effect.gen(function* () {
    const inner = yield* ToolExecutor  // get the layer below
    const permissions = yield* Permissions
    return ToolExecutor.of({
      execute: (call) =>
        pipe(
          permissions.check(call),
          Effect.flatMap(() => inner.execute(call)),
        ),
    })
  }),
)

// Logging layer — wraps whatever is below
const LoggingLayer = Layer.effect(
  ToolExecutor,
  Effect.gen(function* () {
    const inner = yield* ToolExecutor
    return ToolExecutor.of({
      execute: (call) =>
        pipe(
          Effect.log(`tool:start ${call.name}`),
          Effect.flatMap(() => inner.execute(call)),
          Effect.tap(() => Effect.log(`tool:end ${call.name}`)),
        ),
    })
  }),
)
```

Consumer composes layers: `LoggingLayer.pipe(Layer.provide(PermissionLayer), Layer.provide(DefaultLayer))`.

**No hook registry. Effect's Layer system IS the extension system.**

#### Per-file mutation serialization

Pi pattern: serialize writes to the same file. In Effect, a `Semaphore` per path:

```typescript
const fileLocks = yield* Ref.make(new Map<string, Semaphore>())

const withFileLock = (path: string, effect: Effect<A, E, R>) =>
  pipe(
    Ref.get(fileLocks),
    Effect.flatMap((locks) => {
      const lock = locks.get(path) ?? (yield* Semaphore.make(1))
      // ... update map, acquire lock, run effect
    }),
  )
```

---

### 4. Provider abstraction

**Status: Decided.**

Minimal interface. Harness doesn't know about Anthropic, OpenAI, etc. Consumer provides the layer.

```typescript
class LLMProvider extends Context.Service<LLMProvider>()("@harness/LLMProvider") {
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

`LLMEvent` (discriminated union):
```typescript
type LLMEvent =
  | { readonly _tag: "TextDelta"; readonly text: string }
  | { readonly _tag: "ToolCallStart"; readonly id: string; readonly name: string }
  | { readonly _tag: "ToolCallDelta"; readonly id: string; readonly args: string }
  | { readonly _tag: "ToolCallEnd"; readonly id: string }
  | { readonly _tag: "ThinkingDelta"; readonly text: string }
  | { readonly _tag: "Usage"; readonly input: number; readonly output: number }
  | { readonly _tag: "Done"; readonly stopReason: StopReason }
```

The harness accumulates `LLMEvent`s into a complete response (assistant message + tool calls) via `Accumulator.add`. Provider implementations live outside the harness package.

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
          stream: (_request) =>
            Stream.fromEffect(Queue.take(queue)).pipe(
              Stream.flatMap((response) => response.toStream()),
            ),
        })
      }),
    ),
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
const events = yield* harness.run(msgs).pipe(
  Stream.runCollect,
  Effect.provide(
    FauxProvider.layer(
      Reply.text("Let me check that."),
      Reply.toolCall("bash", { command: "ls" }),
      Reply.text("Done. Found 3 files."),
    ),
  ),
  Effect.provide(ToolExecutor.test),  // tools that return canned results
)

expect(events).toContainEqual(AgentEvent.TurnEnd({ reason: "stop" }))
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
class ContextTransformer extends Context.Service<ContextTransformer>()("@harness/ContextTransformer") {
  readonly transform: (messages: ReadonlyArray<AgentMessage>) => Effect<ReadonlyArray<AgentMessage>>
}

// Default: identity
const DefaultLayer = Layer.succeed(ContextTransformer, {
  transform: (msgs) => Effect.succeed(msgs),
})
```

Consumer composes transformers:

```typescript
// Inject org knowledge before each LLM call
const KnowledgeLayer = Layer.succeed(ContextTransformer, {
  transform: (msgs) =>
    Effect.gen(function* () {
      const knowledge = yield* loadOrgContext()
      return [AgentMessage.User({ content: knowledge }), ...msgs]
    }),
})
```

Multiple transformers compose via layer wrapping (same pattern as ToolExecutor interception).

---

### 7. Compaction: consumer concern

**Status: Decided. Not in the harness.**

Studied both Pi (compaction outside loop, `AgentSession` orchestrates) and OpenCode (compaction inside loop as first-class task). Key finding: **compaction requires an LLM call** — it's "summarize old messages," not "drop old messages." That makes it inherently opinionated (what to keep, how to summarize, which model to use). That opinion belongs in the consumer.

Pi's architecture validates this: the agent loop (`agent-loop.ts`) has zero compaction awareness. `AgentSession` — a layer above — handles detection, summarization, and retry.

The harness:
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

The harness DOES emit enough events to reconstruct the final message list:
- `AgentEvent.AssistantMessage` contains the full accumulated assistant message.
- `AgentEvent.ToolResult` contains each tool result.
- Consumer appends these to their stored messages.

No `SessionStorage` service in the harness. No opinion on JSONL vs SQLite vs in-memory.

---

### 9. Error taxonomy

**Status: Decided.**

All errors as `Data.TaggedError`. Exhaustive. No `unknown` unless immediately re-tagged.

```typescript
class LLMError extends Data.TaggedError("LLMError")<{
  readonly cause: "provider_error" | "rate_limit" | "context_overflow" | "invalid_response"
  readonly message: string
  readonly retryable: boolean
}> {}

class ToolError extends Data.TaggedError("ToolError")<{
  readonly tool: string
  readonly message: string
  readonly cause: "validation" | "execution" | "timeout" | "permission"
}> {}

class AbortError extends Data.TaggedError("AbortError")<{
  readonly reason: "user" | "system" | "max_turns"
}> {}

class SchemaError extends Data.TaggedError("SchemaError")<{
  readonly context: "message" | "tool_params" | "llm_response"
  readonly message: string
}> {}

type HarnessError = LLMError | ToolError | AbortError | SchemaError
```

The stream type is `Stream<AgentEvent, HarnessError, Requirements>`. Consumer handles errors via `Stream.catchTag` or `Effect.catchTag` on the drain.

---

### 10. Event taxonomy

**Status: Decided.**

Discriminated union. Effect Schema for serialization (WebSocket, logging, replay).

```typescript
type AgentEvent =
  | AgentStart
  | AgentEnd
  | TurnStart
  | TurnEnd
  | LLMStreamStart
  | LLMTextDelta
  | LLMThinkingDelta
  | LLMToolCallStart
  | LLMToolCallDelta
  | LLMToolCallEnd
  | LLMStreamEnd
  | ToolExecutionStart
  | ToolExecutionUpdate    // progress from long-running tools
  | ToolExecutionEnd
  | AssistantMessage       // full accumulated message (for persistence)
  | ToolResult             // full tool result (for persistence)
  | UsageReport            // token counts
```

Sequence per turn:
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

Wrapped by `AgentStart` / `AgentEnd` for the full run.

---

### 10. Extensibility model: Layers all the way down

**Status: Decided.**

No hook registry. No event system for extensibility. Effect's Layer system IS the extension system.

| Extension point | Service | Default |
|---|---|---|
| Swap LLM provider | `LLMProvider` | None (consumer must provide) |
| Intercept tool execution | `ToolExecutor` | Direct execution |
| Transform context before LLM | `ContextTransformer` | Identity |
| Control max turns | `LoopConfig` | `{ maxTurns: 500 }` |
| Custom accumulator | `ResponseAccumulator` | Default token accumulation |

Consumer composes:

```typescript
const myLayers = pipe(
  AnthropicProvider.layer({ model: "claude-sonnet-4-20250514" }),
  Layer.provideMerge(PermissionCheckingExecutor.layer),
  Layer.provideMerge(KnowledgeInjectionTransformer.layer),
  Layer.provideMerge(LoopConfig.layer({ maxTurns: 10 })),
)

const events = yield* harness.run(messages).pipe(
  Stream.runCollect,
  Effect.provide(myLayers),
)
```

---

### 11. Abort: fiber interruption, no explicit handle

**Status: Decided.**

Consumer interrupts the fiber running `Stream.runDrain`. Effect structured concurrency propagates into the `asyncScoped` producer.

```typescript
// Consumer
const fiber = yield* harness.run(msgs).pipe(Stream.runDrain, Effect.fork)
// ... user cancels via WebSocket
yield* Fiber.interrupt(fiber)
```

What happens on interrupt:
- **In-flight LLM stream** — provider's `Stream` gets interrupted. Provider layer's responsibility to close the HTTP connection cleanly.
- **In-flight tool execution** — `Effect.forEach` with `concurrency: "unbounded"` interrupts all child fibers. Each tool's `Effect` gets interrupted. Tool layer's responsibility to clean up (kill subprocesses, etc.).
- **Between turns** — interruption at next `yield*` point. Clean.
- **Partial events** — consumer may receive `TurnStart` without `TurnEnd`. Consumer handles incomplete sequences regardless of abort mechanism.

No explicit `abort()` handle. No `Deferred` signal. `run()` returns a `Stream`, period. Pi and OpenCode have explicit abort (`session.abort()`, `Runner.cancel()`) because their loops are long-lived fibers managed by a session layer. Our harness is stateless — each `run()` is a fresh stream, consumer owns the fiber.

For graceful stops (finish current turn but don't start another), consumer uses `Stream.takeUntil((e) => e._tag === "TurnEnd")`.

---

### 12. Portability scope

**Status: Decided.**

"Portable" means:
- No Cloudflare dependencies (no DO, no R2, no Workers-specific APIs)
- No Node.js-specific APIs (no `fs`, no `child_process`)
- No Bun-specific APIs
- Only `effect` core packages (`effect`, `@effect/schema`, `@effect/platform` if needed)
- Must run in: Node.js, Bun, Cloudflare Workers (V8 isolates), browser (stretch goal)

Consumer packages (outside harness) bridge to platform-specific APIs via layers.

---

## Harness Package Structure (Planned)

```
packages/harness/
  src/
    index.ts                  # Public API re-exports
    run.ts                    # The agent loop (Stream.asyncScoped + Effect.gen)
    message.ts                # AgentMessage schema (discriminated union)
    event.ts                  # AgentEvent schema (discriminated union)
    error.ts                  # HarnessError types (Data.TaggedError)
    tool.ts                   # ToolDef, ToolCall, ToolResult types
    accumulator.ts            # LLMEvent -> accumulated response
    services/
      llm-provider.ts         # LLMProvider service (interface only)
      tool-executor.ts        # ToolExecutor service + default layer
      context-transformer.ts  # ContextTransformer service + default layer
      loop-config.ts          # LoopConfig service + default layer
    testing/
      faux-provider.ts        # FauxProvider layer + Reply builders
      test-executor.ts        # Canned tool results for tests
  test/
    run.test.ts               # Core loop tests
    accumulator.test.ts       # Response accumulation
    tool-executor.test.ts     # Tool execution + interception
    faux-provider.test.ts     # Faux provider behavior
```

---

### 13. `Stream.asyncScoped` queue sizing: unbounded

**Status: Decided.**

Both Pi (`EventStream` with plain `T[]` buffer) and OpenCode (`PubSub.unbounded()`) use unbounded buffers. Neither has backpressure concerns in practice.

Agent loop event rates: LLM tokens at ~50-100/sec, tool results bursty but bounded. Even 10 turns deep, low thousands of events. Memory pressure is negligible. Bounded adds complexity: if consumer deadlocks, producer blocks forever.

Unbounded. Non-issue.

---

### 14. Final messages: `AgentEnd` carries them

**Status: Decided.**

Pi's low-level `agentLoop()` carries new messages in the `agent_end` event:
```typescript
await emit({ type: "agent_end", messages: newMessages })
```
Pi's `Agent` class also reconstructs from `message_end` events into `state.messages`. OpenCode reads from DB (not applicable — harness is stateless).

Our `AgentEnd` event carries the accumulated messages from this run. Consumer can also reconstruct from per-turn `AssistantMessage` + `ToolResult` events. Both paths available, `AgentEnd` is the convenience path.

```typescript
type AgentEnd = {
  readonly _tag: "AgentEnd"
  readonly messages: ReadonlyArray<AgentMessage>  // messages created during this run
  readonly turns: number
  readonly usage: { input: number; output: number }
}
```

---

### 15. Faux queue exhaustion: error

**Status: Decided.**

Pi errors strictly — creates `AssistantMessage` with `stopReason: "error"` and `errorMessage: "No more faux responses queued"`. Loop terminates. Tests fail visibly.

OpenCode auto-responds with `"ok"`. Silent. Masks bugs where the loop makes unexpected extra LLM calls.

Our faux provider errors on exhaustion. `Queue.take` on an empty queue produces `FauxExhaustedError`. Tests should know exactly how many LLM calls the loop will make. An unexpected call is a bug.

---

### 16. Max turns: hard limit, default 500

**Status: Decided.**

Pi has no limit (hook-based `shouldStopAfterTurn`, no default). OpenCode has a soft limit (prompt injection telling the model to stop, default `Infinity`). Neither has a real safety net.

Our harness enforces a hard limit via `LoopConfig.maxTurns` (default 500). When hit, emits `AbortError({ reason: "max_turns" })` in the stream error channel. Not advisory — the loop stops.

500 is generous enough to never hit during normal use. Defense against runaway loops on headless DOs where no human is watching. Token burn is the real risk — 500 LLM calls at $0.01-0.10/call = $5-50 wasted.

Consumer overrides:
```typescript
LoopConfig.layer({ maxTurns: 50 })       // tight for simple agents
LoopConfig.layer({ maxTurns: Infinity })  // opt out (not recommended for headless)
```

Consumer can also `Stream.takeUntil` for softer per-run control without changing the global default.


