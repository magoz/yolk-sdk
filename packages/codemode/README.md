# @yolk-sdk/codemode

Code mode for Yolk agents: one tool whose input is a short JavaScript program that calls the host's
resolved tools, filters and aggregates their results, and returns only what matters.

## Install

```bash
pnpm add @yolk-sdk/codemode@canary @yolk-sdk/agent@canary effect@4.0.0-rc.115
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.
Use the SDK's matching Effect version (`4.0.0-rc.115`) in host code.
Requires Node.js 22.19+ (the pi engine's minimum). `@yolk-sdk/codemode/node` is server-only.

## Subpaths

| Subpath                   | Purpose                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `@yolk-sdk/codemode`      | Runtime-neutral: `makeCodeModeTool`, the `CodeModeExecutor` interface, catalog/discovery, store rebuild, classifier tool |
| `@yolk-sdk/codemode/node` | `makePiCodeModeExecutor`: QuickJS (WebAssembly) in a worker thread per script, on `@earendil-works/pi-codemode` 1.0.0    |

## Example

```ts
import { Effect } from 'effect'
import { resolveTools } from '@yolk-sdk/agent/tools'
import { codeModeStoreFromToolResults, makeCodeModeTool } from '@yolk-sdk/codemode'
import { makePiCodeModeExecutor } from '@yolk-sdk/codemode/node'

// One executor per process: its concurrency cap is per executor.
const executor = makePiCodeModeExecutor({ maxConcurrentExecutions: 4 })

const codemode = makeCodeModeTool<HostContext>({
  executor,
  deadline: context => context.stepDeadlineMs,
  loadStore: context => Effect.succeed(codeModeStoreFromToolResults(context.codeModeResults))
})

const toolSet =
  yield * resolveTools([{ id: 'codemode', tools: [codemode] }, ...hostModules], hostContext)
```

`HostContext`, `hostModules`, and `hostContext` are host-owned placeholders.

## How it works

- Scripts call tools as `await tools.<id>(args)`. Every nested call runs through the resolution's
  normal execute path (input decoding, enablement, registration wrappers, same host context), gets
  the id `<toolCallId>/<seq>`, and is recorded on the result's `nestedCalls` with status, duration,
  truncated error, and usage. Nested results never reach the model; only the script output and
  return value do.
- A call resolves to `structuredContent` for tools with an output schema and to the text content
  otherwise; error results reject with an `Error` carrying their text. Calls still running when
  the script ends are cancelled and recorded as `cancelled`.
- The tool description lists the globals and the nested tools by namespace. `codemode` + `listed`
  tools get TypeScript declarations within `inlineBudget` (default 3,000 estimated tokens, filled
  fairly across namespaces); `callableBy: 'all'` tools get one line each; `codemode` + `search`
  tools never appear, so the description stays stable when they change. Scripts find them with
  `searchTools(query, { limit?, namespace? })`, `describeTool(name)`, and
  `describeNamespace(name)`.
- Results start with `Script completed` or `Script failed`, include the wall time, output, and the
  JSON return value, and are cut head and tail at `maxOutputChars`. Failed scripts keep partial
  output and list the tool calls already made (they are not undone).
- `store(key, value)` writes of successful scripts are returned in
  `structuredContent.codemode.storeWrites`; `codeModeStoreFromToolResults` rebuilds the store from
  a transcript for `loadStore`.

## Limits

| Limit              | Default | Notes                                                     |
| ------------------ | ------- | --------------------------------------------------------- |
| `timeoutMs`        | 120000  | Clamped to `deadline(context)` minus 5 s, never below 1 s |
| `memoryLimitBytes` | 64 MiB  | QuickJS heap cap                                          |
| `maxNestedCalls`   | 256     | Further calls reject with an `Error`                      |
| `maxOutputChars`   | 40000   | Head-and-tail cut with an omission marker                 |

## Classifier tool

`makeClassifierTool({ classify })` wraps a `ClassifierModel` from `@yolk-sdk/agent/classification`
as a `codemode` + `listed` read tool (default name `classify`). Scripts classify one item per call;
calls beyond `maxConcurrency` (default 4, shared by every script using the registration) queue.

## Host responsibilities

- Which tools are callable from scripts (`callableBy`, `discovery`), approvals, and policy.
  Approval, input, interaction, background, `question`, and `subagent` tools never run from code
  mode.
- Where the tool is advertised (voice sessions do not get it in v1), deadlines, and limits.
- Next.js: `serverExternalPackages: ['@yolk-sdk/codemode', '@earendil-works/pi-codemode', 'quickjs-wasi']`.
- Vercel Workflow: run the code mode call inside the tool-batch step (`'use step'`), never inside a
  `'use workflow'` function.

## Boundaries

- The root is runtime-neutral (no Node builtins) and depends only on `@yolk-sdk/agent` and the pure
  declaration renderer of `@earendil-works/pi-codemode`; the worker-thread engine lives behind
  `./node`. `@yolk-sdk/agent` never imports code mode.
- The pi worker inherits a copy of `process.env`; scripts cannot read it (the VM has no `process`).
- `stripTypeScriptTypes` is experimental in Node and prints one `ExperimentalWarning` per process.
