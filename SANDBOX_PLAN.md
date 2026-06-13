# Sandbox plan

## Status

Decision pass complete. This is the working tracker until `@yolk-sdk/sandbox` exists. Move stable package-local details to `packages/sandbox/README.md` and `packages/sandbox/AGENTS.md` during implementation.

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
- `.repos/vercel-sandbox` cloned at 2026-06-13, package `@vercel/sandbox@2.2.1`

Relevant v2 findings:

- stable identifier is `name`, not `sandboxId`;
- `persistent` defaults to `true`;
- `persistent: false` opts out of automatic filesystem snapshots;
- `timeout` auto-stops current session;
- persistent sandboxes can auto-resume on SDK calls;
- `Sandbox.getOrCreate()` handles missing/expired named sandboxes;
- `sandbox.delete()` permanently deletes sandbox, sessions, and snapshots;
- `await using` only calls `stop()`, not `delete()`;
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
| Tool params | `command`, `cwd?`, `stdin?`, `timeoutSeconds?`, `background?`. No `purpose`. |
| Command form | Shell string, multiline allowed, run through non-interactive bash. |
| Working dir | `cwd` is workspace-relative only. Absolute cwd rejected. |
| Stdin | Supported; primary channel for large patches/scripts/data. |
| Output | Split stdout/stderr; 50k model-visible char cap; truncation flag. |
| Foreground timeout | Default 120s, max 600s. |
| Background v0 | Start only; 2s quick probe; no logs/kill/list API yet. |
| Preview URLs | Included in tool description and command metadata. No preview tool. |
| Tool surfaces | Package is surface-agnostic. Yolk enables Workflow/text first; voice later if desired. |
| Dogfood route | Wire `/agent/workflow` first. |
| `just_bash` | Remove/retire exposure when sandbox lands. No migration/backcompat docs needed. |
| Session scope | One sandbox per agent session/conversation. |
| Vercel name | `sandbox-{safeSessionId}` via sanitize/hash helper. |
| State | Provider-tagged plain JSON. Host DB stores it. |
| State store | Package defines `SandboxStateStore`; `Sandbox` service depends on it. |
| State key | Store keyed by app `sessionId`. |
| Lazy lifecycle | `Sandbox.run` lazily get-or-creates on first command. |
| Persistence source | Host DB owns lifecycle timestamps; Vercel owns live status. |
| Disposable default | `persistent: false`, idle TTL 30m, max lifetime 4h. |
| Touch behavior | Each command extends/restores idle TTL, capped by max lifetime. |
| Max lifetime | No new commands after max lifetime; cleanup deletes sandbox. Current command may finish. |
| Cleanup | Host scheduler scans DB; package exposes single-session delete, no batch helper v0. |
| Delete primitive | Use Vercel `sandbox.delete()` for disposable cleanup. |
| Base snapshot | Host/app supplies `baseSnapshotId`. Package only consumes it. |
| Bootstrap | No heavy bootstrap. Optional minimal bootstrap only. Full browser/tools require snapshot. |
| Snapshot creation | App/script-owned (`pnpm sandbox:snapshot-base` later), not package API v0. |
| `apply_patch` | Base snapshot owns `apply_patch` on PATH. Package does not detect/install it. |
| Snapshot tool detection | No hard detection of `apply_patch`/`agent-browser`; command failure is enough. |
| Resources | Default 2 vCPU, host-overridable. |
| Runtime | Vercel `node24` default. |
| Ports | Default `[3000, 5173, 4321, 8000]`. |
| Source checkout | Vercel `source` passthrough only. Auth/branch policy app-owned. |
| Env | Host-provided `env`; package owns no secrets. |
| Network | Allow-all default; Vercel-specific network policy passthrough. |
| Errors | Multiple tagged errors plus `SandboxError` union alias. |
| Command failure | Nonzero exit and timeout are command result data, not Effect failure. |
| Expired error mapping | `SandboxExpiredError` becomes model-visible tool error. |
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
  readonly currentState: Effect.Effect<SandboxState, SandboxStateError>
  readonly delete: Effect.Effect<void, SandboxProviderError | SandboxStateStoreError>
}

export class Sandbox extends Context.Service<Sandbox, SandboxApi>()(
  '@yolk-sdk/sandbox/Sandbox'
) {}
```

`Sandbox.run` lazily creates/connects the provider sandbox, runs one command, updates lifecycle state, saves through `SandboxStateStore`, and returns command metadata.

### State store service

```ts
export type SandboxStateStoreApi = {
  readonly load: (sessionId: string) => Effect.Effect<Option.Option<SandboxState>, SandboxStateStoreError>
  readonly save: (input: { readonly sessionId: string; readonly state: SandboxState }) => Effect.Effect<void, SandboxStateStoreError>
  readonly clear: (sessionId: string) => Effect.Effect<void, SandboxStateStoreError>
}

export class SandboxStateStore extends Context.Service<SandboxStateStore, SandboxStateStoreApi>()(
  '@yolk-sdk/sandbox/SandboxStateStore'
) {}
```

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
  maxLifetimeMs: 4 * 60 * 60_000
}
```

Persistent is modeled now so the type is not a dead end, but v0 dogfood uses disposable only.

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
  readonly sessionId: string
  readonly lifecycle?: SandboxLifecycle
  readonly baseSnapshotId?: string
  readonly source?: VercelSandboxSource
  readonly env?: Record<string, string>
  readonly ports?: ReadonlyArray<number>
  readonly resources?: { readonly vcpus: number }
  readonly runtime?: 'node22' | 'node24' | 'node26' | 'python3.13'
  readonly networkPolicy?: VercelNetworkPolicy
}
```

Defaults:

```ts
{
  lifecycle: { _tag: 'Disposable', idleTtlMs: 30 * 60_000, maxLifetimeMs: 4 * 60 * 60_000 },
  ports: [3000, 5173, 4321, 8000],
  resources: { vcpus: 2 },
  runtime: 'node24',
  persistent: false,
  timeout: 30 * 60_000
}
```

Vercel mapping:

- create/get by `name = sandbox-{safeSessionId}`;
- disposable create uses `persistent: false`;
- `timeout` starts at idle TTL;
- each command extends timeout to restore idle TTL without exceeding max lifetime;
- delete uses `sandbox.delete()`;
- preview URLs use `sandbox.domain(port)` for configured ports;
- Vercel SDK credentials come from OIDC/env.

## Agent tool

Tool name:

```txt
sandbox
```

Params:

```ts
type SandboxToolInput = {
  readonly command: string
  readonly cwd?: string
  readonly stdin?: string
  readonly timeoutSeconds?: number
  readonly background?: boolean
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
- stdout/stderr are split and capped to 50k model-visible chars total.

Model-visible result:

```txt
exit_code: 0
duration_ms: 1234
truncated: false
timed_out: false
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
  readonly backgroundId?: string
  readonly previewUrls: ReadonlyArray<{ readonly port: number; readonly url: string }>
  readonly state: SandboxState
}
```

Description is generated from host/provider context and is self-contained. It should mention available capabilities such as `apply_patch`, `agent-browser`, package managers, preview URLs, and disposable lifecycle.

## Base snapshot

The package consumes `baseSnapshotId`; it does not create or refresh snapshots in v0.

Desired Yolk/Speldosa base snapshot contents:

- git;
- ripgrep (`rg`);
- fd;
- jq;
- Node.js + pnpm/npm/bun;
- `apply_patch` on PATH;
- `agent-browser` + Chromium dependencies;
- `executor` later, not required for v0.

Snapshot creation is app/script-owned, likely:

```txt
pnpm sandbox:snapshot-base
```

No package hard-failure if expected commands are missing. The command fails naturally inside the sandbox.

## Host responsibilities

Hosts own:

- DB-backed `SandboxStateStore` implementation;
- cleanup scheduler scanning expired sessions;
- session id source and auth;
- env/secrets injection;
- base snapshot id;
- optional Vercel git source/auth/branch policy;
- commit/push/PR broker;
- UI for diffs/logs/changed files;
- future policy/approval wrapper if needed.

## Yolk dogfood plan

- Add package.
- Add DB-backed sandbox state store in `examples/next`.
- Wire Vercel layer and `sandbox` tool into `/agent/workflow` first.
- Remove `just_bash` from exposed tool modules.
- Keep package surface-agnostic; do not add voice-specific restrictions in package.
- Add cleanup job/route/script after first working path.

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

- Core tests: lifecycle math, name sanitization/hash, timeout caps, output formatting/truncation, state schemas.
- Agent tests: fake `Sandbox` service, tool param validation, successful result, nonzero exit, timeout, background id, expired mapping.
- Vercel tests: adapter unit tests behind seams/fakes; no live Vercel in default tests.
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

- [ ] Add `packages/sandbox` workspace package.
- [ ] Add `README.md`, `AGENTS.md`, `CHANGELOG.md`.
- [ ] Export root, `/agent`, `/vercel`, `/testing`.
- [ ] Add package to `packages/AGENTS.md`, root `README.md`, `patterns/PACKAGE_ARCHITECTURE.md`.
- [ ] Update package export/boundary/smoke scripts.

### 2. Core

- [ ] Define command input/result schemas.
- [ ] Define state/lifecycle schemas.
- [ ] Define tagged errors and alias.
- [ ] Define `Sandbox` service.
- [ ] Define `SandboxStateStore` service.
- [ ] Add name sanitization/hash helper.
- [ ] Add lifecycle math helpers.

### 3. Testing subpath

- [ ] Add fake `Sandbox` layer.
- [ ] Add in-memory `SandboxStateStore` layer.
- [ ] Add unit tests.

### 4. Agent subpath

- [ ] Implement `makeSandboxToolModule`.
- [ ] Generate self-contained tool description from context.
- [ ] Map `SandboxExpiredError` to model-visible tool result.
- [ ] Map infra errors to fatal `ToolError`.
- [ ] Add tool tests.

### 5. Vercel subpath

- [ ] Add `@vercel/sandbox` dependency.
- [ ] Implement Vercel layer with lazy get/create.
- [ ] Map disposable lifecycle to `persistent: false`, `timeout`, and `delete()`.
- [ ] Implement shell execution with cwd/stdin/timeouts/background probe.
- [ ] Implement preview URL extraction.
- [ ] Persist state through `SandboxStateStore`.
- [ ] Add adapter tests with fakes/seams.

### 6. Next Workflow wiring

- [ ] Add DB schema/store for sandbox state.
- [ ] Provide `SandboxStateStore` layer.
- [ ] Configure Vercel layer for `/agent/workflow`.
- [ ] Add `sandbox` tool module.
- [ ] Remove `just_bash` from exposed tools.
- [ ] Add cleanup path for expired disposable sandboxes.

### 7. Snapshot tooling

- [ ] Add app/script-owned base snapshot refresh command.
- [ ] Install `apply_patch`, `agent-browser`, Chromium deps, `rg`, `fd`, `jq`.
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
- Cleanup should load persisted state, construct a Vercel layer for that session id, call `Sandbox.delete`, then clear state.
- `Sandbox.currentState` should fail if no state exists yet; after first command it returns saved state.
- Persistent lifecycle exists in types but should not be wired into Yolk dogfood until disposable is stable.

## Open questions

| Question | Current leaning | Status |
| --- | --- | --- |
| Base snapshot contents exact install script? | App-owned script, decide during snapshot task | Open |
| DB table shape in Next app? | Small `agent_sandbox_state` keyed by session id | Open |
| Cleanup trigger? | Cron/route/script after first working path | Open |
| Include `executor` in base snapshot? | Later, not v0 | Open |

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
