# @yolk-sdk/vercel-workflows

Vercel Workflow agent-loop contracts, durable stream helpers, an Effect-native Workflow client/layer,
and a Workflow-compatible runtime on Cloudflare Durable Objects.

## Install

```bash
pnpm add @yolk-sdk/vercel-workflows@canary effect@4.1.4 workflow@^5.0.0-beta.42
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.
Use the SDK's matching Effect version (`4.1.4`) in host code.
Requires Node.js 22+ and a server runtime supported by Vercel Workflow.
Keep one `ws` version installed (`@effect/platform-node` 4.1 needs ^8.22.1): two copies install
`@workflow/core` twice and the Workflow build fails with duplicate step ids.

Requires `workflow@^5.0.0-beta.42`. The 5.x line region-pins Vercel runs so durable streams are
served from the deployment's own region; the 4.x backend was `iad1`-only, which made deployed
streaming from other regions arrive in multi-second bursts. Host apps must resolve a single
`workflow` instance shared with this package.

## Subpaths

| Subpath                                            | Purpose                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `@yolk-sdk/vercel-workflows`                       | Workflow-safe agent loop orchestration APIs                                                |
| `@yolk-sdk/vercel-workflows/workflow`              | Explicit equivalent subpath                                                                |
| `@yolk-sdk/vercel-workflows/effect`                | Effect-native wrapper around public `workflow/api` APIs                                    |
| `@yolk-sdk/vercel-workflows/testing`               | `TestWorkflowWorld` behavioral platform emulator                                           |
| `@yolk-sdk/vercel-workflows/cloudflare`            | Workflow-compatible runtime on Durable Objects ([Cloudflare runtime](#cloudflare-runtime)) |
| `@yolk-sdk/vercel-workflows/cloudflare/workflow`   | Drop-in `workflow` module for Workers (alias `workflow` to it)                             |
| `@yolk-sdk/vercel-workflows/cloudflare/api`        | Drop-in `workflow/api` module for Workers: `start`, `getRun`, `resumeHook`                 |
| `@yolk-sdk/vercel-workflows/cloudflare/directives` | `workflowStep` / `workflowEntry`, imported by compiled directive code                      |
| `@yolk-sdk/vercel-workflows/cloudflare/vite`       | `workflowDirectives` Vite plugin that compiles `'use step'` / `'use workflow'`             |

## Imports

Import Workflow APIs from the package root:

```ts
import {
  commitThenWriteTerminalEvent,
  makeDurableAgentEventSequencerState,
  noWorkflowStepRetry,
  runVercelAgentWorkflow,
  VercelAgentWorkflowRunResult,
  WorkflowStepResult,
  writeDurableAgentEvent
} from '@yolk-sdk/vercel-workflows'
```

The `./workflow` subpath is also exported for explicit imports.

Use `./effect` at host boundaries that start, replay, resume, or cancel Workflow runs. This is a
host-wiring sketch; `runAgentWorkflow`, `request`, and `context` are host-owned values:

```ts
import { Effect } from 'effect'
import { VercelWorkflows } from '@yolk-sdk/vercel-workflows/effect'

const program = Effect.gen(function* () {
  const workflows = yield* VercelWorkflows
  const run = yield* workflows.start(runAgentWorkflow, [{ request, context }])

  return yield* run.getReadable<Uint8Array>()
}).pipe(Effect.provide(VercelWorkflows.layer))
```

`start` takes optional `{ attributes }`: plaintext, searchable run metadata seeded at creation
(Workflow run attributes). The platform validates them before the run exists and an invalid one
fails the start, so use identifiers, never secrets or content. A run started from inside a workflow
or step also gets the reserved `$parentRunId` and `$rootRunId` automatically.

The API wrapper keeps Vercel's SDK underneath. It does not reimplement Vercel backend HTTP,
queues, hooks, or stream storage.

## Test Workflow behavior

`@yolk-sdk/vercel-workflows/testing` provides `TestWorkflowWorld`, a behavioral emulator for host
tests. It covers run lifecycle, append-only streams (a write after close conflicts; closing again
succeeds, as on Vercel), step retries and attempt metadata, hooks/resume, cancellation, and the SDK
seam used by `VercelWorkflows.layerFromSdk`. Step errors cross the platform boundary as in a
deployment: each is stored with the installed `workflow` runtime's step-error serializer and the
workflow body sees only the value read back (error tags, prototypes and custom fields are lost; `cause` survives). A
FatalError (named `FatalError`, or with `fatal: true`; an `AbortError` is promoted to one) is never
retried, an exhausted step fails with the platform's FatalError wrapping the last error, and a
thrown value the platform cannot store (a class instance anywhere in its `cause` chain) is
redelivered like the platform does until the step exceeds its retries;
`world.inspect(runId).unstorableStepErrors` lists those values. `world.sdk.start` checks start
`attributes` with the installed runtime's validator (an invalid one rejects with a FatalError and
creates no run) and `world.inspect(runId).attributes` shows them (`{}` without any; the emulator
adds no `$parentRunId`/`$rootRunId`). Hooks follow the platform too: `resumeHook` succeeds for
every payload sent to a live hook, `await hook` reads the first, the rest are dropped when the hook
is disposed, and a token whose hook was disposed (or whose run ended) answers
`TestWorkflowHookNotFoundError` until a hook of any run takes it again. The emulator does not model
the platform's `HookConflictError` for a token another live hook holds, nor reading a hook more than
once. Executing a step loads the workflow runtime, so it needs the
Node test environment. Ambient module mocks do not apply retry policy by
themselves: wrap host step callbacks with `world.step(...)` or call `world.runStep(...)` explicitly
when the test must exercise platform retry attempts and `getStepMetadata().attempt`.

Mock the ambient `workflow` module so production orchestration runs against the active test world:

```ts
import { vi } from 'vitest'
import { TestWorkflowWorld } from '@yolk-sdk/vercel-workflows/testing'

vi.mock('workflow', async () => {
  const { testWorkflowModule } = await import('@yolk-sdk/vercel-workflows/testing')
  return testWorkflowModule
})

const world = new TestWorkflowWorld()
```

Tests whose import graph reaches `workflow` must use Vitest's Node environment, not jsdom, because
Workflow 5 captures Node `URL` intrinsics at import time. Hosts should test their own `'use workflow'`
and `'use step'` directive files with `@workflow/vitest` in addition to using the emulator.

## Runtime model

`runVercelAgentWorkflow` coordinates host-provided callbacks:

- model step: produce model events/tool calls
- no-tool continuation: when a model step returns `done: false` with no tool calls, continue
  directly to the next model step without invoking the tool-batch callback
- tool batch step: execute requested tools
- tool batch result: return one ordered tool-result message per host call, including failed `isError` results
- partial tool-step failure: return wire-safe `failure`, cumulative `usage`, and `eventSequence` when
  completed sibling tools must remain observable
- awaiting-input state: carry pending HITL hook data, wait through `awaitInput`, then rerun the
  same tool batch with accumulated responses
- close step: flush/close output stream after a successful final model step
- terminal status: completed, step failure, await-input failure, close failure, or max turns exceeded

`WorkflowStepResult` and `VercelAgentWorkflowRunResult` are `Data.taggedEnum` **values** (plain objects,
`_tag` last), re-exported from the package root and `./workflow`. `settleWorkflowStep` returns
`WorkflowStepResult.Success({ value })` / `.Failure({ error })`. Inspect run status with constructors
or `VercelAgentWorkflowRunResult.$is('Completed')` rather than handwritten `{ _tag }` objects.

Continuation state stays plain serializable data for Workflow persistence.

## Minimal workflow wrapper

Host apps keep concrete Workflow directives local and pass them into the package loop. The callback
names below are host-owned `'use step'` functions:

```ts
import { createHook } from 'workflow'
import { runVercelAgentWorkflow } from '@yolk-sdk/vercel-workflows'

export async function runAgentWorkflow(input: { request: unknown; context: unknown }) {
  'use workflow'

  return await runVercelAgentWorkflow({
    input,
    runModelStep,
    runToolBatchStep,
    closeStream,
    writeError,
    awaitInput: async awaitingInput => {
      using hook = createHook<unknown>({ token: awaitingInput.hookToken })

      return await hook
    }
  })
}
```

`runModelStep`, `closeStream`, and `writeError` are host-owned `'use step'` functions.
`runToolBatchStep` may instead be Workflow orchestration calling concrete per-call steps. Keep provider calls, tools, persistence, telemetry, and Effect runtimes in
those steps, not in the `'use workflow'` orchestration body.

## Tool steps are at-least-once

Vercel's queue delivers steps at least once. A tool-batch step can run again after a crash and,
in practice, concurrently with a first execution that is still running, even with
`noWorkflowStepRetry`. Retry policy cannot prevent duplicate writes; a durable tool ledger can.
This package does not build tool sets or call `runToolBatch` (your step does), so wire the ledger
where you resolve tools inside the step:

```ts
// Inside the host's tool-batch 'use step' function.
const resolveStepTools = Effect.gen(function* () {
  return yield* resolveTools(modules, context, {
    ledger: { store: makeRunToolLedger(workflowRunId), deadline: () => stepDeadlineMs }
  })
})
```

`resolveTools` and `ToolLedgerStore` come from `@yolk-sdk/agent/tools` (install
`@yolk-sdk/agent@canary` in the host; this package does not depend on it); `makeRunToolLedger` is
your durable store (for example Postgres) scoped to the Workflow run. Ledgered calls (by default every
non-`read` tool plus the built-in `subagent` tool, including code mode scripts and their nested
writes) then return their recorded result, wait for the running execution, or report that an
abandoned call may already have been applied; they never run twice under the same ledger key.
Add custom delegation tools with `isLedgered`. Input and interaction tools are never ledgered (they
rely on the host's `InteractionHost` receipts). Read calls still re-run, and after an in-flight
timeout the model may retry under a new call id. An in-memory store does not protect steps.
`deadline` bounds only waiting for a duplicate: recording a call's outcome can take up to about
15 s after the call returns, so leave that time before the function budget ends, and keep store
operations interruptible (the ledger's timeouts cannot cut uninterruptible store work).

## Independent children

`orchestrateWorkflowToolBatch` runs a full-batch `preflight` before any `execute` callback,
limits local concurrency, and returns results in original call order. Both callbacks are host
seams: perform IO in steps, not in the orchestration helper. The host commits exactly one tool
result per call. Return a pause value from preflight when any HITL request is pending.
If an execution rejects, the helper stops dispatching new calls, settles already-active siblings,
and returns their ordered progress plus `failures`. Hosts must propagate those failures while
retaining completed results and usage; do not treat a partial batch as successful.

Start child workflows with Workflow 5 `start(childWorkflow, args)` **from orchestration**, not
inside the parent tool step. A child wrapper runs its own model/tool steps and returns a typed
application outcome; platform `completed` alone does not prove application success. Foreground
hosts await that child outcome; background hosts return an accepted handle and continue.

`awaitWorkflowChild({ read, sleep })` polls short durable read steps with a host-provided Workflow
`sleep` between reads. Both callbacks receive the same zero-based attempt index, so hosts can
apply capped backoff and end an observation after a bounded number of reads. At that ceiling,
`read` should return `{ done: true, value: stillRunningObservation }`; this ends polling, not the
child lifecycle. Preserve an owned handle for eventual result lookup. Existing zero-argument
callbacks remain supported and the helper has no implicit budget. Hosts must explicitly bound
long waits to avoid unbounded durable event accumulation. Do not hold a step open awaiting a long
`run.returnValue` poll.

Hosts own immutable logical reservations, admission/CAS, ownership checks, storage, bounded
fanout, safe errors, credentials, and cancellation policy. Parent completion/failure must not
implicitly cancel independent children. Explicit Stop should persist a durable tombstone before
sweeping admitted child ids, reject late admission, and expose partial sweep failures for retry.
Give each independent stream and parallel call its own deterministic event-id namespace.

## Awaiting input

When a tool batch needs HITL input, return `awaitingInput` from `runToolBatchStep`. The package
loop will:

1. pass that payload to `awaitInput`
2. wait for the hook/webhook response
3. rerun the same tool batch with the accumulated responses in a fresh `hitlResponses` array and
   the requests of the pause being resumed as `awaitingRequests` (absent on the first attempt)

Forward `awaitingRequests` to the agent loop's `prepareToolBatch`/`runToolBatch`: an unanswered
approval then stays pending even when its tool's policy changed since the pause.

The loop owns its accumulator: host mutation of a supplied array cannot affect a later batch.
Response order and element identity are preserved; response objects are not deep-cloned.

The host owns `hookToken` construction, auth, resume routes, and response decoding. Two platform
rules shape them:

- **One token per pause.** A disposed hook's token is free again, and `resumeHook` routes by token
  alone. A token that several pauses share (one per run or session) delivers a late duplicate of
  an earlier answer (a client retry, a double submit) to the next pause as its answer. Give every
  `awaitingInput` a token no earlier pause of the run used, for example
  `hitl:${runId}:${input.turn ?? 0}:${input.hitlResponses?.length ?? 0}` (the turn and how many
  answers the batch already took; a token built only from pending request ids repeats when a
  request re-pends after an invalid answer). Store it with the pending state you persist before
  `AgentAwaitingInput`, and resume the stored pause that holds the request being answered. The loop
  does not check tokens. Filtering answers by request id inside `awaitInput` (discard one no
  pending request matches and wait again) also keeps a late duplicate out of the batch, but answers
  that reached the hook behind the discarded one are dropped with it, so the rule still applies.
- **`resumeHook` success does not mean the answer was used.** A hook accepts every payload until
  the workflow disposes it, and `resumeHook` succeeds for each; the `awaitInput` above reads the
  first, and the rest are dropped with the hook. So before resuming, admit only an answer to a
  request the stored pause still holds and record it durably for that pause (an identical retry
  reuses the record; a different answer is refused), then report what was recorded, not what
  `resumeHook` returned. Give each payload the request id it answers.
- **`HookNotFoundError` means no hook is resumable under that token now.** The hook may not exist
  yet (the tool step writes `AgentAwaitingInput` before the workflow replays and calls
  `createHook`, so a fast client can get there first), the token may be wrong, or the hook was
  disposed (its answer used, perhaps by an earlier attempt of this same resume) or its run ended.
  While the stored pause is still pending, retry resuming the recorded answer a bounded number of
  times; once the pause has moved on, report the recorded answer as delivered, not as an error.

## Retry policy

Default retry policy is `noWorkflowStepRetry` (`maxAttempts: 1`) for model, tool-batch and
await-input steps. Their retries are opt-in because a retried step streams its events again.
`eventId` de-dupe alone does not make that safe: a retried model step writes a different answer from
the same `eventSequence`, so give its live events an `executionId`
([Durable stream events](#durable-stream-events)).

The close step defaults to `defaultCloseStreamRetry` (`maxAttempts: 3`). `closeStream` only closes
the writer (`AgentEnd` is written before it, by the final model step), and closing a Workflow stream
is idempotent on Vercel, so a close-only step's retry writes nothing. The platform already
redelivers a close step whose function died; the loop retry matters after the step's platform
attempts are used up, when the close was applied but the step still failed (for example its
completion was lost): a later attempt that succeeds completes the run instead of reporting
`CloseStreamFailed` for a stream the client saw end. The loop retries any rejection, a `FatalError`
thrown by `closeStream` too. Keep `closeStream` close-only and safe to repeat; pass
`closeStreamRetry: noWorkflowStepRetry` to close once.

Finite `maxAttempts` values are floored and clamped to at least one; non-finite values normalize to
one. Retries have no built-in backoff.

One attempt does not stop queue redelivery or platform step retries (`fn.maxRetries`): a step can
still run again after a failure or crash, or concurrently. See
[Tool steps are at-least-once](#tool-steps-are-at-least-once).

`maxTurns` follows the same positive-integer boundary: finite values are floored and clamped to at
least one. Omitted or non-finite values use `defaultMaxWorkflowTurns`.

## Durable stream events

Workflow streams can replay old chunks after retries or reconnects. Durable streams should emit an
`eventId` on every JSON-serializable event, typically `AgentEvent`, including errors. Clients should
track seen ids.

Use `writeDurableAgentEvent` to assign deterministic ids and write NDJSON. The following is an
`Effect.gen` fragment; `writer`, `event`, `runId`, `turn`, and `eventSequence` are host-owned:

```ts
const state = makeDurableAgentEventSequencerState(eventSequence)
const sequenced =
  yield *
  writeDurableAgentEvent({
    writer,
    event,
    streamId: `workflow:${runId}`,
    turn,
    state
  })

eventSequence = sequenced.nextEventSequence
```

A rejected write fails with `DurableAgentEventWriteError`: its `message` is the rejection's message
(or `String(rejection)`), and `cause` is the rejection itself.

The id format is `${streamId}:${turn}:${eventSequence}`, or
`${streamId}:${turn}:${eventSequence}:${executionId}` when `executionId` is set. Scope `streamId` to
one logical durable run (for example `workflow:${runId}`), not just one route or feature.
Replay-safe clients de-dupe by `eventId`; reusing a stream id across independent runs can make a
follow-up run's live deltas look like old replayed events. Keep `eventSequence` in Workflow state
and reset it when starting a fresh logical stream. Resume route reads should use `startIndex` when
available. Host apps still own active-run locking, stale-run guards, and cancellation behavior.

### One step, several executions

A step can run more than once: opt-in loop retries (`modelStepRetry`), platform retries
(`fn.maxRetries`), and queue redelivery, which can run beside an execution that is still streaming.
Every execution starts from the same `eventSequence`. A model step's second execution calls the
model again and streams a different answer, so without more the same ids carry different events and
a client de-duping by `eventId` keeps the first execution's early deltas plus the second's tail.

Pass an `executionId` unique per execution, and pass it on exactly the events the model call
produces: every event from `LLMStreamStart` through `AssistantMessage`/`UsageUpdate` (deltas, tool
input, provider tool results). `LLMStreamStart` must carry it: it is identical in every execution,
so with a plain id the second start would be de-duped and the client could not tell the executions
apart. `${stepId}:${attempt}` from `workflow`'s `getStepMetadata()` is unique per execution: a loop
retry is a new step id, and each platform retry or redelivery a new attempt. The sequencer appends
it to the id and sets it as the event's `executionId` field (removed without it). Every written event
also carries the `streamId` field, so clients keep each run's turns apart and a terminal event
closes its own run (never parse either from the id: both contain `:`). Both must be non-empty
without surrounding whitespace when `executionId` is set, or sequencing throws; without it, a blank
or padded `streamId` is only left off the event.

Leave it off host events every execution writes identically: a promoted user message, and the
terminal event written after the host commits (`commitThenWriteTerminalEvent`). A re-execution that
finds a committed receipt replays only that terminal event (same plain id, so the client drops the
repeat); it never rewrites the live events, whose ids carried the original execution. Without
`executionId` ids keep the plain format, so stored ids and events written before do not change.
Tool-batch steps are out of scope: their events keep plain ids, which is safe only where every
execution writes the same events. Ledgered tool calls replay their recorded result; read calls are
not ledgered and run again, so a re-executed batch can write a different result under the same id.

```ts
const { stepId, attempt } = getStepMetadata()
const executionId = `${stepId}:${attempt}`

yield * writeDurableAgentEvent({ writer, event, streamId, turn, executionId, state })
```

`@yolk-sdk/agent` clients (`reduceAgentEvents`, `applyAgentEventToChatProjection`, the
`useAgentChat` reducer) route events by those fields, per run (`streamId`) and turn
(`LLMStreamStart.turn`):

- When a newer execution of the same turn starts, the older one is superseded: its output is
  provisional and removed (streaming text, its `AssistantMessage`, and each tool call it touched
  that no host event acted on yet), and its later events are dropped. A call or earlier message it
  overwrote through a provider's reused call id is restored.
- A later turn's start, another run's start, a terminal event, a user message or `AgentStart`
  settles executions: their output stays and their later events (a losing concurrent execution)
  are dropped. Only executions of earlier turns or other runs are settled by a start.
- Only terminal events close a run: after `AgentEnd` or `AgentError` every start in it is stale,
  and after `AgentAwaitingInput` a start at or below the paused turn is (the resumed run starts a
  higher one). A start for a turn older than one its run already started is stale too. A stale
  start and its later events are dropped. The client records a terminal's run from its `streamId`
  even when it saw no execution of that run; a terminal without `streamId` closes the runs still
  streaming. `AgentStart` begins a fresh run, even under a reused `streamId`.
- At `AgentEnd` and `AgentAwaitingInput`, each turn of the run in which a newer execution
  superseded an older one, and that shows an answer other than the committed one, shows the
  committed assistant message from the event's `messages` in its place, keeping the state of its
  tool calls (a completed call stays completed, a pending question stays pending); the shown
  execution's calls that no host event acted on are removed. The committed answer is the one among
  `messages` that an execution of the turn streamed; when none is found, the final turn falls back
  to the last assistant message and an earlier turn keeps what it shows. The turn's answer stays in
  its place (a user message after it stays after it), and a later turn's output never changes the
  messages its executions created.
  Until that event, a non-final turn whose older execution committed while the newer one streamed
  shows the newer answer, beside the calls the tool batch ran; `AgentError` carries no messages and
  reconciles nothing (see the limits under "Open cases").
- Events without `executionId` keep the plain behaviour: the next `LLMStreamStart` only discards
  output still streaming.

Host duties:

- Upgrade clients and server together: a client before this release ignores the fields and shows
  both executions' output back to back.
- Use a `streamId` unique per workflow run (for example `workflow:${runId}`), unless the stream
  emits `AgentStart` at each run: a run's ended state sticks to its `streamId`, so a later run that
  reuses it without `AgentStart` has every start dropped. With unique `streamId`s, projection hosts
  that keep one state across runs need nothing more; without `streamId` every run shares one scope,
  so reset `executions` to `[]` when a new run starts.
- Write `AgentError` only from the final failure path (`writeError`), never before a retry: an
  `AgentError` ends its run for good, and every later start in it is dropped.
- Feed one state one run at a time: two runs streaming tagged events into one state at once are
  unsupported (each run's start settles the other's live execution).
- `reduceAgentEvents` keeps a single draft buffer (`text`, `reasoning`): every `LLMStreamStart`
  clears it, so a stopped run's unfinished draft is not kept there (the chat projections keep it).

Open cases:

- Limits of the reconcile at `AgentEnd` / `AgentAwaitingInput`. Clients show both answers of a turn
  when a user message arrived between its two executions: one retried after a user message settled
  the first is never treated as a turn that ran twice. This includes a promoted steer written with a
  new `eventId` between two executions of a turn; hosts that replay a promoted steer under a
  deterministic `eventId` (de-duplicated by the client) are not affected. A client that connects
  mid-turn never saw the earlier execution's start, so its events take the plain path. The committed
  answer is matched by value among the run's messages, not per turn: an uncommitted answer equal to
  another committed message of the run (same text, same call ids) counts as committed. Tool events
  find a call by id, so a provider that reuses call ids across turns can have a later turn's call
  update an earlier turn's call of that id (#335). A turn kept for reconciling protects the messages
  its executions created, not an earlier message one of them overwrote through a reused id. A client
  that never saw a later turn's start (it joined late) also has no bound on where that turn ends.
- A terminal written on a namespaced child stream (for example `workflow:<run>:tool:<ns>`) closes
  only that stream's run, not the main run's turns. A late start from a losing execution of the
  main run's paused turn is then not fenced by that terminal.

## Terminal barriers

For durable host streams, protocol terminal events are commit barriers. Emit live/progress events
first, commit canonical host state, then write the event.

“Terminal” in `isTerminalAgentEvent` means a logical client-consumption boundary, not necessarily a
final Workflow state. Final callback ownership is:

```txt
AgentEnd: durable completion commit -> AgentEnd -> closeStream
AgentError: failure commit/mapping -> AgentError -> writeError-owned close
```

`AgentAwaitingInput` is terminal for the current client consumption window but resumable for the
Workflow run. Persist pending HITL state and write it without finalizing the durable stream solely
because `isTerminalAgentEvent` returns true:

```txt
persist pending HITL -> AgentAwaitingInput -> release writer lock (do not close) -> await hook -> continue
```

This lets clients stop consuming at a protocol-terminal event and immediately revalidate or reconnect
from durable state. Hosts that emit terminal events before persistence should not rely on
`streamAgentEventStreamUntilTerminal()` as a durable-settled signal.

Use `commitThenWriteTerminalEvent` when a step must commit host state before writing its terminal
event. This is an `Effect.gen` fragment whose terminal, persistence, writer, and stream values come
from the host:

```ts
const result =
  yield *
  commitThenWriteTerminalEvent({
    terminal,
    commit: persistState,
    write: event => writeDurableAgentEvent({ writer, event, streamId, turn, state }),
    writeCommitError: error =>
      writeDurableAgentEvent({ writer, event: commitErrorEvent(error), streamId, turn, state })
  })
```

The helper never writes the success terminal before `commit` succeeds. If `commit` fails, it writes
the host-provided terminal error event instead. It can protect either a final event or an
`AgentAwaitingInput` persistence barrier; it never decides closure from `_tag` and never closes
writers.

`writeCommitError` receives the existing `CommitError` generic from `commit`
(`Effect.Effect<void, CommitError>`), via `Effect.matchEffect` `onFailure`. Typed failures—not
defects or interruptions—are passed to that callback. Result `commitError` and `error` fields stay
`unknown`.
Existing `(error: unknown) => …` callbacks remain assignable.

`runVercelAgentWorkflow` calls `closeStream` only after `runModelStep` returns `done: true`. On model,
tool, await-input, or max-turn failure it calls `writeError` best-effort and returns without calling
`closeStream`; `writeError` must write a safe run-final error and attempt to close that failure path.
Never close on resumable `AgentAwaitingInput`. `CloseStreamFailed` means every close attempt failed,
but a close can be applied while its step still fails: the stream may already carry the committed
`AgentEnd`, so a `writeError` that records a failure must not replace a committed completion. Check
for the run's committed completion (or compare-and-set against it) before recording the failure.

## Cloudflare runtime

The `./cloudflare*` subpaths run code written for Vercel Workflow (`'use workflow'`, `'use step'`,
`workflow`, `workflow/api`) on Cloudflare Workers, with no Vercel backend. Each run executes in its
own `WorkflowRun` Durable Object:

- The workflow body runs in memory in the run's object. Every step outcome, hook payload, and fired
  sleep is journaled in the object's SQLite storage under its id and call count, so after an
  eviction the body replays to where it was without re-running finished steps. Values cross as
  devalue text (as on Vercel: `Date`, `Map`, `Set`, typed arrays, `undefined`, and errors with name,
  message, stack, cause, `fatal`, and `retryAfter`).
- Steps are at-least-once: a step cut off by an eviction runs again when the object's step guard
  alarm (every 30 s while a step runs) replays the run. A step function's `maxRetries` (default 3)
  bounds retries with exponential backoff (1 s doubling, at most 30 s); `RetryableError` waits until
  its `retryAfter`; `FatalError` is never retried; an exhausted step throws a `FatalError` with the
  last error as `cause`, as the platform does.
- `createHook({ token })` registers the token in a hook-index instance (`hook:<token>`) that
  `resumeHook` reads. Without a token, the token is `<runId>:hook#<n>`, the same on every replay.
  `resumeHook` rejects with `HookNotFoundError` when no run waits on the token.
- `sleep(duration)` is durable: its wake time is stored on first execution and armed as the
  object's alarm.
- `getWritable()` inside a step appends to the run's stream, stored in the object;
  `getRun(id).getReadable({ startIndex })` follows it live, and its `getTailIndex()` is the last
  chunk's index. A negative `startIndex` counts from the end.
- `run.cancel()` ends the run where it waits; `returnValue` then rejects with
  `WorkflowRunCancelledError`.

Supported `workflow` surface: `createHook`, `sleep`, `getWritable`, `getStepMetadata`,
`getWorkflowMetadata`, `FatalError`, `RetryableError`. `workflow/api`: `start`, `getRun`,
`resumeHook` (`start` accepts and ignores `attributes`). Other Vercel Workflow APIs (`defineHook`,
webhooks, `fetch`) are not provided.

### Wire a Worker

The Worker needs the `nodejs_compat` compatibility flag (the runtime uses `AsyncLocalStorage`), a
Durable Object binding named `WORKFLOW_RUNS` (`workflowRunsBinding`) to the `WorkflowRun` class,
declared as a SQLite class in its migrations (`new_sqlite_classes: ["WorkflowRun"]`), and its
Worker entry must export the class:

```ts
// worker.ts
import { registerWorkflowModules } from '@yolk-sdk/vercel-workflows/cloudflare'

export { WorkflowRun } from '@yolk-sdk/vercel-workflows/cloudflare'

// Workflow modules load when a run needs them: evaluating a large runtime in the Worker's global
// scope can exceed its startup CPU limit. Keys are module paths relative to the Vite root.
registerWorkflowModules({
  'app/agent-workflow.ts': () => import('./app/agent-workflow.ts')
})
```

Compile the directives and point `workflow` and `workflow/api` at the Cloudflare modules in every
server environment (host code and packages, this one included, import them):

```ts
// vite.config.ts
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { workflowDirectives } from '@yolk-sdk/vercel-workflows/cloudflare/vite'

const cloudflareModule = (subpath: string) =>
  fileURLToPath(import.meta.resolve(`@yolk-sdk/vercel-workflows/cloudflare/${subpath}`))

const workflowModules = new Map([
  ['workflow', cloudflareModule('workflow')],
  ['workflow/api', cloudflareModule('api')]
])

const cloudflareWorkflow = (): Plugin => ({
  name: 'app:cloudflare-workflow',
  enforce: 'pre',
  resolveId(source) {
    return this.environment.name === 'client' ? null : (workflowModules.get(source) ?? null)
  }
})

export default defineConfig({
  plugins: [cloudflareWorkflow(), workflowDirectives() /* , your Cloudflare/framework plugins */]
})
```

`workflowDirectives({ root, runtime })` compiles top-level `async function` declarations whose
body starts with `'use step'` or `'use workflow'` in every environment but `client`, outside
`node_modules`. A workflow's id is `<module path relative to root>#<name>` (`root` defaults to
Vite's root): runs store it, so renaming or moving a workflow module strands its in-flight runs.
`runtime` defaults to `@yolk-sdk/vercel-workflows/cloudflare/directives`.

All `./cloudflare*` modules share the run context and the workflow registry, so a Worker must load
each of them once: resolve them to the same package files (do not let a dependency pre-bundle copy
one of them).

`WorkflowExecution`, `makeMemoryRunStore`, and `makeSqliteRunStore` are exported for hosts that
drive a run themselves (tests, another single-writer host): `WorkflowExecution` runs one run over
a `RunStore` and an `ExecutionHost` (alarms, hook registration, stream fan-out, settlement).

## Host responsibilities

- Own Next/Vercel routes, auth, providers, tools, persistence, and telemetry.
- Encode/decode app transcript/session state into serializable Workflow inputs.
- Preserve tool result order and never advance the next model step with dangling host tool calls.
- Decide cancellation/resume/conflict UX.
- Own hook tokens and response validation for HITL resume.
- Emit replay-safe event ids for durable streams; scope stream ids per independent run, give a
  model step's live events an `executionId` per execution, and de-dupe by `eventId` client-side.
- Write durable terminal events only after host persistence has settled.
- Implement `closeStream` for successful final closure and `writeError` for safe final error write
  plus failure closure. Release, but do not close, the writer after `AgentAwaitingInput`.
- Test host-owned Workflow directive files with `@workflow/vitest`; use the `./testing` emulator for
  platform behavior in host tests.

## Boundaries

- No Next routes, server actions, auth, app tools, DB, UI, or provider SDKs.
- Effect may run inside host/package step callbacks; workflow orchestration keeps plain data contracts.
- The `./cloudflare*` runtime never imports the `workflow` packages (hosts alias them to it).
  `./cloudflare` and `./cloudflare/api` import `cloudflare:workers`, so they load only in a Worker;
  `./cloudflare/workflow` and `./cloudflare/directives` need `node:async_hooks` (`nodejs_compat`);
  `./cloudflare/vite` runs in Vite on Node.
