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

## Example

```ts
import { Effect } from 'effect'
import { Driver } from '@yolk-sdk/harness/driver'
import { makeInMemoryHarnessLayer } from '@yolk-sdk/harness/driver/memory'
import { RunStore } from '@yolk-sdk/harness/store'

const program = Effect.gen(function* () {
  const driver = yield* Driver
  yield* driver.run('run_1')
  const store = yield* RunStore
  yield* store.isClaimed('run_1')
}).pipe(Effect.provide(makeInMemoryHarnessLayer()))
```

Hosts still own tools, prompts, auth, HITL payload persistence, and `'use workflow'` / `'use step'` files. Durable Object claims ship as `@yolk-sdk/harness/driver/durable-object`; that factory's Inbox is still in-memory. There is no Vercel Workflow driver in this package and no hook registry or `World`.

`Driver.pause` / `resumeHitl` / `stop` compose HITL onto the existing coordinator. Inbox items have no payload. Protocol match helpers live in `@yolk-sdk/harness/outcome`. Parked waits are not durable and are not shutdown claims.

### HITL contract

- Hosts persist typed HITL payloads by `itemId`. Inbox stores only opaque generation, request ids, and response item ids.
- Resume requires the current park generation plus `outcome.matchHitlResponse` / `resumeHitlIfMatched` kind/request/tool-call identity. Mismatch never wakes.
- All sibling request ids must be answered before continuation. Partial accepts do not start a tool drain.
- Host drain receives `DrainContext.drainToken` and `readyResponses`. Pause with that token; do not park from a stale token.
- A successful drain that leased a Ready generation acknowledges and clears those refs. Failure or interruption keeps them (at-least-once). Host side effects must be idempotent.
- Human pause releases the busy claim. User `stop` is terminal at the captured owner's settlement (including shutdown then user-stop). Shutdown interrupt keeps the claim. The Durable Object snapshot claim store does not make Inbox durable.

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
