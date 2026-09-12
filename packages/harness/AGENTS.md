# Harness Package

`@yolk-sdk/harness` owns **run lifecycle**, not the agent loop and not product policy.
Composition of model/tools remains `@yolk-sdk/agent/loop` Layers. Interception is service
decoration, not hooks. There is no `World`.

## Subpaths

| Subpath                                   | Source                         | Role                                                                                                                                  |
| ----------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `@yolk-sdk/harness`                       | `src/index.ts`                 | Tiny root                                                                                                                             |
| `@yolk-sdk/harness/coordinator`           | `src/coordinator.ts`           | Process-local doorbell coordinator                                                                                                    |
| `@yolk-sdk/harness/store`                 | `src/store.ts`                 | `RunStore` claim/release contract + in-memory                                                                                         |
| `@yolk-sdk/harness/inbox`                 | `src/inbox.ts`                 | Admission / steer / queue items plus in-memory HITL park/generation state (not durable)                                               |
| `@yolk-sdk/harness/driver`                | `src/driver.ts`                | `Driver` + `makeHarness`                                                                                                              |
| `@yolk-sdk/harness/driver/memory`         | `src/driver/memory.ts`         | In-memory driver + harness layer for tests                                                                                            |
| `@yolk-sdk/harness/driver/durable-object` | `src/driver/durable-object.ts` | Snapshot `RunStore` + driver for Durable Object storage                                                                               |
| `@yolk-sdk/harness/outcome`               | `src/outcome.ts`               | `attemptModelTurn` / `attemptToolBatch` step outcomes (`Completed`, `AwaitingInput`, `Retry`, `Continue`, `RecoverFull`, `Compacted`) |

## Boundaries

- Core (coordinator/store/inbox/driver) is Effect only. No Next, React, Node builtins, DB, or auth.
- Only `src/outcome.ts` may import `@yolk-sdk/agent/{loop,protocol,compaction}`.
- Do not model users, teams, orgs, billing, or product permissions. Run ids are opaque strings.
- Hosts own tool catalogs, prompts, auth, concrete Store/Inbox adapters, and `'use workflow'` files.
- `@yolk-sdk/vercel-workflows` stays protocol-free; a Vercel driver (later) wraps it, it does not import harness protocol types.
- Durable compaction is a host/harness _step_, not `ContextTransformer`. Do not persist transformer checkpoints. Overflow before published output may return `Compacted` when the host supplies `compact` and `overflowCompactionAttempt` is still under budget (`0` by default, compact once). `Compacted` returns the incremented count for the host to persist with the compacted messages and pass on the next attempt; omitting or resetting the count has no cross-invocation guarantee. Overflow after output, or after the budget is spent, is terminal. In-process silent retry still uses `makeContextOverflowRetryProvider` on the provider Layer. Do not install both on one path.

## Design rules

- `Driver` is the durability strategy (`InProcess` claims, later Workflow / Durable Object). Not `Runtime`, `World`, or `Executor`.
- Coordinator: one busy period per run id; `"input"` subsumes `"steer"`; interrupt claims the doorbell.
- Claims: `started` claims; success/user-stop releases; **shutdown interrupt keeps the claim**.
- Recovery is at-least-once. Do not claim exactly-once tool/provider effects.
- `makeHarness` only merges driver + store + inbox Layers. It is not a compiler.
- `admit` records an inbox item then wakes the driver. Drain/step execution stays host-provided.
- HITL pause/resume/stop live on Driver (`pause` / `resumeHitl` / `stop`) with payload-free Inbox metadata. Hosts persist typed HITL payloads by item id. `outcome.matchHitlResponse` / `resumeHitlIfMatched` validate protocol identity before resume. Memory Inbox park state is process-lifetime only, including when claims use the Durable Object snapshot store. Factory layers share one Inbox instance.
- A human pause ends the busy drain successfully and releases the claim. User `stop` invalidates the current park generation, drops that run's queued items, and uses `terminalStop` without awaiting settlement. Generic `interrupt` keeps the first accepted reason; `terminalStop` may escalate a live owner. Idle/Settling leftover claims release under the Inbox admission gate so a successor cannot start until that store action finishes; live owners release at their settled callback. Shutdown interrupt still keeps the claim. Ready HITL item ids stay parked if that continuation drain is interrupted; they are not exactly-once.
- `resumeSuspended` increments a durable per-run counter; past `maxResumeAttempts` the claim is released. At-least-once.
- `attemptModelTurn` classifies one `runModelTurn` invocation after that stream's `LoopConfig.maxRetries` / provider retries. It does not add another retry loop. Hosts that own physical-attempt scheduling should use `maxRetries: 0` and no retry decorator. Incomplete streams (`LLMError.responseIssue === 'missing_done'`) recover as `RecoverFull` / `Continue` without fabricating `retryable: true`. Content-filter and other nonretryable terminals stay failed. `onEvent` sink errors, compact errors (including Abort), and admission Abort are never classified as provider `Retry`/`Continue`. `Continue` keeps partial text/reasoning/completed calls without new message IDs and does not execute tools.
- `attemptToolBatch` `Completed` continues when tools executed. Pending HITL fences the whole batch; `AwaitingInput` does not invent mixed executed siblings.
