# @yolk-sdk/sandbox

Effect-native sandbox execution contracts, an agent tool, testing fakes, and Vercel Sandbox and
Cloudflare Containers adapters.

## Install

```bash
pnpm add @yolk-sdk/sandbox@canary @yolk-sdk/agent@canary effect@4.1.5
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.
Use the SDK's matching Effect version (`4.1.5`) in host code.
Published package metadata requires Node.js 22+; `@yolk-sdk/sandbox/vercel` is server-only, and
`@yolk-sdk/sandbox/cloudflare` runs in Cloudflare Workers.

## Subpaths

| Subpath                        | Purpose                                                                |
| ------------------------------ | ---------------------------------------------------------------------- |
| `@yolk-sdk/sandbox`            | Core `Sandbox` service, state store, models, lifecycle helpers, errors |
| `@yolk-sdk/sandbox/agent`      | One destructive `sandbox` tool module for `@yolk-sdk/agent/tools`      |
| `@yolk-sdk/sandbox/vercel`     | Vercel Sandbox provider layer                                          |
| `@yolk-sdk/sandbox/cloudflare` | Cloudflare Containers provider layer and its Durable Object class      |
| `@yolk-sdk/sandbox/testing`    | Fake sandbox + in-memory state store layers                            |

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

## Workspace paths

`normalizeWorkspaceCwd(rawCwd)` returns an Effect with a `NormalizedWorkspaceCwd` branded string
(exported from `@yolk-sdk/sandbox`). Raw `Sandbox.run({ cwd })` inputs stay strings. The normalizer
trims raw outer whitespace, resolves dot segments, and rejects absolute/NUL/escaping paths.
Whitespace belonging to remaining directory names is preserved. The brand records lexical path
validation, not filesystem or symlink confinement.

## Binary file transfer

`SandboxApi` has optional `writeFile({ path, bytes })` and `readFile({ path, maxBytes })` on
workspace-relative paths (`normalizeWorkspacePath` returns a `NormalizedWorkspacePath`; absolute
paths, NUL bytes and escapes fail with `SandboxInputError` `invalid_path`). Reads stream and stop
past `maxBytes` (`file_too_large`); a missing file is `file_not_found`. The Vercel layer implements
both under the same one-at-a-time lock as commands (custom `VercelSandboxHandle`s need `readFile`).
`@yolk-sdk/files` uses them for `file_to_sandbox`/`file_from_sandbox`. In tests, pass `files` to
`makeFakeSandboxLayer` or use `makeFakeSandboxFiles` from `@yolk-sdk/sandbox/testing`.

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
import { makeVercelSandboxLayer } from '@yolk-sdk/sandbox/vercel'

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

- Sandbox names are deterministic from `sandboxSessionId` (`makeSandboxName`; the Vercel sandbox
  and the Cloudflare Durable Object use the same name).
- Stored state is the fast path; when state is missing, the Vercel adapter tries `get(name)` before `create(name)`.
- Reattached sandboxes save fresh state and report `workspaceReset: false`.
- Expired disposable state recreates and reports `workspaceReset: true`.
- Expired persistent state calls `get(name)` so Vercel can resume its latest persisted filesystem;
  it recreates only when the provider no longer has that named sandbox.

## Cloudflare Containers

`@yolk-sdk/sandbox/cloudflare` provides the same `Sandbox` service on
[Cloudflare Containers](https://developers.cloudflare.com/containers/). Commands and file transfers
go over RPC to `CloudflareSandbox`, a Durable Object class the host Worker exports and binds to a
container application. Each object (named `makeSandboxName(sandboxSessionId)`) runs one container
at a time; its image's own command should keep it alive (`CMD ["sleep", "infinity"]`), and every
sandbox command is an `exec` in it. The image needs `bash` and `sh`, and `git` for a Git source.

### Host wiring

```ts
// worker.ts
export { CloudflareSandbox } from '@yolk-sdk/sandbox/cloudflare'
```

Bind the class as a SQLite Durable Object class and attach it to a container application with the
`durable_object` scheduling policy (in Alchemy or wrangler). One class can carry several images;
each has an id, and `ctx.container.images` maps those ids to digest-pinned references. The layer's
`image` is that id: e.g. a session image `SessionSandbox` and a browser image `Browser` on the same
class. The Durable Object part in wrangler terms:

```jsonc
{
  "durable_objects": { "bindings": [{ "name": "SANDBOX", "class_name": "CloudflareSandbox" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["CloudflareSandbox"] }]
}
```

Then provide the layer where the agent runs (any Worker with the binding):

```ts
import { Layer } from 'effect'
import { DisposableSandboxLifecycle, SandboxResources } from '@yolk-sdk/sandbox'
import { makeCloudflareSandboxLayer } from '@yolk-sdk/sandbox/cloudflare'

const SandboxLayer = makeCloudflareSandboxLayer({
  sandboxSessionId: 'user_1:session_1',
  namespace: () => env.SANDBOX,
  image: 'SessionSandbox',
  resources: SandboxResources.make({ vcpus: 2 }), // 2 GiB memory per vCPU; `diskMb` default 16384
  lifecycle: DisposableSandboxLifecycle.make({
    idleTtlMs: 30 * 60_000,
    maxLifetimeMs: 45 * 60_000
  }),
  env: { NODE_ENV: 'development' },
  internet: true
}).pipe(Layer.provide(HostSandboxStateStoreLayer))
```

The object is engine-only: image, resources, env, internet access, workspace root, source, and
lifecycle come with every call from the layer config. They apply when the object starts a
container; a running container keeps its settings, except that another `image` restarts it. Give
each image its own `sandboxSessionId` (one object runs one container).

**Environment.** Commands do not see the image's Dockerfile `ENV`: they run through `exec`. The
layer's `env` is set on the container and on every command, so set command environment there.

### Behavior compared with the Vercel adapter

| Topic          | Cloudflare adapter                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace      | Lives only while the container runs (default `/workspace`). A stop loses it.                                                                      |
| State          | `CloudflareSandboxState` with the container's `bootId`; a new boot → `workspaceReset`                                                             |
| Disposable     | The object's alarm destroys the container after `idleTtlMs` idle or at `maxLifetimeMs`                                                            |
| Persistent     | Idle stop only, no max lifetime; files still do not survive a stop (no snapshots here)                                                            |
| Sources        | `Empty`, `Git` (`git` in the container; credentials only in that exec's environment), `Tarball` (the object downloads a `.tar.gz` and unpacks it) |
| Snapshots      | Not supported: the config type has no snapshot source                                                                                             |
| Preview URLs   | None: `previewUrls` is always `[]`                                                                                                                |
| Network policy | `internet: false` turns off outbound internet (`enableInternet`); no host/CIDR rules                                                              |
| Timeouts       | SIGKILL on expiry plus a best-effort kill of the process tree                                                                                     |
| Output         | First `maxOutputBytes` (default 1 MiB) of stdout and of stderr per command                                                                        |
| Background     | Detached in the container; `backgroundId` while it runs after the 2 s probe                                                                       |

The platform's inactivity timeout is set to `idleTtlMs` as well. If the platform stops the
container sooner, the next call starts a new one and reports `workspaceReset: true`; the adapter
never reports a lost workspace as kept. Engine files live in `/tmp/yolk-sandbox` (outside the
workspace); do not remove them.

There is no allow/deny firewall like Vercel's `networkPolicy`. For HTTP egress rules, subclass the
class and route the container's outbound HTTP through a Worker you control after each start:

```ts
import { CloudflareSandbox } from '@yolk-sdk/sandbox/cloudflare'

export class SessionSandbox extends CloudflareSandbox<Env> {
  protected override async containerStarted() {
    await this.ctx.container?.interceptAllOutboundHttp(this.env.EGRESS)
  }
}
```

RPC messages carry file bytes and command output, so keep `readFile` `maxBytes`, written files, and
`maxOutputBytes` well under the Workers RPC message limit (32 MiB).

## Agent tool output

- Command failure is result data: nonzero exit and timeout return `ToolResult.isError`.
- Provider/state/config failures fail the adapter Effect with `ToolError`; the agent loop turns those into model-visible failed tool results, so keep messages safe.
- `structuredContent` is plain JSON for workflow/session persistence and matches the declared
  `SandboxToolOutput`, including the same bounded `stdout`/`stderr` slices as the text; code mode
  scripts receive this object.
- Unknown argument keys are model-visible validation errors with a hint naming the allowed keys,
  not stripped.

## Host responsibilities

- Build `sandboxSessionId` from host user/session scope.
- Provide a durable `SandboxStateStore` adapter.
- Inject env/secrets and choose source/snapshot/git policy.
- Run cleanup for expired disposable sandboxes.
- Own approvals, auth, UI, diffs, commit/push/PR, and audit policy.

## Boundaries

- Core is provider-SDK-free and app-free; it includes the Vercel and Cloudflare state and naming
  contracts but not the live SDKs.
- `cloudflare:workers` imports live only under `@yolk-sdk/sandbox/cloudflare`, which runs in
  Workers (hosts type it with their own Workers types).
- Vercel SDK imports live only under `@yolk-sdk/sandbox/vercel`. That adapter is Node/server-only
  because `@vercel/sandbox` imports Node built-ins; browser/Worker code must call a host endpoint.
- The Vercel layer creates on a managed `runtime` (default `node24`) or on a Vercel Container
  Registry `image` (`image: 'team/project/repo@sha256:…'`, the project's own or a shared one),
  never both. Either applies to empty, Git, and tarball creation; snapshot creation boots the
  snapshot's own environment.
- The package exposes one destructive agent tool; hosts decide where to enable it and how to approve it.
