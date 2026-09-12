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
| `@yolk-sdk/harness/inbox`                 | `src/inbox.ts`                 | Admission / steer / queue / HITL items                                                                                                |
| `@yolk-sdk/harness/driver`                | `src/driver.ts`                | `Driver` + `makeHarness`                                                                                                              |
| `@yolk-sdk/harness/driver/memory`         | `src/driver/memory.ts`         | In-memory driver + harness layer for tests                                                                                            |
| `@yolk-sdk/harness/driver/durable-object` | `src/driver/durable-object.ts` | Snapshot `RunStore` + driver for Durable Object storage                                                                               |
| `@yolk-sdk/harness/outcome`               | `src/outcome.ts`               | `attemptModelTurn` / `attemptToolBatch` step outcomes (`Completed`, `AwaitingInput`, `Retry`, `Continue`, `RecoverFull`, `Compacted`) |

## Boundaries

- Core (coordinator/store/inbox/driver) is Effect only. No Next, React, Node builtins, DB, or auth.
- Only `src/outcome.ts` may import `@yolk-sdk/agent/{loop,protocol}`.
- Do not model users, teams, orgs, billing, or product permissions. Run ids are opaque strings.
- Hosts own tool catalogs, prompts, auth, concrete Store/Inbox adapters, and `'use workflow'` files.
- `@yolk-sdk/vercel-workflows` stays protocol-free; a Vercel driver (later) wraps it, it does not import harness protocol types.
- Durable compaction is a host/harness _step_, not `ContextTransformer`. Do not persist transformer checkpoints. Overflow before output may return `Compacted` when the host supplies `compact`; overflow after output is terminal. In-process silent retry still uses `makeContextOverflowRetryProvider` on the provider Layer.

## Design rules

- `Driver` is the durability strategy (`InProcess` claims, later Workflow / Durable Object). Not `Runtime`, `World`, or `Executor`.
- Coordinator: one busy period per run id; `"input"` subsumes `"steer"`; interrupt claims the doorbell.
- Claims: `started` claims; success/user-stop releases; **shutdown interrupt keeps the claim**.
- Recovery is at-least-once. Do not claim exactly-once tool/provider effects.
- `makeHarness` only merges driver + store + inbox Layers. It is not a compiler.
- `admit` records an inbox item then wakes the driver. Drain/step execution stays host-provided.
- `resumeSuspended` increments a durable per-run counter; past `maxResumeAttempts` the claim is released. At-least-once.
