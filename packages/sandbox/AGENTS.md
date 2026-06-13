# Sandbox Package

`@yolk-sdk/sandbox` provides the domain-free execution plane contract for agents. The package models sandbox state, lifecycle, command execution, testing fakes, one agent-facing tool, and the Vercel Sandbox v0 adapter.

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
- Command failure is result data; provider/state/config failures are Effect failures.

## Design rules

- One sandbox per host-provided `sandboxSessionId`.
- `sandboxSessionId` must already include user/session scope; package never models users.
- Vercel sandbox names are stable hashes from `sandboxSessionId`.
- Disposable lifecycle is default: 30m idle TTL, 45m max lifetime.
- Stale or max-expired disposable state recreates before command and reports `workspaceReset: true`.
- `cwd` is workspace-relative; absolute paths and `..` escape are rejected.
- Agent-facing surface stays one destructive `sandbox` tool.
