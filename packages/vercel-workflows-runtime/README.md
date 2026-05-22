# @yolk-sdk/vercel-workflows-runtime

Vercel Workflow-specific contracts for durable agent model/tool step loops.

## Install

```bash
pnpm add @yolk-sdk/vercel-workflows-runtime@canary @yolk-sdk/agent@canary effect workflow
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Subpaths

| Subpath | Purpose |
| --- | --- |
| `@yolk-sdk/vercel-workflows-runtime` | Empty root export; reserved package entry |
| `@yolk-sdk/vercel-workflows-runtime/workflow` | Workflow-safe agent loop orchestration APIs |

## Imports

The root export is intentionally empty. Import Workflow APIs from `./workflow`:

```ts
import {
  noWorkflowStepRetry,
  runVercelAgentWorkflow
} from '@yolk-sdk/vercel-workflows-runtime/workflow'
```

## Runtime model

`runVercelAgentWorkflow` coordinates host-provided callbacks:

- model step: produce model events/tool calls
- tool batch step: execute requested tools
- awaiting-input state: carry pending HITL hook data between steps
- close step: flush/close output stream
- terminal status: completed, step failure, close failure, or max turns exceeded

Continuation state stays plain serializable data for Workflow persistence.

## Retry policy

Default retry policy is `noWorkflowStepRetry` (`maxAttempts: 1`). Retries are opt-in because streamed retries can duplicate chunks unless host/client de-dupe is ready.

## Host responsibilities

- Own Next/Vercel routes, auth, providers, tools, persistence, and telemetry.
- Encode/decode app transcript/session state into serializable Workflow inputs.
- Decide cancellation/resume/conflict UX.
- Own hook tokens and response validation for HITL resume.
- Test directive behavior with `@workflow/vitest` when changing package-owned Workflow files.

## Boundaries

- No Next routes, server actions, auth, app tools, DB, UI, or provider SDKs.
- Effect may run inside host/package step callbacks; workflow orchestration keeps plain data contracts.
