# @yolk-sdk/agent/tools

Generic host tool registration and resolution.

## What it provides

- `ToolModule<Context>` and `ToolRegistration<Context>` types.
- Tool resolution from host modules and context.
- Duplicate tool name validation.
- Adapter from resolved tools to `@yolk-sdk/agent/loop` `ToolExecutor`.
- Package-owned `task` and `question` tool contracts.
- Helpers for task subagent result metadata and non-recursive task tool exposure.
- `ModelVisibleToolError` helpers for recoverable, model-visible tool failures.

## Use it when

- A host app wants declarative tool modules with generic context.
- You need to filter/resolve tools before running the agent loop.

## Boundaries

- No app tool catalogs.
- No provider SDKs.
- Tool access/approval is metadata; host apps enforce product policy.

## Recoverable tool failures

Use `modelVisibleToolError(...)` for expected failures the model can recover from: validation,
invalid input, denied policy, not-found resources, unavailable upstream data, or timeouts. `makeTool`
converts these into `ToolResult.isError = true` with structured content:

```ts
import { Effect } from 'effect'
import { modelVisibleToolError } from '@yolk-sdk/agent/tools'

return Effect.fail(
  modelVisibleToolError({
    tool: 'search_docs',
    reason: 'not_found',
    message: 'Document not found',
    details: { documentId: 'doc_123' }
  })
)
```

Thrown `ToolError`s become model-visible failed tool results plus `ToolExecutionError` events,
so keep messages safe and non-secret. Reserve stream failure for provider/runtime defects,
aborts, and implementation bugs outside typed tool execution.

## Task subagents

`task` is the standard tool for delegating focused work to a subagent. The SDK owns the
tool schema, validation, event metadata shape, and result formatting. Host apps still own
execution: available model/reasoning choices, provider layers, prompts, auth, concrete tools,
storage, and policy. When choices are configured, the tool exposes optional `model` and
`reasoning_effort` fields; omission lets the host inherit its current runtime settings. Model ids
are opaque host values. Reasoning effort values are `minimal`, `low`, `medium`, `high`, and
`xhigh`.

Use `makeNonRecursiveTaskToolModule` for the top-level agent so nested subagents do not receive
`task` again:

```ts
import { Clock, Effect, Stream } from 'effect'
import { run } from '@yolk-sdk/agent/loop'
import { makeSubagentRunId, UserMessage } from '@yolk-sdk/agent/protocol'
import {
  makeNonRecursiveTaskToolModule,
  makeTaskToolResult,
  makeToolExecutorLayer,
  subagentResultText,
  type TaskSubagentContext
} from '@yolk-sdk/agent/tools'

type ToolContext = TaskSubagentContext & {
  readonly sessionId: string
}

const taskToolModule = makeNonRecursiveTaskToolModule<ToolContext>({
  subagents: [
    { name: 'general', description: 'Handle complex multi-step work.' },
    { name: 'explore', description: 'Explore code and docs.' }
  ],
  models: [
    { id: 'gpt-5.5', description: 'Strong general-purpose model.' },
    { id: 'fast-model', description: 'Fast model for focused exploration.' }
  ],
  reasoningEfforts: [
    { value: 'medium', description: 'Balanced default for normal exploration.' },
    { value: 'high', description: 'Use for difficult reasoning.' }
  ],
  execute: ({ call, context, params }) =>
    Effect.gen(function* () {
      const startedAtMs = yield* Clock.currentTimeMillis
      const subagentRunId = makeSubagentRunId(call.id)
      const model = params.model ?? 'gpt-5.5'
      const reasoningEffort = params.reasoning_effort ?? 'medium'
      const subagentToolSet = yield* resolveSubagentToolSet({
        ...context,
        subagent: true
      })
      const events = yield* run({
        messages: [UserMessage.make({ content: params.prompt })],
        systemPrompt: subagentSystemPrompt(params.subagent_type),
        tools: subagentToolSet.tools,
        model,
        reasoningEffort
      }).pipe(Stream.runCollect, Effect.provide(makeToolExecutorLayer(subagentToolSet)))
      const endedAtMs = yield* Clock.currentTimeMillis

      return makeTaskToolResult({
        callId: call.id,
        output: subagentResultText(Array.from(events)),
        subagentType: params.subagent_type,
        description: params.description,
        subagentRunId,
        startedAtMs,
        endedAtMs,
        model,
        reasoningEffort
      })
    })
})
```

Host apps should advertise only runtime choices they can execute. If support depends on the
selected model, validate the model/reasoning combination before constructing the child provider
layer and return a model-visible error for unsupported combinations.

Host apps should usually resolve a smaller subagent toolset:

- include read/search tools that help delegated work
- exclude `task` to prevent recursion
- exclude write/destructive tools unless explicitly safe for autonomous subagents
- pass a fresh or derived session id so subagent work is traceable

The loop emits normal tool lifecycle events plus `SubagentStarted` / `SubagentCompleted` around
`task` calls. Same-turn sibling `task` calls run concurrently through the standard parallel tool
batch behavior.
