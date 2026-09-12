# @yolk-sdk/harness

Domain-free **run lifecycle** for Yolk agents: who owns a live run, how wakes coalesce, and how
claims survive a crash. The model/tool loop stays in `@yolk-sdk/agent/loop`.

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Install

```bash
pnpm add @yolk-sdk/harness@canary effect@4.0.0-beta.80
```

## Subpaths

| Subpath                                   | Purpose                                                  |
| ----------------------------------------- | -------------------------------------------------------- |
| `@yolk-sdk/harness`                       | Tiny root                                                |
| `@yolk-sdk/harness/coordinator`           | Process-local doorbell coordinator                       |
| `@yolk-sdk/harness/store`                 | `RunStore` claim/release                                 |
| `@yolk-sdk/harness/inbox`                 | Admission / steer / queue items                          |
| `@yolk-sdk/harness/driver`                | `Driver` + `makeHarness`                                 |
| `@yolk-sdk/harness/driver/memory`         | In-memory driver for tests                               |
| `@yolk-sdk/harness/driver/durable-object` | Durable Object storage-backed claims + driver            |
| `@yolk-sdk/harness/outcome`               | Fold `runModelTurn` / `runToolBatch` into a step outcome |

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

Hosts still own tools, prompts, auth, and durable adapters (`VercelWorkflowDriver` / DO are later).
There is no hook registry and no `World`.
