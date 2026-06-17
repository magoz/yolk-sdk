# @yolk-sdk/vercel-workflows

Vercel Workflow-specific contracts for durable agent model/tool step loops.

## Install

```bash
pnpm add @yolk-sdk/vercel-workflows@canary effect workflow
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Subpaths

| Subpath | Purpose |
| --- | --- |
| `@yolk-sdk/vercel-workflows` | Workflow-safe agent loop orchestration APIs |
| `@yolk-sdk/vercel-workflows/workflow` | Explicit equivalent subpath |

## Imports

Import Workflow APIs from the package root:

```ts
import {
  noWorkflowStepRetry,
  runVercelAgentWorkflow
} from '@yolk-sdk/vercel-workflows'
```

The `./workflow` subpath is also exported for explicit imports.

## Runtime model

`runVercelAgentWorkflow` coordinates host-provided callbacks:

- model step: produce model events/tool calls
- tool batch step: execute requested tools
- tool batch result: return one ordered tool-result message per host call, including failed `isError` results
- awaiting-input state: carry pending HITL hook data, wait through `awaitInput`, then rerun the
  same tool batch with accumulated responses
- close step: flush/close output stream
- terminal status: completed, step failure, await-input failure, close failure, or max turns exceeded

Continuation state stays plain serializable data for Workflow persistence.

## Minimal workflow wrapper

Host apps keep concrete Workflow directives local and pass them into the package loop:

```ts
import { createHook } from 'workflow'
import { runVercelAgentWorkflow } from '@yolk-sdk/vercel-workflows'

export async function runAgentWorkflow(input: { request: unknown; context: unknown }) {
  'use workflow'

  return await runVercelAgentWorkflow({
    input,
    runModelStep,
    runToolBatchStep,
    closeStream,
    writeError,
    awaitInput: async awaitingInput => {
      using hook = createHook<unknown>({ token: awaitingInput.hookToken })

      return await hook
    }
  })
}
```

`runModelStep`, `runToolBatchStep`, `closeStream`, and `writeError` are host-owned
`'use step'` functions. Keep provider calls, tools, persistence, telemetry, and Effect runtimes in
those steps, not in the `'use workflow'` orchestration body.

## Awaiting input

When a tool batch needs HITL input, return `awaitingInput` from `runToolBatchStep`. The package
loop will:

1. pass that payload to `awaitInput`
2. wait for the hook/webhook response
3. rerun the same tool batch with `hitlResponses: [...previous, response]`

The host owns `hookToken` construction, auth, resume routes, and response decoding. Use stable
tokens that the resume side can reconstruct or store.

## Retry policy

Default retry policy is `noWorkflowStepRetry` (`maxAttempts: 1`). Retries are opt-in because streamed retries can duplicate chunks unless host/client de-dupe is ready.

## Host responsibilities

- Own Next/Vercel routes, auth, providers, tools, persistence, and telemetry.
- Encode/decode app transcript/session state into serializable Workflow inputs.
- Preserve tool result order and never advance the next model step with dangling host tool calls.
- Decide cancellation/resume/conflict UX.
- Own hook tokens and response validation for HITL resume.
- Test directive behavior with `@workflow/vitest` when changing package-owned Workflow files.

## Boundaries

- No Next routes, server actions, auth, app tools, DB, UI, or provider SDKs.
- Effect may run inside host/package step callbacks; workflow orchestration keeps plain data contracts.
