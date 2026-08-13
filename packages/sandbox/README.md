# @yolk-sdk/sandbox

Effect-native sandbox execution plane primitives plus a Vercel Sandbox adapter for Yolk agents.

## Install

```bash
pnpm add @yolk-sdk/sandbox@canary @yolk-sdk/agent@canary effect
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.
Published package metadata requires Node.js 22+; `@yolk-sdk/sandbox/vercel` is server-only.

## Subpaths

| Subpath                     | Purpose                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `@yolk-sdk/sandbox`         | Core `Sandbox` service, state store, models, lifecycle helpers, errors |
| `@yolk-sdk/sandbox/agent`   | One destructive `sandbox` tool module for `@yolk-sdk/agent/tools`      |
| `@yolk-sdk/sandbox/vercel`  | Vercel Sandbox provider layer                                          |
| `@yolk-sdk/sandbox/testing` | Fake sandbox + in-memory state store layers                            |

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

The in-memory state store is for examples and tests only. Production hosts must provide a durable
`SandboxStateStore`.

## Lifecycle model

`SandboxLifecycle` is a tagged union:

- `Disposable`: `idleTtlMs` plus a hard `maxLifetimeMs`
- `Persistent`: `idleTtlMs` plus optional snapshot expiration/retention; idle expiry resumes the
  stable named sandbox instead of deleting its filesystem

The default is disposable with a 30-minute idle TTL and 45-minute maximum lifetime. Persistent
lifecycle is modeled for hosts that explicitly own snapshot retention and cleanup policy.

```ts
import { DisposableSandboxLifecycle } from '@yolk-sdk/sandbox'

const lifecycle = DisposableSandboxLifecycle.make({
  idleTtlMs: 30 * 60_000,
  maxLifetimeMs: 45 * 60_000
})
```

## Initial source model

`SandboxInitialSource` is a tagged union:

- `Empty`: blank workspace; the default
- `Snapshot`: restore `snapshotId`
- `Git`: clone URL with optional revision/depth and all-or-nothing `GitSandboxBasicAuth`
- `Tarball`: unpack a host-provided URL

Pass the source when constructing the provider layer. It applies when the adapter creates or
recreates a workspace; reattachment preserves the existing workspace.

```ts
import { GitSandboxInitialSource } from '@yolk-sdk/sandbox'

const source = GitSandboxInitialSource.make({
  url: 'https://github.com/example/project.git',
  revision: 'main',
  depth: 1
})

const layer = makeVercelSandboxLayer({
  sandboxSessionId: 'user_1:session_1',
  source
})
```

Hosts resolve/inject Git credentials and tarball access. Do not persist source secrets in app
session records or logs.

## State reuse

- Vercel sandbox names are deterministic from `sandboxSessionId`.
- Stored state is the fast path; when state is missing, the Vercel adapter tries `get(name)` before `create(name)`.
- Reattached sandboxes save fresh state and report `workspaceReset: false`.
- Expired disposable state recreates and reports `workspaceReset: true`.
- Expired persistent state calls `get(name)` so Vercel can resume its latest persisted filesystem;
  it recreates only when the provider no longer has that named sandbox.

## Agent tool output

- Command failure is result data: nonzero exit and timeout return `ToolResult.isError`.
- Provider/state/config failures fail the adapter Effect with `ToolError`; the agent loop turns those into model-visible failed tool results, so keep messages safe.
- `structuredContent` is plain JSON for workflow/session persistence.

## Host responsibilities

- Build `sandboxSessionId` from host user/session scope.
- Provide a durable `SandboxStateStore` adapter.
- Inject env/secrets and choose source/snapshot/git policy.
- Run cleanup for expired disposable sandboxes.
- Own approvals, auth, UI, diffs, commit/push/PR, and audit policy.

## Boundaries

- Core is provider-free and app-free.
- Vercel SDK imports live only under `@yolk-sdk/sandbox/vercel`. That adapter is Node/server-only
  because `@vercel/sandbox` imports Node built-ins; browser/Worker code must call a host endpoint.
- `runtime` applies to empty, Git, and tarball creation. Snapshot creation inherits the snapshot's
  runtime.
- The package exposes one destructive agent tool; hosts decide where to enable it and how to approve it.
