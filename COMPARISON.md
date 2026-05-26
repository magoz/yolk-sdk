# Agent Loop Comparison — Yolk vs Pi vs OpenCode vs Flue

Four agent harnesses. Different layers, different trade-offs.

Flue is the odd one: it is a headless framework around Pi's core loop, not a new loop implementation.

|                | **Yolk**                                | **Pi**                              | **OpenCode**                           | **Flue**                                            |
| -------------- | --------------------------------------- | ----------------------------------- | -------------------------------------- | --------------------------------------------------- |
| Status         | Pre-code (design complete)              | Shipped (v0.72)                     | Shipped (production)                   | Experimental (`@flue/sdk` 0.3.11)                   |
| Language       | TypeScript + Effect                     | TypeScript (plain)                  | TypeScript + Effect v4                 | TypeScript (plain)                                  |
| Runtime model  | Effect everywhere                       | async/await                         | Effect everywhere                      | async/await + generated runtimes                    |
| Test runner    | TBD (Effect-native)                     | Vitest                              | Bun test                               | None found; build/lint/typecheck + manual examples  |
| Primary use    | Org intelligence platform (headless DO) | Terminal coding agent (interactive) | CLI/desktop coding agent (interactive) | Headless programmable agents (HTTP, CI, Cloudflare) |
| Source studied | This repo                               | `~/dev/docs/pi-mono`                | `~/dev/docs/opencode`                  | `~/dev/docs/flue`                                   |

---

## Architecture

|                         | Yolk                                                 | Pi                                              | OpenCode                                            | Flue                                                                                  |
| ----------------------- | ---------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Agent loop**          | `Stream.asyncScoped` + `Effect.gen` (hybrid)         | `while(true)` imperative async                  | `while(true)` in `Effect.gen`                       | Delegates to `pi-agent-core` `Agent`; `Session` drives `prompt()` / `waitForIdle()`   |
| **Loop output**         | `Stream<AgentEvent>`                                 | `EventStream<AgentEvent>` (async iterable)      | Events via `PubSub` + bus                           | `CallHandle<T>` responses + callback/SSE `FlueEvent`s                                 |
| **Who drives**          | Harness drives loop (text), server drives (realtime) | Loop drives                                     | Loop drives                                         | User handler drives session calls; Pi core drives turns                               |
| **Statefulness**        | Stateless — messages in, events out                  | Stateful — `Agent` class holds `state.messages` | Stateful — messages in DB, parts persisted mid-loop | Stateful — agent owns sandbox, session owns history                                   |
| **Session model**       | Consumer concern (DO SQLite, etc.)                   | JSONL tree (branching, forking)                 | SQLite via Drizzle (flat, event-sourced)            | `SessionStore` parent-linked entries (`message`, `compaction`, `branch_summary`)      |
| **Persistence default** | None                                                 | Filesystem JSONL                                | SQLite                                              | Node memory; Cloudflare DO SQLite                                                     |
| **Portability**         | No platform deps. Node, Bun, Workers, browser.       | Node.js (fs, child_process)                     | Bun (Bun.file, bun:test)                            | Build targets Node/Hono, Cloudflare Worker+DO, CI; SDK itself uses Node build tooling |
| **Sandbox model**       | Consumer concern                                     | Local filesystem / shell                        | Local filesystem / shell                            | `SessionEnv`: empty just-bash, local mount, custom Bash, remote sandbox connector     |

### Loop shape comparison

**Yolk** — imperative core, stream skin:

```typescript
const run = config =>
  Stream.asyncScoped(emit =>
    Effect.gen(function* () {
      while (true) {
        const response = yield* provider.stream(request).pipe(
          Stream.tap(e => emit.single(toAgentEvent(e))),
          Stream.runFold(Accumulator.empty, Accumulator.add)
        )
        if (response.toolCalls.length === 0) break
        yield* Effect.forEach(response.toolCalls, execute, { concurrency: 'unbounded' })
      }
    })
  )
```

**Pi** — plain imperative:

```typescript
while (true) {
  const message = await streamAssistantResponse(context, config, signal, emit)
  if (message.stopReason === 'error') return
  const toolCalls = extractToolCalls(message)
  if (toolCalls.length === 0) break
  const results = await executeToolCalls(toolCalls, config, signal, emit)
  currentContext.messages.push(message, ...results)
}
```

**OpenCode** — Effect `while(true)` with DB persistence:

```typescript
while (true) {
  const result = yield* processor.process({ messages, tools, model })
  if (result === "compact") { yield* compaction.create(...); continue }
  if (handle.message.finish === "tool-calls") {
    yield* handleToolCalls(handle)
    continue
  }
  break
}
```

**Flue** — framework shell around Pi core:

```typescript
const agent = await init({ model, sandbox, tools })
const session = await agent.session(threadId)

// internally:
await harness.prompt(promptText)
await harness.waitForIdle()
await syncHarnessMessagesSince(beforeLength, source)
await checkLatestAssistantForCompaction()
```

Flue's interesting code is not the loop. It is the envelope: build plugins, `SessionEnv`, session store, compaction, typed results, task child sessions.

---

## Service / DI Model

|                    | Yolk                                    | Pi                                               | OpenCode                                    | Flue                                                                          |
| ------------------ | --------------------------------------- | ------------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------- |
| **Pattern**        | `Context.Service` + `Layer`             | Constructor injection                            | `Context.Service` + `Layer`                 | `init()` option object + generated platform factories                         |
| **Composition**    | `Layer.provideMerge`                    | Manual wiring                                    | `Layer.mergeAll` → `AppLayer`               | Handler-local options: `sandbox`, `persist`, `tools`, `commands`, `providers` |
| **Swap for tests** | Provide different `Layer`               | In-memory variants (`SessionManager.inMemory()`) | In-memory DB (`:memory:`) + `TestLLMServer` | Custom `SessionStore` / `SessionEnv`; no faux LLM layer found                 |
| **Runtime**        | Consumer provides (no `ManagedRuntime`) | N/A                                              | `ManagedRuntime` with shared `memoMap`      | Build plugin emits Node or Cloudflare runtime                                 |

**Yolk** — all services are layers the consumer provides:

```typescript
const myLayers = pipe(
  AnthropicProvider.layer({ model: 'claude-sonnet-4-20250514' }),
  Layer.provideMerge(MyToolExecutor.layer),
  Layer.provideMerge(KnowledgeTransformer.layer)
)
harness.run(config).pipe(Stream.runDrain, Effect.provide(myLayers))
```

**Pi** — constructor/config injection:

```typescript
const session = await createAgentSession({
  cwd: '/workspace',
  sessionManager: SessionManager.inMemory(),
  authStorage: AuthStorage.inMemory(),
  modelRegistry: ModelRegistry.inMemory(),
  customTools: [myTool]
})
```

**OpenCode** — global AppLayer with 40+ services merged:

```typescript
const AppLayer = Layer.mergeAll(
  Bus.defaultLayer,
  Config.defaultLayer,
  Session.defaultLayer /* ...40 more... */
).pipe(Layer.provideMerge(Observability.layer))
const rt = ManagedRuntime.make(AppLayer, { memoMap })
```

**Flue** — request context + `init()`:

```typescript
export default async function ({ init, payload, env }: FlueContext) {
  const agent = await init({
    sandbox: 'local',
    model: 'anthropic/claude-sonnet-4-6',
    tools: github.tools,
    providers: { anthropic: { baseUrl: env.GATEWAY_URL } }
  })
  return agent.session().then(s => s.prompt(payload.prompt))
}
```

---

## Message Model

|                   | Yolk                                              | Pi                                                        | OpenCode                                                 | Flue                                                                                    |
| ----------------- | ------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Message types** | 3 (User, Assistant, ToolResult)                   | 3 base + 4 custom via declaration merging                 | 2 (User, Assistant)                                      | Pi `AgentMessage` in history + `SessionEntry` wrappers                                  |
| **Content model** | Multimodal `ContentPart` (Text \| Image \| Document \| Audio) | `TextContent \| ImageContent`                             | 12 Part types (Text, File, Tool, Reasoning, etc.)        | Pi blocks (`text`, `thinking`, `toolCall`, `toolResult`); public `prompt(text)` only    |
| **Audio**         | First-class (`Audio` content part)                | None                                                      | Schema acknowledges, all models `audio: false`           | None model-native; MCP audio becomes text placeholder                                   |
| **Extensibility** | Closed union. Consumer converts at boundary.      | Open via `declare module` on `CustomAgentMessages`        | Closed. Escape hatch via `metadata: Record<string, any>` | No public message extension; stores compaction/branch summaries outside LLM messages    |
| **LLM bridge**    | Harness-internal `toLLMMessages` (trivial)        | Consumer-provided `convertToLlm()` with exhaustive switch | Internal `toModelMessagesEffect` (~250 lines)            | Pi handles provider conversion; Flue rebuilds context from `SessionHistory`             |
| **Schema**        | Effect Schema                                     | Plain TypeScript interfaces                               | Effect Schema + Zod interop                              | JSON Schema/TypeBox-ish for tools; Valibot for typed results; payload compile-time only |

**Yolk** content model:

```typescript
type ContentPart =
  | { _tag: 'Text'; text: string }
  | { _tag: 'Image'; data: string; mimeType: string }
  | { _tag: 'Document'; data: string; mimeType: string; filename: string }
  | { _tag: 'Audio'; data: string; format: AudioFormat }
```

**Pi** content model:

```typescript
type UserContent = string | (TextContent | ImageContent)[]
type AssistantContent = (TextContent | ThinkingContent | ToolCall)[]
```

**OpenCode** content model (12 part types, separate from messages):

```typescript
type Part =
  | TextPart
  | SubtaskPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | AgentPart
  | RetryPart
  | CompactionPart
```

**Flue** persistence model:

```typescript
type SessionEntry = MessageEntry | CompactionEntry | BranchSummaryEntry
// buildContext() turns latest compaction into a synthetic user `[Context Summary]` message.
```

---

## Tool System

|                        | Yolk                                                               | Pi                                                                        | OpenCode                                         | Flue                                                                                         |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| **Definition**         | `ToolDef<P, R>` (name, description, parameters, execute, timeout?) | `defineTool()` (name, label, description, parameters, execute, parallel?) | Tool.Info (id, description, parameters, execute) | `ToolDef` (name, description, JSON Schema params, `execute(args, signal) → Promise<string>`) |
| **Schema**             | Effect Schema                                                      | TypeBox                                                                   | Effect Schema (+ Zod for AI SDK)                 | `@mariozechner/pi-ai` `Type` / JSON Schema; Valibot result schemas                           |
| **Execution**          | `Effect.forEach` with `concurrency: "unbounded"`                   | `Promise.all` or sequential (per-tool `parallel` flag)                    | Sequential per step, parallel within step        | Pi core `toolExecution: "parallel"`; scoped tool set per call                                |
| **Interception**       | `ToolExecutor` layer wrapping (before/after/block)                 | Extension hooks (`tool_call`, `tool_result`)                              | Plugin hooks (`tool.execute.before/after`)       | No hooks; pass scoped `tools` / `commands`, or wrap tools yourself                           |
| **Built-ins**          | Consumer-defined                                                   | Coding tools in coding-agent package                                      | Rich built-ins + MCP                             | `read`, `write`, `edit`, `bash`, `grep`, `glob`, `task`                                      |
| **Subagents**          | Planned via consumer/task layer                                    | Depends on extension/session usage                                        | Built-in agents/tasks                            | `task` tool + `session.task()` child session, shared sandbox                                 |
| **File serialization** | `Semaphore` per path via `Ref<Map>`                                | Custom per-file serialization queue                                       | Not built-in                                     | Not built-in                                                                                 |
| **Timeout**            | Per-tool `Duration` on `ToolDef`                                   | Not built-in                                                              | Not built-in                                     | Bash timeout + abort signals; no per-custom-tool timeout field                               |
| **Typed final result** | Consumer concern                                                   | Consumer concern                                                          | Consumer concern                                 | `finish` / `give_up` tools injected from Valibot schema                                      |

---

## Provider Abstraction

|                       | Yolk                                                           | Pi                                                | OpenCode                                           | Flue                                                                 |
| --------------------- | -------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| **Interface**         | `LLMProvider.stream(request) → Stream<LLMEvent>`               | `StreamFn(model, context, options) → EventStream` | AI SDK `streamText()` wrapped in Effect `Stream`   | Model string `provider/model`; `pi-ai` registry resolves `Model`     |
| **Multimodal**        | Text + audio in same interface                                 | Text + image                                      | Text + image + PDF (audio schema'd but disabled)   | Public prompt text-only; internal Pi model support inherited         |
| **Providers**         | Consumer provides layer. Harness agnostic.                     | 15+ built-in (Anthropic, OpenAI, Google, etc.)    | AI SDK providers (Anthropic, OpenAI, Google, etc.) | `pi-ai` providers + Cloudflare Workers AI binding (`cloudflare/...`) |
| **Provider settings** | Layer-specific                                                 | Registry/auth storage                             | Config/plugins                                     | Runtime `baseUrl`, headers, API key per provider                     |
| **Realtime**          | Separate `RealtimeProvider` for native speech-to-speech (v1.1) | None                                              | None                                               | None                                                                 |
| **Faux/test**         | `FauxProvider.layer(Reply.text(...), Reply.toolCall(...))`     | `registerFauxProvider()` with response queue      | `TestLLMServer` (real HTTP, queue-based)           | None found                                                           |

---

## Voice / Audio

|                     | Yolk                                             | Pi   | OpenCode | Flue |
| ------------------- | ------------------------------------------------ | ---- | -------- | ---- |
| **Audio input**     | `Audio` content part in messages                 | None | None     | None |
| **Audio output**    | `AudioDelta` events in stream                    | None | None     | None |
| **Native realtime** | `RealtimeProvider` + `session()` API (v1.1)      | None | None     | None |
| **Chained TTS/STT** | `STTProvider` / `TTSProvider` service interfaces | None | None     | None |
| **Architectures**   | Audio completions, chained, native realtime      | N/A  | N/A      | N/A  |

---

## Testing

|                        | Yolk                                                  | Pi                                                       | OpenCode                                      | Flue                                                                 |
| ---------------------- | ----------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| **Faux LLM**           | `FauxProvider.layer()` — Effect Layer, no HTTP        | `registerFauxProvider()` — registry-based, no HTTP       | `TestLLMServer` — real HTTP on random port    | None found                                                           |
| **Response scripting** | `Reply.text()`, `Reply.toolCall()`, `Reply.message()` | `fauxText()`, `fauxToolCall()`, `fauxAssistantMessage()` | `reply().text().tool().stop()` builder        | None found                                                           |
| **Queue exhaustion**   | Error (strict)                                        | Error (`"No more faux responses queued"`)                | Auto-respond `"ok"` (lenient)                 | N/A                                                                  |
| **Dynamic responses**  | TBD (likely factory function)                         | `FauxResponseFactory` based on context                   | Match predicates on request body              | N/A                                                                  |
| **Tool testing**       | `ToolExecutor.test` layer with canned results         | Custom tool mocks                                        | Real tools in temp dirs                       | Manual example agents (`fs-test`, `compaction-test`, `session-test`) |
| **Isolation**          | Layer swap — no global state                          | In-memory variants for all stateful components           | Temp dirs + `:memory:` SQLite + env stripping | Custom `SessionStore` + `SessionEnv`; Node default memory            |

---

## Event System

|                        | Yolk                                                                | Pi                                                  | OpenCode                                   | Flue                                                               |
| ---------------------- | ------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| **Pattern**            | `Stream<AgentEvent>` (typed, composable)                            | Callback listeners + `EventStream` async iterable   | `PubSub` + `BusEvent.define()` with Schema | Callback `FlueEventCallback`; build plugins expose SSE             |
| **Backpressure**       | `Stream.asyncScoped` internal queue (unbounded)                     | None (unbounded array) or implicit (listener await) | None (`PubSub.unbounded()`)                | None in callback path; SSE writes are fire-and-forget in callbacks |
| **Serialization**      | Effect Schema (WebSocket, logging, replay)                          | Plain JSON                                          | Effect Schema                              | Plain JSON SSE events                                              |
| **Audio events**       | `LLMAudioDelta`, `LLMAudioDone`, `LLMOutputTranscript`              | None                                                | None                                       | None                                                               |
| **Realtime events**    | `SessionCreated`, `UserSpeechStarted`, `ResponseInterrupted` (v1.1) | None                                                | None                                       | None                                                               |
| **Persistence events** | `AssistantMessage`, `ToolResult`, `UsageReport`                     | Message events include enough state                 | DB is source of truth                      | No message persistence events; session saves internally            |

Event sequence per turn:

```
            Yolk                          Pi                           OpenCode                    Flue
            ────                          ──                           ────────                    ────
TurnStart                   turn_start                    (no turn events)             (no explicit turn_start)
  LLMStreamStart              message_start                 Stream.tap(handleEvent)      agent_start
    LLMTextDelta                message_update                text part delta             text_delta
    LLMAudioDelta               (N/A)                         (N/A)                       (N/A)
    LLMToolCallStart            message_update (tool call)    tool part pending→running   tool_start
    LLMToolCallEnd              message_update                tool part completed         tool_end
  LLMStreamEnd                message_end                   (stream ends)                (no explicit stream_end)
  AssistantMessage            (in state.messages)           (persisted to DB)            saved after waitForIdle
  ToolExecutionStart          tool_execution_start          (tool runs inline)           tool_start
    ToolExecutionUpdate         tool_execution_update         (N/A)                       (N/A)
  ToolExecutionEnd            tool_execution_end            tool part updated            tool_end
  ToolResult                  (in state.messages)           (persisted to DB)            saved after waitForIdle
  UsageReport                 (in assistant message.usage)  (in assistant message.tokens) response.usage
TurnEnd                     turn_end                      (no turn events)             turn_end → idle → result
```

---

## Extensibility

|                       | Yolk                                                       | Pi                                                    | OpenCode                                           | Flue                                                                                    |
| --------------------- | ---------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Model**             | Layer composition — Effect's Layer IS the extension system | Extension system — 25+ lifecycle hooks, typed results | Plugin system — hooks at key points                | Framework seams: TS handlers, `init()` options, roles/skills, connectors, build plugins |
| **Add tools**         | Provide in `run()` config                                  | `defineTool()` + config or extension `registerTool()` | Tool registry, MCP integration                     | `init()` / per-call `tools`; MCP remote adapter                                         |
| **Intercept tools**   | Wrap `ToolExecutor` layer                                  | `tool_call` / `tool_result` hooks (can block/modify)  | `tool.execute.before/after` plugin hooks           | Wrap tool definitions; use scoped `commands`; no lifecycle hook                         |
| **Modify context**    | `ContextTransformer` layer                                 | `context` hook + `before_agent_start` hook            | `experimental.chat.messages.transform` plugin hook | `AGENTS.md`, `CLAUDE.md`, skills discovery, role system-prompt overlay                  |
| **Custom compaction** | Consumer-owned (not in harness)                            | `session_before_compact` hook (cancel/replace)        | `experimental.session.compacting` plugin hook      | No public hook found; built-in threshold/overflow summarizer                            |
| **Custom providers**  | Provide `LLMProvider` layer                                | Extension `registerProvider()`                        | Plugin system                                      | Provider runtime settings; custom provider requires `pi-ai` registry support            |
| **Custom platforms**  | Consumer deploys harness                                   | N/A                                                   | N/A                                                | `BuildPlugin` target API                                                                |

**Yolk** — no hook registry needed:

```typescript
// Intercept tools via layer wrapping
const PermissionLayer = Layer.effect(
  ToolExecutor,
  Effect.gen(function* () {
    const inner = yield* ToolExecutor
    return ToolExecutor.of({
      execute: call =>
        pipe(
          checkPermission(call),
          Effect.flatMap(() => inner.execute(call))
        )
    })
  })
)
```

**Pi** — callback-based hooks:

```typescript
pi.on('tool_call', async (event, ctx) => {
  if (event.toolName === 'bash' && event.input.command.includes('rm -rf'))
    return { block: true, reason: 'Blocked dangerous command' }
})
```

**OpenCode** — plugin hooks:

```typescript
plugin.trigger('tool.execute.before', { tool, input })
plugin.trigger('tool.execute.after', { tool, input, output })
```

**Flue** — scoped tools/commands:

```typescript
await session.skill('triage', {
  commands: [gh, npm],
  tools: [githubIssueTool],
  result: v.object({ severity: v.picklist(['low', 'high']) })
})
```

---

## Compaction

|                       | Yolk                                                | Pi                                             | OpenCode                                          | Flue                                                               |
| --------------------- | --------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| **Where**             | Consumer concern (not in harness)                   | Outside loop (`AgentSession`)                  | Inside loop (first-class task)                    | Inside `Session`, after assistant turn and overflow                |
| **Detection**         | Consumer watches `UsageReport` events               | Threshold (token count) + overflow error regex | Real usage vs model limits + overflow error regex | Threshold (`contextWindow - reserveTokens`) + provider overflow    |
| **Token counting**    | Provider returns usage in events                    | Real usage + chars/4 heuristic for trailing    | Real usage from provider                          | Real usage + chars/4 heuristic for trailing                        |
| **Overflow handling** | `LLMError({ cause: "context_overflow" })` in stream | Remove error message, compact, retry once      | Set `needsCompaction`, loop continues             | Remove failed assistant, compact, `harness.continue()`, retry once |
| **Summary method**    | Consumer's choice                                   | LLM call with structured prompt                | Separate "compaction agent"                       | `completeSimple()` with structured summary prompt                  |
| **Persistence**       | Consumer-owned                                      | Session JSONL                                  | SQLite parts                                      | `CompactionEntry` with summary, first-kept id, token/cost usage    |
| **Extension**         | N/A (consumer handles)                              | `session_before_compact` hook                  | `experimental.session.compacting` plugin hook     | No public hook found                                               |

---

## Error Handling

|                       | Yolk                                                 | Pi                                           | OpenCode                                                            | Flue                                                                               |
| --------------------- | ---------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Model**             | `Data.TaggedError` — typed, exhaustive               | Thrown errors + typed event results          | `Data.TaggedError` + Zod discriminated unions                       | Error classes for HTTP + raw `Error` in session path + `DOMException` AbortError   |
| **Types**             | `LLMError \| ToolError \| AbortError \| SchemaError` | Various error strings, `stopReason: "error"` | `ContextOverflowError \| AbortedError \| APIError \| ...` (7 types) | `FlueError` / `FlueHttpError`; `ResultUnavailableError`; `AbortError` DOMException |
| **try/catch**         | Never                                                | Yes (standard JS)                            | Never (style guide prohibits)                                       | Yes                                                                                |
| **Consumer handling** | `Stream.catchTag` / `Effect.catchTag`                | Check `stopReason` on assistant message      | Effect error channel                                                | Await rejects; HTTP/SSE error envelope for generated servers                       |

---

## Abort / Cancellation

|                      | Yolk                                               | Pi                           | OpenCode                               | Flue                                                                                   |
| -------------------- | -------------------------------------------------- | ---------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------- |
| **Mechanism**        | Fiber interruption (Effect structured concurrency) | `AbortController` / `signal` | `Runner.cancel()` → fiber interruption | `CallHandle.abort()` / external `AbortSignal`; forwards to Pi, compaction, child tasks |
| **Explicit API**     | None — consumer interrupts fiber                   | `session.abort()`            | `Runner.cancel()`                      | Public per-call handle `.abort()`; session abort internal                              |
| **Graceful stop**    | `Stream.takeUntil(e => e._tag === "TurnEnd")`      | N/A (abort is hard stop)     | N/A                                    | None general; await call result or abort                                               |
| **Mid-tool cleanup** | Structured concurrency interrupts child fibers     | Signal propagated to tools   | Scope-based cleanup                    | Custom tools receive signal; remote CF sandbox only checks before/after                |

---

## Max Turns

|                  | Yolk                                                    | Pi                                    | OpenCode                                            | Flue                                                                        |
| ---------------- | ------------------------------------------------------- | ------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| **Default**      | 500 (hard limit)                                        | None (infinite)                       | Infinity (soft, prompt-based)                       | No Flue hard cap found for normal prompts; typed-result followups cap at 32 |
| **Enforcement**  | Loop stops, emits `AbortError({ reason: "max_turns" })` | `shouldStopAfterTurn` hook (optional) | Injects "respond with text only" message (advisory) | General prompt relies on Pi core; result mode nudges until cap then throws  |
| **Configurable** | `LoopConfig.layer({ maxTurns: N })`                     | Consumer implements hook              | Per-agent `steps` config                            | No public max-turn option found                                             |

---

## Flue Assessment

Flue's core contribution is not model orchestration. It is packaging autonomous agents as deployable TypeScript units.

**Strong ideas to steal:**

- Agent ID vs session ID split: sandbox/runtime scope separate from conversation threads.
- `SessionEnv`: one interface for shell + filesystem across empty, local, and remote sandboxes.
- Build plugins: Node/Hono, Cloudflare Worker+DO, CI from same handler shape.
- Scoped commands: grant privileged CLI access per prompt without leaking secrets into context.
- Typed result tools: `finish` / `give_up` gives schema-checked agent outputs without a separate extractor step.
- Child task sessions: isolated context, shared sandbox, recursive deletion.
- DO SQLite session store: simple default for Cloudflare persistence.

**Do not copy into Yolk agent loop:**

- Framework build system. Yolk needs a library core; app/runtime packaging belongs above it.
- Session persistence in the agent loop. Keep persistence consumer-owned.
- Built-in compaction in the loop. It is opinionated and model-calling.
- Provider registry coupling. Keep provider interface minimal and layer-provided.
- Text-only public prompt API. Yolk needs multimodal from day one.

**Risk signals:**

- Experimental API.
- No real test suite found.
- Public types use `any` (`FlueContext<TPayload = any>`, tool args, metadata).
- No model-native audio/multimodal prompt path.
- No public hard max-turn safety net.

---

## Summary: Design Philosophy

**Pi** — Minimal, pragmatic. Plain TypeScript. Extension system for third-party customization. No Effect, no schemas beyond TypeBox. Built for terminal users who want a hackable coding agent.

**OpenCode** — Full Effect stack. Plugin system. SQLite persistence. Managed runtime. Desktop app + CLI + web. Built as an open-source Claude Code alternative with enterprise features (MCP, multiple providers, managed config).

**Flue** — Headless framework. TypeScript handlers, deploy targets, sandbox abstraction, session persistence, typed results. Uses Pi core for the loop. Built for developers shipping autonomous agents over HTTP/CI/Cloudflare, not for interactive TUI users.

**Yolk** — Effect-native, stateless, portable. No extension system (consumer owns the code). Layers for composition. Multimodal from day one. Built as a reusable engine for an org intelligence platform running headless on Cloudflare DOs.

| Principle     | Yolk                                  | Pi                                              | OpenCode                                  | Flue                                                                |
| ------------- | ------------------------------------- | ----------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------- |
| Portability   | Core value — runs everywhere          | Node.js focused                                 | Bun focused                               | Deployable to Node/Cloudflare/CI; build-time Node assumptions       |
| Statefulness  | Stateless — consumer owns persistence | Stateful — agent holds messages                 | Stateful — DB-backed                      | Stateful — agent sandbox + session store                            |
| Extensibility | Layers (compile-time composition)     | Hooks (runtime registration)                    | Plugins (runtime registration)            | Handler/options + roles/skills + connectors/build plugins           |
| Voice         | First-class (3 architectures)         | None                                            | None                                      | None                                                                |
| Opinions      | Minimal — consumer decides            | Moderate — sessions, compaction, tools built in | Strong — DB schema, config, UI, desktop   | Strong framework envelope; moderate loop opinions inherited from Pi |
| Target        | Library consumer (DO, server, etc.)   | End user (terminal)                             | End user (terminal, desktop, web)         | Developer shipping headless agents                                  |
| Best lesson   | Keep core stateless and typed         | Simple loop, good events                        | Effect service rigor, durable app runtime | Sandbox/session/deploy envelope for headless agents                 |
