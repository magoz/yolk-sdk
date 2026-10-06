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
- Model-argument decoding through the advertised JSON codec (`null` on `Schema.optional` means
  absent) and `omitNullOptionalToolArguments`, which `resolveTools` applies to every call.
- `withToolArgumentsErrorHint` for actionable unknown-key validation messages.
- The durable tool-call ledger contract (`ToolLedgerStore`, `ToolLedgerEntry`) and an in-memory
  reference store, so a re-executed ledgered call (by default writes and `subagent`) never runs
  twice under the same ledger key.
- Staged tool plans: stageable approval-gated tools, the `ToolPlanStore` contract, and the
  `makePlanReviewTool` interaction that applies a person's selection once.

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

## Staged tool plans

See `docs/adr/0005-staged-tool-plans.md`. Approval-gated tools marked `staging` (`makeTool({ approval,
staging })`) can be staged by nested-access registrations (code mode's `stage(name, args)`) through
`nested.staging`, and applied only after a person accepts a `makePlanReviewTool` interaction
selecting the staged keys. `resolveTools(..., { plans: { store }, interactionHost })` with exactly one
plan review registration enables it; without them there is no staging and the review tool is
unavailable. The plan executor (`ToolPlanRuntime.apply`) re-reads the review receipt, claims the
plan once, and runs selected calls in staged order through `executeRegistration` (ids
`<reviewCallId>/<n>`, ledger parent the review call). Applied calls bypass code mode's
`beforeNestedCall` and `ToolExecutor` decorators: the review's `beforeCall` is the only per-call
host authority hook. `previewStoredToolPlan` (paged, from the store) and `previewToolPlan` render
bounded previews; `ToolPlanOutcome` and `ToolPlanPreview*` are Effect Schemas for decoding results
across process boundaries. Plan store outages fail the batch closed at preflight (never an
invalid-arguments verdict).

## Output schemas, exposure, and nested tool access

These are the code mode contract (`docs/adr/0002-code-mode.md`); this package does not run scripts.

- `makeTool({ output })` adds declaration-only `ToolDef.outputSchema`, lowered like `parameters`.
- `callableBy: 'all' | 'model' | 'codemode'` (default `all`) and, for `codemode` only,
  `discovery: 'listed' | 'search'` (default `listed`) decide who may call a tool. Codemode-only
  tools never reach providers. Approval, input, interaction, activated background, `question`, and
  `subagent` tools never run from code mode; `resolveTools` rejects `callableBy: 'codemode'` on them.
- `nestedToolAccess: true` gives a registration's `execute` a `nested` executor with the other
  code-mode-callable tools of the same resolution and host context. Nested calls run through the
  resolved execute path and fail closed with model-visible error results. Assign nested call ids as
  `<parentToolCallId>/<seq>`.
- `describe: ({ tools }) => string` on a nested-access registration computes its resolved
  description from those nested tools (for example a code mode catalog); `def.description` stays
  the static fallback.
- Report nested calls on the result with protocol `recordNestedToolCall` and
  `nestedToolCallResultFields` over `makeNestedToolCallRecorder({ maxCalls })`; the bounded record
  (with per-status `counts` over every call) and summed usage never reach the model.

## Durable tool ledger

Hosts that re-execute steps (Vercel Workflow's queue is at-least-once, sequentially and
concurrently) pass a durable ledger to `resolveTools`. Ledgered calls (default: every non-`read`
tool plus the built-in `subagent` tool, top-level and nested code mode calls alike) run at most
once per key. Input and interaction tools are never ledgered: their at-most-once guarantee is the
host's `InteractionHost` receipts. When the policy ledgers an activated background tool, its
`host.accept` admission runs inside the ledger, so a replay returns the stored acceptance instead of
admitting again:

| Claim       | Meaning                                        | What happens                                                     |
| ----------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| `Fresh`     | key was absent; this execution owns the claim  | runs, heartbeats the lease, records the outcome                  |
| `Completed` | an outcome is recorded                         | returns the stored result (or the stored `ToolError`), no run    |
| `InFlight`  | another execution holds a live lease           | waits until completed/abandoned or the deadline; never runs      |
| `Abandoned` | lease expired without an outcome (crashed run) | never runs; model-visible "may already have been applied" result |

```ts
import { Effect } from 'effect'
import { classifyToolLedgerEntry, resolveTools, type ToolLedgerStore } from '@yolk-sdk/agent/tools'

// Host-owned storage scoped to one Workflow run (sketch; `db` calls are host code returning
// interruptible Effects, for example `Effect.tryPromise` passing the AbortSignal to the driver).
// Leases use the database clock: `now() + leaseMs`, classified against `now()`.
const makeRunToolLedger = (runId: string): ToolLedgerStore => ({
  scope: runId,
  // Atomic insert-if-absent; otherwise classify the stored entry without changing it.
  claim: request =>
    db.claimToolCall(runId, request, (entry, dbNowMs) => classifyToolLedgerEntry(entry, dbNowMs)),
  // Extend the lease to now() + leaseMs while the entry has no outcome; never shorten it.
  heartbeat: ({ key, leaseMs }) => db.extendLeaseIfClaimed(runId, key, leaseMs),
  complete: ({ key, outcome, completedAtMs }) =>
    db.completeOnce(runId, key, outcome, completedAtMs),
  list: parentKey => db.listChildren(runId, parentKey)
})

const resolveStepTools = Effect.gen(function* () {
  return yield* resolveTools(modules, context, {
    ledger: { store: makeRunToolLedger(workflowRunId), deadline: () => stepDeadlineMs }
  })
})
```

- Persist entries with `Schema.toCodecJson(ToolLedgerEntry)`, or every claim field: `args` (8 KiB
  audit preview), `argsTruncated`, and `argsDigest`. A different tool name or `argsDigest` under the
  same key is a model-visible conflict; never compare the preview. Stored results are bounded
  (`maxResultBytes`, default 1 MiB, measured on the serialized JSON; media, then `nestedCalls`, then
  `structuredContent` are reduced first) and wire-safe; the live call still returns the full result.
- `argsDigest` is a stable format; store it as text (`char(64)`) and never recompute it
  differently: lower-case hex SHA-256 of the UTF-8 bytes of the canonical JSON of the raw
  `call.params` (before Schema decoding), compact, with object keys sorted by UTF-16 code units
  and numbers and strings as `JSON.stringify` writes them. It is a conflict fingerprint, not a
  security boundary. All unserializable arguments (cycles, `BigInt`) share one digest, integers
  beyond 2^53 lose precision before hashing, and arguments nested too deeply to canonicalize are
  digested from their compact JSON.
- Keys are `call.id` and `<parentCallId>/<seq>` for nested calls. Call ids must be unique within a
  ledger scope: a reused id with the same arguments replays the earlier result. Scope the store so
  keys cannot collide: one run, plus the turn or step when a provider can reuse call ids.
- Executors receive `idempotencyKey` (`<scope>:<key>`), stable across re-executions; forward it to
  external APIs that deduplicate, for a crash between their commit and the ledger's `complete`.
- One clock per store: `claim` and `heartbeat` get the lease length `leaseMs` (stores on their own
  clock, such as a database `now()`, which avoids skew between instances) and the caller's
  `Clock` times `nowMs`/`leaseExpiresAtMs` (clock-agnostic stores, such as the in-memory one).
- Override the policy with `isLedgered` (add your own delegation tools, for example
  `input => defaultToolLedgerPolicy(input) || input.call.name === 'delegate'`), and the timing with
  `leaseMs` (30 s), `heartbeatIntervalMs` (a third of the lease, at most half: renewal margin, not a
  guarantee), `pollIntervalMs` (1 s), `maxWaitMs` (150 s from the first claim; the polls after it
  stay within the wait, the last one halfway through the final interval), and `deadline` (non-finite
  values ignored). A failed poll fails closed.
- `deadline` bounds only waiting for an in-flight duplicate. A call that runs is not cut at it, and
  recording its outcome can take up to three `complete` attempts of `toolLedgerCompleteTimeoutMs`
  (5 s each, about 15 s) after the call returns. Reserve that finalization time: pass a deadline
  that ends before the platform stops the step.
- Store operations must be interruptible (for example `Effect.tryPromise` passing the
  `AbortSignal` to the driver). The ledger's timeouts interrupt the store operation and wait for
  it to stop, so they cannot cut uninterruptible work (an `Effect.uninterruptible` section, or a
  release or rollback that blocks): it holds the wait, heartbeat, or completion until it ends.
- Each `complete` attempt is bounded (`toolLedgerCompleteTimeoutMs`, 5 s; three attempts), and so is
  each `heartbeat` (a timed-out or failed heartbeat is logged; the next one still runs). A result or
  `ToolError` the call returned is recorded before an interruption takes effect (a `ToolError` also
  when its cause carries interruptions); defects, and interruption without a `ToolError`, record
  nothing. An outcome that cannot be recorded leaves the entry to read as abandoned.
- Set `abandonedResult({ call, entry, nested })` on a registration (or as a `makeTool` option) to
  describe that tool's abandoned call. It gets `nested: undefined` when `list` fails: report the
  nested calls as unavailable (they may have been applied), never as an empty list.
- Custom registration wrappers must forward `idempotencyKey` (and `nested`) to the inner
  `execute`. With a ledger configured, executors receive `idempotencyKey` for unledgered calls too.
- `onLedgerDecision({ key, parentKey?, toolName, decision, waitedMs? })` is called once per ledgered
  call with `fresh`, `completed`, `in_flight_wait` (waited, then replayed), `in_flight_timeout`,
  `abandoned`, or `conflict`, before the call runs or returns; `waitedMs` is set when it waited.
  Use it for logs and metrics. A throw or rejected promise is logged and ignored.
- `makeInMemoryToolLedgerStore` is for tests and single-process hosts; it does not survive
  restarts and cannot protect Workflow steps.

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
