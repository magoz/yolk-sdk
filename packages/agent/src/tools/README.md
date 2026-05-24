# @yolk-sdk/agent/tools

Generic host tool registration and resolution.

## What it provides

- `ToolModule<Context>` and `ToolRegistration<Context>` types.
- Tool resolution from host modules and context.
- Duplicate tool name validation.
- Adapter from resolved tools to `@yolk-sdk/agent/loop` `ToolExecutor`.
- Package-owned `task` and `question` tool contracts.
- Helpers for task subagent result metadata and non-recursive task tool exposure.

## Use it when

- A host app wants declarative tool modules with generic context.
- You need to filter/resolve tools before running the agent loop.

## Boundaries

- No app tool catalogs.
- No provider SDKs.
- Tool access/approval is metadata; host apps enforce product policy.

## Task subagents

`task` is the standard tool for delegating focused work to a subagent. The SDK owns the
tool schema, validation, event metadata shape, and result formatting. Host apps still own
execution: model choice, provider layer, prompt, auth, concrete tools, storage, and policy.

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
  execute: ({ call, context, params }) =>
    Effect.gen(function* () {
      const startedAtMs = yield* Clock.currentTimeMillis
      const subagentRunId = makeSubagentRunId(call.id)
      const subagentToolSet = yield* resolveSubagentToolSet({
        ...context,
        subagent: true
      })
      const events = yield* run({
        messages: [UserMessage.make({ content: params.prompt })],
        systemPrompt: subagentSystemPrompt(params.subagent_type),
        tools: subagentToolSet.tools,
        model: 'gpt-5.5'
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
        model: 'gpt-5.5'
      })
    })
})
```

Host apps should usually resolve a smaller subagent toolset:

- include read/search tools that help delegated work
- exclude `task` to prevent recursion
- exclude write/destructive tools unless explicitly safe for autonomous subagents
- pass a fresh or derived session id so subagent work is traceable

The loop emits normal tool lifecycle events plus `SubagentStarted` / `SubagentCompleted` around
`task` calls. Same-turn sibling `task` calls run concurrently through the standard parallel tool
batch behavior.
