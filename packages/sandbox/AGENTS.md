# Sandbox Package

`@yolk-sdk/sandbox` provides the domain-free execution plane contract for agents. The package models sandbox state, lifecycle, command execution, testing fakes, one agent-facing tool, and the Vercel Sandbox adapter over `@vercel/sandbox` 2.x.

## Subpaths

| Subpath | Source | Role |
| --- | --- | --- |
| `@yolk-sdk/sandbox` | `src/index.ts` | Core service, state, lifecycle, source, errors |
| `@yolk-sdk/sandbox/agent` | `src/agent.ts` | One trusted `sandbox` tool module over `@yolk-sdk/agent/tools` |
| `@yolk-sdk/sandbox/vercel` | `src/vercel` | Vercel Sandbox provider layer and test seam |
| `@yolk-sdk/sandbox/testing` | `src/testing` | Fake sandbox and in-memory state store layers |

## Boundaries

- Root/core imports Effect only; no provider SDKs, Node APIs, app code, React, Next, DB, or auth.
- Only `src/vercel/*` may import `@vercel/sandbox`.
- `src/agent.ts` may depend on `@yolk-sdk/agent/tools`, `@yolk-sdk/agent/protocol`, and `@yolk-sdk/agent/loop`; core must not.
- Hosts own identity, auth, storage adapters, lifecycle cleanup scans, env/secrets, snapshots, git policy, approvals, and UI.
- SDK only marks the `sandbox` tool destructive; hosts enforce safety/approval policy.
- Command failure is result data; provider/state/config failures are `ToolError`s with safe messages that the agent loop renders as failed tool results.

## Design rules

- One sandbox per host-provided `sandboxSessionId`.
- `sandboxSessionId` must already include user/session scope; package never models users.
- Vercel sandbox names are stable hashes from `sandboxSessionId`.
- Disposable lifecycle is default: 30m idle TTL, 45m max lifetime.
- Persistent lifecycle is modeled but dogfood should stay disposable until stable.
- Initial source is an ADT: empty, snapshot, git, or tarball. Snapshot replaces separate base-snapshot fields.
- Hosts choose Vercel env, ports, resources, runtime, and network policy; package stores no secrets.
- Vercel state store is a fast path: if empty, `get(name)` before `create(name)` and save reattached state.
- Stale or max-expired disposable state recreates before command and reports `workspaceReset: true`.
- `cwd` is workspace-relative; absolute paths and `..` escape are rejected.
- Stdin uses wrapper files because Vercel SDK commands have no stdin param.
- Timeout is Yolk-owned: run detached, wait with Effect timeout, kill on expiry; do not rely on Vercel `timeoutMs` exit `137`.
- Agent-facing surface stays one destructive `sandbox` tool.
- Agent tool `structuredContent` stays plain JSON; do not return Effect Schema class instances.
- Live Vercel smoke is manual/opt-in only; default tests use fakes/seams.
