# @yolk-sdk/agent/tools

Generic host tool registration and resolution.

## What it provides

- `ToolModule<Context>` and `ToolRegistration<Context>` types.
- Tool resolution from host modules and context.
- Duplicate tool name validation.
- Adapter from resolved tools to `@yolk-sdk/agent/loop` `ToolExecutor`.
- Package-owned `subagent` and `question` tool contracts.
- Helpers for subagent result metadata and non-recursive subagent tool exposure.
- `ModelVisibleToolError` helpers for recoverable, model-visible tool failures.

## Use it when

- A host app wants declarative tool modules with generic context.
- You need to filter/resolve tools before running the agent loop.

## Boundaries

- No app tool catalogs.
- No provider SDKs.
- Tool access/approval is metadata; host apps enforce product policy.

## Action-backed interactions

`makeInteractionTool` registers a general-purpose interaction: the model proposes values,
a person edits them and authorizes one server-defined action (Publish, Archive, Send, ...).
`makeInputTool` stays data-only. Registration carries original Effect schemas for
`callParameters`/`response`, an app renderer key, explicit `access`, and named actions with
labels plus optional side-effect-free `validate` and `execute` callbacks. The serializable
`ToolDef` holds display metadata only.

Selected actions run behind `ToolExecutor.execute(call, { interaction: ref })`, using only the
immutable receipt returned by a scoped `InteractionHost`. Host authentication, ownership/session/
run/generation checks, policy validation and atomic acceptance happen **before** SDK resume.
`claim(ref)` only advances an existing accepted record to started; it cannot create acceptance.
All actions and cancellation share one slot. Host-allocated submission IDs are opaque, unique
identities, not authentication or payload-derived provider idempotency guarantees.

Pass `interactionHost` to `resolveTools`, then pass both `toolSet.interactions` and
`toolSet.interactionHost` into `run`/`runToolBatch`/runtime configs. For durable preflight, load
`loadInteractionReceipts(calls, host)` first and pass its result as `interactionReceipts` to
`prepareToolBatch`. Repeated preparation has no reads, claims, settlement or business effects;
all pending siblings fence execution. Historical receipts replay before current schemas/actions,
even if the current tool was removed; missing handlers never authorize new execution.

Server admission calls `validateInteractionSubmission({ request, response, ...resolvedInteraction })`
with the authoritative pending request and freshly resolved context. This includes the bound
`validateAction`. Validation is not authentication. Use `InteractionValidationError` for expected
business rejection. V1 decodes original schemas and rejects transformations/defaults that change
exact JSON values, including nested changes. Cancellation requires no valid form and bypasses
proposal validation, but needs authoritative acceptance in the same immutable slot.

Outcomes are `completed`, explicit `failed` (known no effect), or terminal `unknown` (`isError: true`,
never auto-retried). Escaped action errors, including `ModelVisibleToolError`, are **unknown** after
dispatch. Defects/interruption preserve their Cause while a bounded finalizer attempts to persist
uncertainty. A lost settlement acknowledgement never licenses another action. `InteractionSubmitted`
remains active until the actual server result; local submissions never synthesize acceptance.
Voice, background activation, and host-less execution fail closed. See
`patterns/AGENT_HITL.md` for host wiring and `test/tools/interaction-host.ts` for the fake-effect
reference (acceptance is separate from claim; no product or provider integration).

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

## Subagents

`subagent` is the standard tool for delegating focused work to a child agent. The SDK owns the
tool schema, validation, event metadata shape, and result formatting. Host apps still own
execution: available model/reasoning choices, provider layers, prompts, auth, concrete tools,
storage, and policy. When choices are configured, the tool exposes optional `model` and
`reasoning_effort` fields; omission lets the host inherit its current runtime settings. Model ids
are opaque host values. Reasoning effort values are `minimal`, `low`, `medium`, `high`, and
`xhigh`.

Use `makeNonRecursiveSubagentToolModule` for the top-level agent so nested subagents do not receive
`subagent` again:

```ts
import { Clock, Effect, Stream } from 'effect'
import { run } from '@yolk-sdk/agent/loop'
import { makeSubagentRunId, UserMessage } from '@yolk-sdk/agent/protocol'
import {
  makeNonRecursiveSubagentToolModule,
  makeSubagentToolResult,
  makeToolExecutorLayer,
  subagentResultText,
  type SubagentContext
} from '@yolk-sdk/agent/tools'

type ToolContext = SubagentContext & {
  readonly sessionId: string
}

const subagentToolModule = makeNonRecursiveSubagentToolModule<ToolContext>({
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

      return makeSubagentToolResult({
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
- exclude `subagent` to prevent recursion
- exclude write/destructive tools unless explicitly safe for autonomous subagents
- pass a fresh or derived session id so subagent work is traceable

The loop emits normal tool lifecycle events plus `SubagentStarted` / `SubagentCompleted` around
`subagent` calls. Same-turn sibling `subagent` calls run concurrently through the standard parallel
tool batch behavior.
