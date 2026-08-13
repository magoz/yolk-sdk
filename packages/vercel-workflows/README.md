# @yolk-sdk/vercel-workflows

Vercel Workflow-specific contracts for durable agent model/tool step loops.

## Install

```bash
pnpm add @yolk-sdk/vercel-workflows@canary effect workflow
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Subpaths

| Subpath                               | Purpose                                                 |
| ------------------------------------- | ------------------------------------------------------- |
| `@yolk-sdk/vercel-workflows`          | Workflow-safe agent loop orchestration APIs             |
| `@yolk-sdk/vercel-workflows/workflow` | Explicit equivalent subpath                             |
| `@yolk-sdk/vercel-workflows/effect`   | Effect-native wrapper around public `workflow/api` APIs |

## Imports

Import Workflow APIs from the package root:

```ts
import {
  commitThenWriteTerminalEvent,
  makeDurableAgentEventSequencerState,
  noWorkflowStepRetry,
  runVercelAgentWorkflow,
  writeDurableAgentEvent
} from '@yolk-sdk/vercel-workflows'
```

The `./workflow` subpath is also exported for explicit imports.

Use `./effect` at host boundaries that start, replay, resume, or cancel Workflow runs:

```ts
import { Effect } from 'effect'
import { VercelWorkflows } from '@yolk-sdk/vercel-workflows/effect'

const program = Effect.gen(function* () {
  const workflows = yield* VercelWorkflows
  const run = yield* workflows.start(runAgentWorkflow, [{ request, context }])

  return yield* run.getReadable<Uint8Array>()
}).pipe(Effect.provide(VercelWorkflows.layer))
```

The API wrapper keeps Vercel's SDK underneath. It does not reimplement Vercel backend HTTP,
queues, hooks, or stream storage.

## Runtime model

`runVercelAgentWorkflow` coordinates host-provided callbacks:

- model step: produce model events/tool calls
- tool batch step: execute requested tools
- tool batch result: return one ordered tool-result message per host call, including failed `isError` results
- partial tool-step failure: return wire-safe `failure`, cumulative `usage`, and `eventSequence` when
  completed sibling tools must remain observable
- awaiting-input state: carry pending HITL hook data, wait through `awaitInput`, then rerun the
  same tool batch with accumulated responses
- close step: flush/close output stream after a successful final model step
- terminal status: completed, step failure, await-input failure, close failure, or max turns exceeded

Continuation state stays plain serializable data for Workflow persistence.

## Minimal workflow wrapper

Host apps keep concrete Workflow directives local and pass them into the package loop:

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

`runModelStep`, `runToolBatchStep`, `closeStream`, and `writeError` are host-owned
`'use step'` functions. Keep provider calls, tools, persistence, telemetry, and Effect runtimes in
those steps, not in the `'use workflow'` orchestration body.

## Awaiting input

When a tool batch needs HITL input, return `awaitingInput` from `runToolBatchStep`. The package
loop will:

1. pass that payload to `awaitInput`
2. wait for the hook/webhook response
3. rerun the same tool batch with `hitlResponses: [...previous, response]`

The host owns `hookToken` construction, auth, resume routes, and response decoding. Use stable
tokens that the resume side can reconstruct or store.

## Retry policy

Default retry policy is `noWorkflowStepRetry` (`maxAttempts: 1`). Retries are opt-in because
streamed retries can duplicate chunks unless host/client de-dupe is ready.
Finite `maxAttempts` values are floored and clamped to at least one; non-finite values normalize to
one. Retries have no built-in backoff.

`maxTurns` follows the same positive-integer boundary: finite values are floored and clamped to at
least one. Omitted or non-finite values use `defaultMaxWorkflowTurns`.

## Durable stream events

Workflow streams can replay old chunks after retries or reconnects. Durable streams should emit an
`eventId` on every JSON-serializable event, typically `AgentEvent`, including errors. Clients should
track seen ids.

Use `writeDurableAgentEvent` to assign deterministic ids and write NDJSON:

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

The id format is `${streamId}:${turn}:${eventSequence}`. Scope `streamId` to one logical durable
run (for example `workflow:${runId}`), not just one route or feature. Replay-safe clients de-dupe by
`eventId`; reusing a stream id across independent runs can make a follow-up run's live deltas look
like old replayed events. Keep `eventSequence` in Workflow state and reset it when starting a fresh
logical stream. Resume route reads should use `startIndex` when available. Host apps still own
active-run locking, stale-run guards, and cancellation behavior.

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
event:

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

`runVercelAgentWorkflow` calls `closeStream` only after `runModelStep` returns `done: true`. On model,
tool, await-input, or max-turn failure it calls `writeError` best-effort and returns without calling
`closeStream`; `writeError` must write a safe run-final error and attempt to close that failure path.
Never close on resumable `AgentAwaitingInput`.

## Host responsibilities

- Own Next/Vercel routes, auth, providers, tools, persistence, and telemetry.
- Encode/decode app transcript/session state into serializable Workflow inputs.
- Preserve tool result order and never advance the next model step with dangling host tool calls.
- Decide cancellation/resume/conflict UX.
- Own hook tokens and response validation for HITL resume.
- Emit replay-safe event ids for durable streams; scope stream ids per independent run and de-dupe
  by `eventId` client-side.
- Write durable terminal events only after host persistence has settled.
- Implement `closeStream` for successful final closure and `writeError` for safe final error write
  plus failure closure. Release, but do not close, the writer after `AgentAwaitingInput`.
- Test directive behavior with `@workflow/vitest` when changing package-owned Workflow files.

## Boundaries

- No Next routes, server actions, auth, app tools, DB, UI, or provider SDKs.
- Effect may run inside host/package step callbacks; workflow orchestration keeps plain data contracts.
