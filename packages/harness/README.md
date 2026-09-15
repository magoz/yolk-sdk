# @yolk-sdk/harness

Domain-free **run lifecycle** for Yolk agents: who owns a live run, how wakes coalesce, and how
claims survive a crash. The model/tool loop stays in `@yolk-sdk/agent/loop`.

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Install

```bash
pnpm add @yolk-sdk/harness@canary effect@4.0.0-beta.80
```

## Subpaths

| Subpath                                   | Purpose                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `@yolk-sdk/harness`                       | Tiny root                                                                                               |
| `@yolk-sdk/harness/coordinator`           | Process-local doorbell coordinator                                                                      |
| `@yolk-sdk/harness/store`                 | `RunStore` claim/release                                                                                |
| `@yolk-sdk/harness/inbox`                 | Admission / steer / queue items; in-memory HITL park tokens (not durable)                               |
| `@yolk-sdk/harness/driver`                | `Driver` + `makeHarness`                                                                                |
| `@yolk-sdk/harness/driver/memory`         | In-memory driver for tests                                                                              |
| `@yolk-sdk/harness/driver/durable-object` | Durable Object storage-backed claims + driver                                                           |
| `@yolk-sdk/harness/outcome`               | Classify one model/tool attempt: Completed / Retry / Continue / RecoverFull / Compacted / AwaitingInput |

## Tagged constructors

Inbox, driver, and outcome ADTs are `Data.taggedEnum` **values** on the existing subpaths. They are
plain objects with `_tag` last, not `Equal`/`Hash` Data classes.

```ts
import {
  DrainBegin,
  HitlDecision,
  PauseDecision,
  RecoveryAdmission,
  RecoveryAttempt
} from '@yolk-sdk/harness/inbox'
import { StopDecision } from '@yolk-sdk/harness/driver'
import { HitlMatch, OverflowCompactionResult, StepOutcome } from '@yolk-sdk/harness/outcome'
```

| Subpath   | Value constructors                                                                    |
| --------- | ------------------------------------------------------------------------------------- |
| `inbox`   | `HitlDecision`, `PauseDecision`, `RecoveryAttempt`, `RecoveryAdmission`, `DrainBegin` |
| `driver`  | `StopDecision` (`Idle` / `Interrupted` / `ParkCleared`)                               |
| `outcome` | `OverflowCompactionResult`, `StepOutcome`, `HitlMatch`                                |

`StopDecision` is the same internal tagged enum, re-exported as `export type` + `export const` from
`./driver`. Driver recovery uses Inbox `RecoveryAttempt` (`Skip` / `Exhausted` / `Resume`). Prefer
`Match.tag` / `Predicate.isTagged` over `_tag ===`. `HitlMatch.Match({ requestId })` /
`HitlMatch.Mismatch()` replace handwritten `{ _tag: 'Match' | 'Mismatch' }` objects.

## Example

Omitting `drain` uses a no-op (`Effect.void`): `driver.run` only claims and releases ownership. Attach host work with a custom drain. `Inbox.takePromotable` requires that drain's live `drainToken`.

`@yolk-sdk/harness` is introduced after `0.1.0-canary.76`. It is unavailable in `0.1.0-canary.76` and earlier. Choose a newer matching canary once available.

Setup:

```bash
pnpm add @yolk-sdk/harness@canary effect@4.0.0-beta.80
pnpm add -D tsx
```

Filename: `drain-example.mts`

```ts
import { Effect } from 'effect'
import { admit, Driver, type Drain } from '@yolk-sdk/harness/driver'
import { makeInMemoryHarnessLayer } from '@yolk-sdk/harness/driver/memory'
import { Inbox } from '@yolk-sdk/harness/inbox'

const drain: Drain = (runId, _force, scope, context) =>
  Effect.gen(function* () {
    const inbox = yield* Inbox
    const item = yield* inbox.takePromotable(runId, scope, context.drainToken)
    if (item === undefined) {
      yield* Effect.sync(() => {
        console.log(`no work for ${runId}`)
      })
      return
    }
    yield* Effect.sync(() => {
      console.log(`drained ${item.id} for ${runId}`)
    })
  })

const program = Effect.gen(function* () {
  yield* admit({
    id: 'item_1',
    runId: 'run_1',
    delivery: 'input',
    kind: 'input'
  })
  const driver = yield* Driver
  yield* driver.awaitIdle('run_1')
}).pipe(Effect.provide(makeInMemoryHarnessLayer({ drain })))

await Effect.runPromise(program)
```

Run:

```bash
pnpm exec tsx drain-example.mts
```

Expected output:

```txt
drained item_1 for run_1
```

Durable Object claim persistence requires host `load` / `save` callbacks on `makeDurableObjectDriverLayer`. That snapshot stores claimed ids and resume counts. Its Inbox is still in-memory and does not persist queued input, parked HITL, host closures, or transcript storage.

Hosts still own tools, prompts, auth, HITL payload persistence, and `'use workflow'` / `'use step'` files. Durable Object claims ship as `@yolk-sdk/harness/driver/durable-object`. There is no Vercel Workflow driver in this package and no hook registry or `World`.

`Driver.pause` / `resumeHitl` / `stop` compose HITL onto the existing coordinator. Inbox items have no payload. Protocol match helpers live in `@yolk-sdk/harness/outcome`. Parked waits are not durable and are not shutdown claims.

## Restart contract

Ownership is per shared Driver instance. The host or platform supplies cross-process exclusivity and quiesces producers before closing that instance. Raw administrative `RunStore` mutations must be quiesced with Driver; runtime claim ownership belongs to Driver.

Startup is explicit: build the shared Driver/Inbox/Store, restore host-owned waiting checkpoints through `run` / `pause`, then call `Driver.resumeSuspended` before exposing ingress.

`resumeSuspended` is a finite current-snapshot sweep. Candidate IDs are hints, not durable incarnation IDs. Under the Inbox admission gate it rechecks live coordinator activity then the current claim, skips blocked parks, and charges a validated `maxResumeAttempts` budget before granting pending input. Stop with no newer intent skips; a later idle claimed run with the same id may recover the current host checkpoint only. The sweep does not wait for drain settlement while holding that gate.

`maxResumeAttempts` is a finite nonnegative safe integer. The default is 10. Exhausted eligible claims are released and those IDs are returned in `exhausted`. Active candidates and candidates with blocked parks are skipped and are not released. `0` schedules, drains, and increments nothing: the sweep still releases eligible candidates as exhausted. Zero is not a nonmutating pause that preserves those claims. Omitted args, whole options `undefined`, or explicit `undefined` `maxResumeAttempts` keeps Layer `E = never`. A numeric or `number | undefined` config types `InvalidMaxResumeAttempts` and fails Layer init for invalid values.

`wake` / `resumeSuspended` schedule work; `awaitIdle` is quiescence, not a success receipt. `run` observes start and settlement failures. A failed `started` claim must not automatically release a prior or never-acquired claim. Explicit user-terminal authority (`Driver.stop` or generic `interrupt` defaulting to `user`) still releases a leftover claim after that owner has actually settled. Shutdown interrupt keeps the claim.

### HITL contract

- Hosts persist typed HITL payloads by `itemId`. Inbox stores only opaque generation, request ids, and response item ids.
- Resume requires the current park generation plus `outcome.matchHitlResponse` / `resumeHitlIfMatched` kind/request/tool-call identity. Mismatch never wakes.
- All sibling request ids must be answered before continuation. Partial accepts do not start a tool drain.
- Host drain receives `DrainContext.drainToken` and `readyResponses`. Pause with that token; do not park from a stale token. `Inbox.takePromotable(runId, scope, drainToken)` also requires that live token and dequeues only while it still owns the run. Missing, empty, inactive, stale, or wrong-run tokens return `undefined` and leave the queue unchanged. This canary signature is intentionally required; there is no optional/unchecked take.
- `Inbox.beginDrain(runId, scope)` and `wakeIfUnblocked(runId, scope, wake)` are scope-aware. Pending input subsumes steer. A steer drain does not consume a later input intent, so an input admitted after Coordinator captures steer still drains.
- A successful drain that leased a Ready generation acknowledges and clears those refs. Failure or interruption keeps them (at-least-once). Host side effects must be idempotent.
- Human pause releases the busy claim. User `stop` is terminal at the captured owner's settlement (including shutdown then user-stop). Shutdown interrupt keeps the claim. The Durable Object snapshot claim store does not make Inbox durable.
- After process restart, hosts enumerate their own persisted waiting checkpoints and rebuild a fresh park with the current drain token. Do not import old Inbox parks, drain tokens, or generation strings. Correlate later responses to the new park and host identity policy. Persisted partial responses may be re-admitted only after protocol/host validation against that fresh park.

## Type imports (breaking)

Runtime/wire is unchanged. These public type exports were renamed; there are no `Shape` aliases.

```ts
import type { RunStoreApi } from '@yolk-sdk/harness/store'
import type { InboxApi } from '@yolk-sdk/harness/inbox'
import type { DriverApi } from '@yolk-sdk/harness/driver'
```

| Old type import                                | New type import |
| ---------------------------------------------- | --------------- |
| `RunStoreShape` from `@yolk-sdk/harness/store` | `RunStoreApi`   |
| `InboxShape` from `@yolk-sdk/harness/inbox`    | `InboxApi`      |
| `DriverShape` from `@yolk-sdk/harness/driver`  | `DriverApi`     |

## Owner layers

Each service is acquired through its owning static layer factory, which holds the real
construction logic. The historical `make*` factories keep their signatures and behavior
and delegate to these canonical owners:

| Canonical owner layer                                                                                                                 | Backward-compatible factory                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `RunStore.inMemoryLayer()` / `snapshotLayer()`                                                                                        | `makeInMemoryRunStoreLayer` / `makeSnapshotRunStoreLayer`                                       |
| `Inbox.layer()`                                                                                                                       | `makeInMemoryInboxLayer`                                                                        |
| `RunCoordinator.layer()` (claims via `RunStore`)                                                                                      | `makeCoordinator` stays as the scoped doorbell factory                                          |
| `Driver.layer()` (requires `RunStore` + `Inbox` + `RunCoordinator`) + `Driver.coordinatedLayer()` (default coordinator, lazy options) | `makeDriverLayer` delegates to `coordinatedLayer`, keeping the `RunStore` + `Inbox` requirement |

Every factory call builds fresh layers, so composed harnesses never share `Ref` state.
Within one composed harness, the driver and the merged output share a single store
instance. `InterruptReason` is owned by `@yolk-sdk/harness/coordinator` and re-exported
from `@yolk-sdk/harness/driver`.

## Step outcomes

`attemptModelTurn` classifies **one `runModelTurn` invocation** after that stream's configured loop/provider retries. It does not add another retry loop or persist. Hosts that schedule physical attempts themselves should pass `LoopConfig.maxRetries: 0` and skip retry decorators.

`attemptToolBatch` sets `needsContinuation` when the batch executed calls (the next step is a model turn). `runToolBatch` fences all execution when any HITL request is pending, so `AwaitingInput` does not carry executed sibling calls.

| Owner                                         | What it retries                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `@yolk-sdk/agent/loop` `run` / `runModelTurn` | Generic retryable LLM errors (`LoopConfig.maxRetries`) inside the invocation                                       |
| `makeContextOverflowRetryProvider`            | In-process overflow, silent compact-and-retry **once per provider stream**, and only before published output       |
| Harness `Compacted`                           | Durable persist-then-retry. Host stores compacted messages plus `overflowCompactionAttempt` and re-enters the step |

Pass `overflowCompactionAttempt` (default `0`). A successful compact returns `attempt + 1`. Compact is allowed only while `attempt < 1`. Invalid/negative/nonfinite counts fail as `validation_error`. If the host omits or resets the count, there is no cross-invocation budget.

Do not persist `ContextTransformer` checkpoints. Do not wrap the provider in `makeContextOverflowRetryProvider` and also treat `Compacted` as durable compaction on the same path.

Incomplete streams (`LLMError.responseIssue === 'missing_done'`, still `invalid_response` / `retryable: false`) become `RecoverFull` before output or `Continue` after partial text/reasoning/completed calls. Content-filter and other nonretryable provider terminals stay failed. `onEvent` sink errors and compact/Abort errors are not classified as provider failures. `Continue` does not invent message IDs or execute tools.
