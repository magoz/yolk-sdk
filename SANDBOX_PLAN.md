# Sandbox plan

## Status

Implementation started. Vercel Sandbox v2.2.1 checked locally in `.repos/vercel-sandbox` at `bc15403` against npm `@vercel/sandbox@2.2.1`. Stable package-local details now live in `packages/sandbox/README.md` and `packages/sandbox/AGENTS.md`.

## Core decision

Build `@yolk-sdk/sandbox` as a public package. First provider: Vercel Sandbox. Default agent surface: one trusted tool named `sandbox`.

The sandbox is the execution plane. The agent/runtime stays outside it.

```txt
Agent runtime / Workflow
  -> sandbox tool
  -> Vercel Sandbox command execution
```

No approval/policy engine in v0. This is trusted personal infrastructure first. Future hosts can wrap the package with policy.

## Motivation

`just_bash` was a useful interim shell, but it is virtual, ephemeral, and intentionally limited. Yolk needs a real agent execution plane for:

- project commands: `pnpm tsc`, `pnpm lint`, tests, builds;
- browser checks: dev server + `agent-browser`;
- code edits: `apply_patch` inside a disposable workspace;
- CLI integrations: `executor`-style discovery/calls;
- long-running processes: dev servers, daemons, preview ports.

## Research summary

### Open Agents

Source: https://github.com/vercel-labs/open-agents

Key lesson: **the agent is not the sandbox**.

```txt
Web -> Agent workflow -> Sandbox VM
```

The Workflow controls model/tool turns. The sandbox provides filesystem, shell, git, dev servers, and preview ports. Sandbox lifecycle can hibernate/resume independently from the agent runtime.

### Vercel Sandbox

Sources:

- https://vercel.com/docs/sandbox
- https://vercel.com/docs/sandbox/sdk-reference
- https://vercel.com/docs/sandbox/concepts/persistent-sandboxes
- `.repos/vercel-sandbox` current at 2026-06-13, package `@vercel/sandbox@2.2.1`

Relevant v2 findings:

- stable identifier is `name`, not `sandboxId`;
- `persistent` defaults to `true`;
- `persistent: false` opts out of automatic filesystem snapshots;
- `timeout` auto-stops current session;
- persistent sandboxes can auto-resume on SDK calls;
- `Sandbox.getOrCreate()` handles missing/expired named sandboxes;
- `Sandbox.getOrCreate()` type does not accept `source: { type: 'snapshot' }`; snapshot-based creation needs manual get/create;
- `sandbox.delete()` permanently deletes sandbox, sessions, and snapshots;
- `await using` only calls `stop()`, not `delete()`;
- `runCommand` supports `detached`, `timeoutMs`, `cwd`, `env`, stdout/stderr streams, but not stdin;
- `timeoutMs` kills with SIGKILL and returns exit code `137`, not a first-class `timedOut` flag;
- `extendTimeout(duration)` is additive; pass only the delta needed to restore desired expiry;
- no built-in delete-after-idle primitive found, so host cleanup remains needed.

### E2B / Modal / Cloudflare Containers

Sources:

- https://e2b.mintlify.app/docs/sandbox.md
- https://e2b.mintlify.app/docs/sandbox/persistence.md
- https://modal.com/docs/guide/sandbox
- https://developers.cloudflare.com/containers/

Common shape: create/connect/resume/stop, run commands, pass env, read/write files, expose ports, manage timeouts, optional persistence/snapshots, host-owned lifecycle policy.

### Cloudflare Code Mode

Source: https://blog.cloudflare.com/code-mode-mcp/

Cloudflare reduced a 2,500 endpoint API to two tools: `search()` and `execute()`. Yolk should likewise avoid exposing many low-level sandbox operations as model tools. Give the model a compact execution interface and let it discover/compose capabilities inside the sandbox.

### Executor

Source: https://github.com/rhyssullivan/executor

Executor exposes one shared integration runtime/catalog across agents. Agents discover, describe, and call through a compact CLI/runtime instead of receiving every operation as a tool. Yolk's sandbox should be the same style: one tool, rich commands behind it.

## Resolved decisions

| Area | Decision |
| --- | --- |
| Public shape | Add public `@yolk-sdk/sandbox`; reusable by Yolk apps including `../speldosa`. |
| Root export | Root exports core service/models/errors, like `connectors`/`knowledge` core. |
| Subpaths | `@yolk-sdk/sandbox/agent`, `/vercel`, `/testing`. No `/core` subpath. |
| Effect style | Service-first: `Sandbox` and `SandboxStateStore` are `Context.Service`s. |
| First provider | Vercel Sandbox only in v0. Other providers deferred. |
| Runtime target | Node/Vercel first. Worker/Cloudflare can use a future broker. |
| Vercel credentials | Let `@vercel/sandbox` use OIDC/env defaults. No Yolk credential abstraction v0. |
| Agent surface | One tool: `sandbox`. |
| Tool instructions | Self-contained generated tool description. No system-prompt helper v0. |
| Tool params | `command`, `cwd?`, `stdin?`, `timeoutSeconds?`, `background?`. Optional params accept omission or `null`. No `purpose`. |
| Command form | Shell string, multiline allowed, run through non-interactive bash. |
| Working dir | `cwd` is workspace-relative only. Absolute cwd rejected. |
| Stdin | Supported by wrapper files because Vercel SDK has no stdin parameter. Primary channel for large patches/scripts/data. |
| Output | Split stdout/stderr; 50k model-visible char cap; truncation flag. |
| Foreground timeout | Default 120s, max 600s. |
| Background v0 | Start only; 2s quick probe; no logs/kill/list API yet. |
| Concurrency v0 | Serialize commands per `Sandbox` service instance to avoid state races. |
| Preview URLs | Included in tool description and command metadata. No preview tool. |
| Tool surfaces | Package is surface-agnostic. Yolk enables Workflow/text first; voice later if desired. |
| Dogfood route | Wire `/agent/workflow` first. |
| `just_bash` | Remove from Workflow dogfood when sandbox lands; keep shared Cloudflare-compatible exposure until replacement exists. No migration/backcompat docs needed. |
| Tool access | `destructive`. Trusted personal infra in v0. |
| Session scope | One sandbox per host-provided `sandboxSessionId`, normally one per top-level conversation. Subagents reuse it. |
| Vercel name | `sandbox-{hash(sandboxSessionId)}`; host must include user scope in `sandboxSessionId`. |
| State | Provider-tagged typed JSON. Host DB stores JSON and decodes at the boundary. |
| State store | Package defines `SandboxStateStore`; `Sandbox` service depends on it. |
| State key | Store keyed by host `sandboxSessionId`, not raw user-facing session id. |
| Lazy lifecycle | `Sandbox.run` lazily get-or-creates on first command. |
| Persistence source | Host DB owns lifecycle timestamps; Vercel owns live status. |
| Disposable default | `persistent: false`, idle TTL 30m, max lifetime 45m for package safety; hosts can override to 4h on Pro/Enterprise. |
| Touch behavior | Each command extends/restores idle TTL by additive delta, capped by max lifetime. |
| Idle expiry | If idle-expired or provider sandbox/session is gone before command, delete stale state/sandbox and create fresh. |
| Max lifetime | Existing sandbox is never extended past max lifetime; before next command, delete/create fresh and mark `workspaceReset: true`. Current command may finish. |
| Cleanup | Next internal cron route scans DB every 15m; package exposes single-session delete, no batch helper v0. |
| Delete primitive | Use Vercel `sandbox.delete()` for disposable cleanup. |
| Source model | Exactly one initial source ADT: empty, snapshot, git, or tarball. Snapshot and git/tarball are mutually exclusive. |
| Bootstrap | No heavy bootstrap. Optional minimal bootstrap only. Full browser/tools require snapshot. |
| Snapshot creation | App/script-owned (`pnpm sandbox:snapshot-base`), not package API v0. |
| `apply_patch` | Base snapshot owns `apply_patch` on PATH. Package does not detect/install it. |
| Snapshot tool detection | No hard detection of `apply_patch`/`agent-browser`; command failure is enough. |
| Resources | Default 2 vCPU, host-overridable. |
| Runtime | Vercel `node24` default. |
| Ports | Default `[3000, 5173, 4321, 8000]`. |
| Source checkout | Initial source ADT maps to Vercel `source`. Auth/branch policy app-owned. |
| Env | Host-provided `env`; package owns no secrets. |
| Network | Allow-all default; Vercel-specific network policy passthrough. |
| Errors | Multiple tagged errors plus `SandboxError` union alias. |
| Command failure | Nonzero exit and timeout are command result data, not Effect failure. |
| Expired error mapping | `SandboxExpiredError` becomes model-visible tool error only when lifecycle expiry cannot be reset automatically. |
| Infra error mapping | Config/state/provider errors become fatal `ToolError`. |
| Tests | No live Vercel tests by default. Use fakes/seams; optional manual smoke later. |

## Package shape

```txt
@yolk-sdk/sandbox
@yolk-sdk/sandbox/agent
@yolk-sdk/sandbox/vercel
@yolk-sdk/sandbox/testing
```

Root exports core only:

```ts
export {
  Sandbox,
  SandboxStateStore,
  SandboxCommandInput,
  SandboxCommandResult,
  SandboxLifecycle,
  SandboxConfigError,
  SandboxExpiredError,
  SandboxProviderError,
  SandboxStateError,
  SandboxStateStoreError,
  makeVercelSandboxName
}
export type { SandboxApi, SandboxError, SandboxStateStoreApi }
```

Dependency direction:

```txt
@yolk-sdk/sandbox root -> Effect only
@yolk-sdk/sandbox/agent -> sandbox root + @yolk-sdk/agent/tools + protocol + loop
@yolk-sdk/sandbox/vercel -> sandbox root + @vercel/sandbox
@yolk-sdk/sandbox/testing -> sandbox root
examples/next, speldosa -> @yolk-sdk/sandbox/* + app auth/storage/policy
@yolk-sdk/agent -> no sandbox dependency
```

## Core service model

### Sandbox service

```ts
export type SandboxApi = {
  readonly run: (input: SandboxCommandInput) => Effect.Effect<SandboxCommandResult, SandboxError>
  readonly currentState: Effect.Effect<Option.Option<SandboxState>, SandboxStateStoreError | SandboxStateError>
  readonly delete: Effect.Effect<void, SandboxProviderError | SandboxStateStoreError | SandboxStateError>
}

export class Sandbox extends Context.Service<Sandbox, SandboxApi>()(
  '@yolk-sdk/sandbox/Sandbox'
) {}
```

`Sandbox.run` lazily creates/connects the provider sandbox, runs one command, updates lifecycle state, saves through `SandboxStateStore`, and returns command metadata. `currentState` returns `Option.none()` before first command.

### State store service

```ts
export type SandboxStateStoreApi = {
  readonly load: (sandboxSessionId: string) => Effect.Effect<Option.Option<SandboxState>, SandboxStateStoreError>
  readonly save: (input: { readonly sandboxSessionId: string; readonly state: SandboxState }) => Effect.Effect<void, SandboxStateStoreError>
  readonly clear: (sandboxSessionId: string) => Effect.Effect<void, SandboxStateStoreError>
}

export class SandboxStateStore extends Context.Service<SandboxStateStore, SandboxStateStoreApi>()(
  '@yolk-sdk/sandbox/SandboxStateStore'
) {}
```

`SandboxStateStore` stays typed. Concrete DB adapters store JSON and decode/encode at the app boundary before returning typed state.

### State

```ts
export type SandboxState = {
  readonly _tag: 'Vercel'
  readonly name: string
  readonly createdAtMs: number
  readonly lastUsedAtMs: number
  readonly expiresAtMs: number
  readonly maxExpiresAtMs: number
}
```

### Lifecycle

```ts
export type SandboxLifecycle =
  | {
      readonly _tag: 'Disposable'
      readonly idleTtlMs: number
      readonly maxLifetimeMs: number
    }
  | {
      readonly _tag: 'Persistent'
      readonly idleTtlMs: number
      readonly snapshotExpirationMs?: number
      readonly keepLastSnapshots?: number
    }
```

v0 default:

```ts
{
  _tag: 'Disposable',
  idleTtlMs: 30 * 60_000,
  maxLifetimeMs: 45 * 60_000
}
```

Persistent is modeled now so the type is not a dead end, but v0 dogfood uses disposable only. Hosts on Pro/Enterprise may override `maxLifetimeMs` to 4h.

### Errors

```ts
export class SandboxConfigError extends Schema.TaggedErrorClass<SandboxConfigError>()(
  'SandboxConfigError',
  { message: Schema.String, cause: Schema.String }
) {}

export class SandboxExpiredError extends Schema.TaggedErrorClass<SandboxExpiredError>()(
  'SandboxExpiredError',
  { message: Schema.String, expiredAtMs: Schema.Number }
) {}

export class SandboxStateError extends Schema.TaggedErrorClass<SandboxStateError>()(
  'SandboxStateError',
  { message: Schema.String, cause: Schema.String, underlying: Schema.optional(Schema.Unknown) }
) {}

export class SandboxStateStoreError extends Schema.TaggedErrorClass<SandboxStateStoreError>()(
  'SandboxStateStoreError',
  { message: Schema.String, operation: Schema.String, underlying: Schema.optional(Schema.Unknown) }
) {}

export class SandboxProviderError extends Schema.TaggedErrorClass<SandboxProviderError>()(
  'SandboxProviderError',
  {
    provider: Schema.Literal('vercel'),
    operation: Schema.String,
    message: Schema.String,
    underlying: Schema.optional(Schema.Unknown)
  }
) {}

export type SandboxError =
  | SandboxConfigError
  | SandboxExpiredError
  | SandboxStateError
  | SandboxStateStoreError
  | SandboxProviderError
```

## Vercel layer

```ts
type VercelSandboxLayerConfig = {
  readonly sandboxSessionId: string
  readonly lifecycle?: SandboxLifecycle
  readonly source?: VercelSandboxInitialSource
  readonly env?: Record<string, string>
  readonly ports?: ReadonlyArray<number>
  readonly resources?: { readonly vcpus: number }
  readonly runtime?: 'node22' | 'node24' | 'node26' | 'python3.13'
  readonly networkPolicy?: VercelNetworkPolicy
}

type VercelSandboxInitialSource =
  | { readonly _tag: 'Empty' }
  | { readonly _tag: 'Snapshot'; readonly snapshotId: string }
  | {
      readonly _tag: 'Git'
      readonly url: string
      readonly username?: string
      readonly password?: string
      readonly depth?: number
      readonly revision?: string
    }
  | { readonly _tag: 'Tarball'; readonly url: string }
```

Defaults:

```ts
{
  lifecycle: { _tag: 'Disposable', idleTtlMs: 30 * 60_000, maxLifetimeMs: 45 * 60_000 },
  source: { _tag: 'Empty' },
  ports: [3000, 5173, 4321, 8000],
  resources: { vcpus: 2 },
  runtime: 'node24',
  persistent: false,
  timeout: 30 * 60_000
}
```

Vercel mapping:

- create/get by `name = sandbox-{hash(sandboxSessionId)}`;
- disposable create uses `persistent: false`;
- `timeout` starts at idle TTL;
- each command extends timeout by delta to restore idle TTL without exceeding max lifetime;
- idle-expired, max-expired, missing, or non-running disposable sandboxes are deleted/recreated before running and marked as reset;
- snapshot source uses manual `Sandbox.get`/`Sandbox.create`; `Sandbox.getOrCreate` cannot type snapshot source;
- delete uses `sandbox.delete()`;
- preview URLs use `sandbox.domain(port)` for configured ports;
- Vercel SDK credentials come from OIDC/env.

Command execution mapping:

- normalize `cwd` against `/vercel/sandbox`; reject absolute paths and `..` escape;
- create per-command files under `/vercel/sandbox/.yolk/commands/<commandId>/`;
- write user shell to `command.sh`, stdin to `stdin.txt`, and a wrapper script that redirects stdin;
- run `bash wrapper.sh` with Vercel `runCommand({ cmd: 'bash', args: [wrapper], cwd })`;
- foreground also uses `detached: true`, then races `Command.wait()` with Effect timeout;
- on timeout, call `Command.kill('SIGKILL')`, collect logs, set `timedOut: true`, `exitCode: null`;
- background starts detached, waits 2s, polls command status; if still running, return `backgroundId`;
- do not rely on Vercel `timeoutMs` for foreground timeouts because it reports only exit code `137`.

## Agent tool

Tool name:

```txt
sandbox
```

Params:

```ts
type SandboxToolInput = {
  readonly command: string
  readonly cwd?: string | null
  readonly stdin?: string | null
  readonly timeoutSeconds?: number | null
  readonly background?: boolean | null
}
```

Behavior:

- one non-interactive shell command per call;
- multiline command allowed;
- workspace-relative `cwd` only;
- foreground default timeout 120s, max 600s;
- `background: true` returns after 2s quick probe if command is still running;
- nonzero exit returns `isError: true` but not an Effect failure;
- timed out command returns `exitCode: null`, `timedOut: true`, `isError: true`;
- stdout/stderr are split and capped to 50k model-visible chars total;
- params normalize `null` to `undefined` before execution.

Model-visible result:

```txt
exit_code: 0
duration_ms: 1234
truncated: false
timed_out: false
workspace_reset: false
<stdout>
...
</stdout>
<stderr>
...
</stderr>
```

Structured content:

```ts
type SandboxToolStructuredContent = {
  readonly exitCode: number | null
  readonly durationMs: number
  readonly timedOut: boolean
  readonly truncated: boolean
  readonly workspaceReset: boolean
  readonly backgroundId?: string
  readonly previewUrls: ReadonlyArray<{ readonly port: number; readonly url: string }>
  readonly state: SandboxState
}
```

Description is generated from host/provider context and is self-contained. It should mention available capabilities such as `apply_patch`, `agent-browser`, package managers, preview URLs, and disposable lifecycle.

`makeSandboxToolModule` must not require an Effect environment at tool execution time because `ToolRegistration.execute` is environment-free. Use one of these shapes:

```ts
export const makeSandboxToolModule = <Context>(
  options: SandboxToolModuleOptions<Context>
): Effect.Effect<ToolModule<Context>, never, Sandbox>

export const makeSandboxToolModuleFromApi = <Context>(
  sandbox: SandboxApi,
  options: SandboxToolModuleOptions<Context>
): ToolModule<Context>
```

The Effectful builder reads `Sandbox` once, closes over `SandboxApi`, and returns normal tool registrations. Tool access is `destructive`.

## Base snapshot

The package consumes `source: { _tag: 'Snapshot', snapshotId }`; it does not create or refresh snapshots in v0. Snapshot source is mutually exclusive with git/tarball source.

Desired Yolk/Speldosa base snapshot contents:

- git (preinstalled in Vercel node images);
- ripgrep (`rg`);
- fd;
- jq;
- Node.js runtime + npm;
- pnpm via `corepack` or global npm install pinned to repo package manager;
- bun only if cheap and stable;
- `apply_patch` on PATH;
- `agent-browser` + Chromium dependencies;
- `executor` later, not required for v0.

Snapshot creation is app/script-owned:

```txt
pnpm sandbox:snapshot-base
```

Script location: `examples/next/scripts/create-sandbox-base-snapshot.ts`. It should:

1. create/update named persistent base sandbox `yolk-base-node24`;
2. install OS packages with `sudo dnf install -y jq ripgrep fd-find` where available and symlink `fdfind` to `fd` if needed;
3. enable/install pnpm matching root `packageManager`;
4. install `apply_patch` and `agent-browser` on PATH;
5. install Chromium/browser dependencies required by `agent-browser`;
6. run smoke commands: `node --version`, `pnpm --version`, `rg --version`, `jq --version`, `apply_patch --help`, `agent-browser --help`;
7. snapshot and print the snapshot id for `YOLK_SANDBOX_BASE_SNAPSHOT_ID`.

No package hard-failure if expected commands are missing. The command fails naturally inside the sandbox.

## Host responsibilities

Hosts own:

- DB-backed `SandboxStateStore` implementation;
- cleanup scheduler/cron route scanning expired sessions;
- `sandboxSessionId` construction from auth/user/session scope;
- env/secrets injection;
- base snapshot id via `YOLK_SANDBOX_BASE_SNAPSHOT_ID`;
- optional Vercel git source/auth/branch policy;
- commit/push/PR broker;
- UI for diffs/logs/changed files;
- future policy/approval wrapper if needed.

Next dogfood DB table:

```txt
agentSandboxState
  id text primary key
  userId text not null references user(id) on delete cascade
  agentSessionId text not null
  sandboxSessionId text not null unique
  provider text not null -- 'vercel'
  state jsonb not null
  expiresAt timestamp not null
  maxExpiresAt timestamp not null
  createdAt timestamp not null default now()
  updatedAt timestamp not null
  unique(userId, agentSessionId)
  index(expiresAt)
  index(maxExpiresAt)
```

DB adapter decodes `state` with `SandboxState` before returning from `load` and encodes before `save`.

## Yolk dogfood plan

- Add package.
- Add DB-backed sandbox state store in `examples/next`.
- Wire Vercel layer and `sandbox` tool into `/agent/workflow` first.
- Add `sandboxSessionId = ${userId}:${request.sessionId}` in Workflow runtime context.
- Keep task subagent runtime session ids separate, but pass the same `sandboxSessionId` so subagents share the execution plane.
- Do not put Vercel-wired tool code under `examples/next/lib/agents/tools/*`; that directory must stay runtime-portable.
- Split Workflow text tool modules from shared portable tool modules, then remove `just_bash` only from Workflow/Node dogfood exposure.
- Keep `just_bash` in shared Cloudflare-compatible modules until Cloudflare has an equivalent sandbox/broker path.
- Keep package surface-agnostic; do not add voice-specific restrictions in package.
- Add internal cleanup route `examples/next/app/api/internal/sandbox-cleanup/route.ts`, protected by an internal task secret, and configure Vercel Cron every 15m.

## Non-goals v0

- No command approval/classifier.
- No separate read/write/grep/browser tools.
- No browser-specific model tools; use `agent-browser` via `sandbox`.
- No GitHub push/PR from sandbox package.
- No credential persistence in package.
- No live Vercel tests by default.
- No E2B/Modal/Cloudflare provider.
- No generic MCP/executor proxy.
- No batch cleanup helper.
- No migration/backcompat docs for `just_bash`.

## Testing strategy

- Core tests: lifecycle math, idle/max expiry reset decisions, name hash, source ADT exclusivity, timeout caps, output formatting/truncation, state schemas.
- Agent tests: fake `Sandbox` service, null/omitted param normalization, tool param validation, successful result, nonzero exit, timeout, background id, workspace reset metadata, expired mapping, `destructive` metadata.
- Vercel tests: adapter unit tests behind seams/fakes; manual get/create with snapshot source; stdin wrapper; timeout kill path; background quick probe; preview URL extraction; no live Vercel in default tests.
- Testing subpath: in-memory `SandboxStateStore` and fake `Sandbox` layers.
- Optional manual smoke later: create sandbox, run `apply_patch`, start dev server, call `agent-browser`.

## Implementation plan

### 0. Planning

- [x] Capture motivation/research/decision in this tracker.
- [x] Confirm public package.
- [x] Confirm first provider: Vercel Sandbox.
- [x] Confirm one-tool agent surface.
- [x] Confirm default disposable lifecycle.
- [x] Confirm Effect service/store pattern.

### 1. Package scaffold

- [x] Add `packages/sandbox` workspace package.
- [x] Add `README.md`, `AGENTS.md`, `CHANGELOG.md`.
- [x] Export root, `/agent`, `/vercel`, `/testing`.
- [x] Add package to `.changeset/config.json` fixed group.
- [x] Add package to `packages/AGENTS.md`, root `README.md`, `patterns/PACKAGE_ARCHITECTURE.md`, `patterns/PACKAGE_DISTRIBUTION.md`.
- [x] Update package export/boundary/smoke scripts; mark package root `tinyRoot: false`.
- [x] Add boundary rule that only `packages/sandbox/src/vercel` imports `@vercel/sandbox`.
- [x] Add `@vercel/sandbox` to smoke fixture dependencies.

### 2. Core

- [x] Define command input/result schemas.
- [x] Define state/lifecycle schemas.
- [x] Define initial source ADT schemas.
- [x] Define tagged errors and alias.
- [x] Define `Sandbox` service.
- [x] Define `SandboxStateStore` service.
- [x] Add name sanitization/hash helper.
- [x] Add lifecycle math helpers.
- [x] Add workspace reset metadata on stale/max-expired disposable recreate.
- [x] Add single-command concurrency guard/semaphore helper.

### 3. Testing subpath

- [x] Add fake `Sandbox` layer.
- [x] Add in-memory `SandboxStateStore` layer.
- [x] Add unit tests.

### 4. Agent subpath

- [x] Implement environment-free `makeSandboxToolModuleFromApi` and Effectful `makeSandboxToolModule` builder.
- [x] Generate self-contained tool description from context.
- [x] Map `SandboxExpiredError` to model-visible tool result.
- [x] Map infra errors to fatal `ToolError`.
- [x] Mark tool access `destructive`.
- [x] Normalize optional `null` params.
- [x] Add tool tests.

### 5. Vercel subpath

- [x] Add `@vercel/sandbox` dependency.
- [x] Implement Vercel SDK seam/facade for unit tests.
- [x] Implement Vercel layer with lazy manual get/create.
- [x] Implement snapshot-source create path without `Sandbox.getOrCreate`.
- [x] Map disposable lifecycle to `persistent: false`, `timeout`, and `delete()`.
- [x] Implement additive `extendTimeout` delta math.
- [x] Implement cwd normalization and escape rejection.
- [x] Implement wrapper-file shell execution with stdin.
- [x] Implement foreground timeout by detached wait/kill, not Vercel `timeoutMs`.
- [x] Implement background 2s probe and `backgroundId`.
- [x] Implement preview URL extraction.
- [x] Persist state through `SandboxStateStore`.
- [x] Add adapter tests with fakes/seams.

### 6. Next Workflow wiring

- [ ] Add DB schema/store for sandbox state.
- [ ] Provide `SandboxStateStore` layer.
- [ ] Configure Vercel layer for `/agent/workflow`.
- [ ] Add `sandbox` tool module.
- [ ] Add `sandboxSessionId` to `AgentToolContext` or Workflow-local context.
- [ ] Keep subagent agent session ids distinct while reusing `sandboxSessionId`.
- [ ] Split Workflow text tool modules from shared portable/Cloudflare modules.
- [ ] Remove `just_bash` only from Workflow dogfood tools.
- [ ] Add cleanup path for expired disposable sandboxes.

### 7. Snapshot tooling

- [ ] Add app/script-owned base snapshot refresh command.
- [ ] Install `apply_patch`, `agent-browser`, Chromium deps, `rg`, `fd`, `jq`, and pinned pnpm.
- [ ] Document env var for base snapshot id.

### 8. Validation

- [ ] Run `pnpm packages:check`.
- [ ] Run `pnpm tsc`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm test:run` before broad merge.

## Inferred decisions

- `SandboxStateStoreError` is separate from `SandboxStateError`; store failures are host persistence failures, while state errors are decode/invariant failures.
- Package root should not import `@vercel/sandbox`; only `/vercel` does.
- The package may have `@vercel/sandbox` as a dependency because v0 is Vercel-first, but imports stay subpath-isolated.
- Cleanup should load persisted state, construct a Vercel layer for that `sandboxSessionId`, call `Sandbox.delete`, then clear state.
- `Sandbox.currentState` returns `Option.none()` if no state exists yet; after first command it returns saved state.
- Persistent lifecycle exists in types but should not be wired into Yolk dogfood until disposable is stable.
- `source: Snapshot` replaces `baseSnapshotId`; source variants are mutually exclusive by type.
- The Vercel adapter must not depend on `Sandbox.getOrCreate()` for snapshot sources.
- Command timeout is Yolk-owned; do not infer timeout from exit code `137`.
- Shared app tool modules stay runtime-portable; Vercel sandbox wiring lives outside `examples/next/lib/agents/tools/*`.
- Public package default max lifetime is 45m; app hosts can override to 4h only when their Vercel plan supports it.
- Stale or max-expired disposable state resets automatically before a command and reports `workspaceReset: true`.

## Open questions

None for v0 plan. Deferred non-v0 decisions live in Non-goals.

## Progress log

### 2026-06-13

- Researched Open Agents, Vercel Sandbox, E2B, Modal, Cloudflare Containers, Cloudflare Code Mode, and Executor.
- Cloned `vercel/sandbox` to `.repos/vercel-sandbox` and inspected v2.2.1 SDK behavior.
- Decided first provider is Vercel Sandbox.
- Decided default lifecycle is disposable with configurable auto-delete/expiry.
- Decided agent-facing surface is one trusted `sandbox` tool.
- Decided package uses Effect services and a host-provided `SandboxStateStore`.
- Deferred approval/policy engine from v0.
- Rewrote tracker with resolved decisions and inferred defaults.
- Verified `.repos/vercel-sandbox` is current with upstream `main` and npm `@vercel/sandbox@2.2.1`.
- Fixed plan for Vercel v2 realities: no SDK stdin, timeout exit `137`, additive timeout extension, snapshot source requiring manual create, and no `getOrCreate` for snapshot source.
- Resolved remaining v0 questions: Next DB table, cleanup trigger, source ADT, tool access, subagent sandbox sharing, and package-safe max lifetime.
- Added `@yolk-sdk/sandbox` package scaffold, core service/state/lifecycle models, testing fakes, agent tool, and Vercel Sandbox adapter seam/layer.
- Added package/unit tests for core, agent tool, and Vercel adapter fakes.
