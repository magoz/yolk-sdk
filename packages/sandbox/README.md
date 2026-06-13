# @yolk-sdk/sandbox

Effect-native sandbox execution plane primitives plus a Vercel Sandbox adapter for Yolk agents.

## Install

```bash
pnpm add @yolk-sdk/sandbox@canary effect
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Subpaths

| Subpath | Purpose |
| --- | --- |
| `@yolk-sdk/sandbox` | Core `Sandbox` service, state store, models, lifecycle helpers, errors |
| `@yolk-sdk/sandbox/agent` | One trusted `sandbox` tool module for `@yolk-sdk/agent/tools` |
| `@yolk-sdk/sandbox/vercel` | Vercel Sandbox provider layer |
| `@yolk-sdk/sandbox/testing` | Fake sandbox + in-memory state store layers |

## Imports

```ts
import { Sandbox, SandboxStateStore } from '@yolk-sdk/sandbox'
import { makeSandboxToolModule } from '@yolk-sdk/sandbox/agent'
import { makeVercelSandboxLayer } from '@yolk-sdk/sandbox/vercel'
```

## Example

```ts
import { Effect, Layer } from 'effect'
import { Sandbox } from '@yolk-sdk/sandbox'
import { makeVercelSandboxLayer } from '@yolk-sdk/sandbox/vercel'
import { makeInMemorySandboxStateStoreLayer } from '@yolk-sdk/sandbox/testing'

const layer = makeVercelSandboxLayer({ sandboxSessionId: 'user_1:session_1' }).pipe(
  Layer.provide(makeInMemorySandboxStateStoreLayer())
)

const program = Effect.gen(function* () {
  const sandbox = yield* Sandbox
  return yield* sandbox.run({ command: 'node --version' })
}).pipe(Effect.provide(layer))
```

## Host responsibilities

- Build `sandboxSessionId` from host user/session scope.
- Provide a durable `SandboxStateStore` adapter.
- Inject env/secrets and choose source/snapshot/git policy.
- Run cleanup for expired disposable sandboxes.
- Own approvals, auth, UI, diffs, commit/push/PR, and audit policy.

## Boundaries

- Core is provider-free and app-free.
- Vercel SDK imports live only under `@yolk-sdk/sandbox/vercel`.
- The package exposes one agent tool; hosts decide where to enable it.
