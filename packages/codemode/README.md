# @yolk-sdk/codemode

Code mode for Yolk agents: one tool whose input is a short JavaScript program that calls the host's
resolved tools, filters and aggregates their results, and returns only what matters.

## Install

```bash
pnpm add @yolk-sdk/codemode@canary @yolk-sdk/agent@canary effect@4.1.4
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.
Use the SDK's matching Effect version (`4.1.4`) in host code.
Requires Node.js 22.19+ (the pi engine's minimum). `@yolk-sdk/codemode/node` is server-only;
`@yolk-sdk/codemode/cloudflare` runs only in a Cloudflare Worker.

## Subpaths

| Subpath                         | Purpose                                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@yolk-sdk/codemode`            | Runtime-neutral: `makeCodeModeTool` (incl. `stage` for staged plans), the `CodeModeExecutor` interface, catalog/discovery, store rebuild, classifier tool |
| `@yolk-sdk/codemode/node`       | `makePiCodeModeExecutor`: QuickJS (WebAssembly) in a worker thread per script, on `@earendil-works/pi-codemode` 1.0.0                                     |
| `@yolk-sdk/codemode/cloudflare` | `makeDynamicWorkerCodeModeExecutor`: a fresh Dynamic Worker isolate (Worker Loader binding) per script, without network access                            |

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
  // Prior results paired with their tool names, oldest first (host-owned lookup).
  loadStore: context => Effect.succeed(codeModeStoreFromToolResults(context.priorToolResults))
})

const program = Effect.gen(function* () {
  const toolSet = yield* resolveTools(
    [{ id: 'codemode', tools: [codemode] }, ...hostModules],
    hostContext
  )

  return toolSet
})
```

`HostContext`, `hostModules`, and `hostContext` are host-owned placeholders.

## How it works

- Scripts call tools as `await tools.<id>(args)`. Every nested call runs through the resolution's
  normal execute path (input decoding, enablement, registration wrappers, same host context), gets
  the id `<toolCallId>/<seq>`, and is recorded on the result's `nestedCalls` with status, duration,
  truncated error, and usage. The record keeps up to `maxNestedCalls` calls, at most 4096
  (`nestedToolCallMaxRecordedCalls`; argument byte budgets still apply), and per-status `counts`
  over every call. Nested results never reach the model; only the script output and return value do.
- Typed results ([ADR 0013](https://github.com/magoz/yolk-sdk/blob/main/docs/adr/0013-typed-tool-results.md)):
  a tool with an output schema resolves to its value as declared (arrays and primitives included;
  file fields are `FileRef | FileUnavailable`); a typed result without a value rejects
  `tools.<id>: returned an invalid result`. A tool without one resolves to its text parts joined
  with newlines (`Promise<string>`); its files reach the model, not the script. Script values
  never contain file labels. Error results, `beforeNestedCall` failures, and calls past
  `maxNestedCalls` reject with an `Error` whose message is `tools.<id>: <text>`, or
  `tools["<name>"]: <text>` for a tool whose identifier an earlier tool already uses (the
  nested-call record keeps the raw text), with `error.code` when the tool reports a code
  (`ModelVisibleToolError.code`, a connector failure's code). Calls still running when the script
  ends are cancelled and recorded as `cancelled`.
- `type FileRef = { fileId, name, mimeType, size }` and
  `type FileUnavailable = { unavailable, name, mimeType }` are declared once in the description;
  signatures show file fields by name. Scripts pass `fileId`s to other tools; file bytes never
  enter the script.
- Arguments make a JSON round trip: `undefined` keys and `null` optionals are absent, unknown keys
  reject with a hint naming the allowed keys, and values JSON would silently change (`NaN`,
  `Infinity`, invalid `Date`s, `undefined` array items, `Map`, `Set`, functions, class instances)
  reject in the script before the call, with messages such as
  `tools.search: argument at limit is NaN; pass a finite number or omit the key`. The pi executor
  reads the argument once (getters and `toJSON` run once) into a checked JSON copy and sends that
  copy; a valid `Date` passes as its ISO string. Arguments with more than 100,000 values or more
  than 64 levels of nesting are rejected, never sent unchecked. Custom executors follow the same
  rules (`CodeModeExecutorTool`) and label rejections with `CodeModeExecutorTool.callLabel`, which
  `makeCodeModeTool` sets.
- The tool description lists the globals and the nested tools by namespace, with the module's
  `ToolModule.description` under each heading. `codemode` + `listed` tools get TypeScript
  declarations within `inlineBudget` (default 3,000 estimated tokens, filled fairly across
  namespaces); `callableBy: 'all'` tools get one line each outside the budget; `codemode` +
  `search` tools contribute nothing (no headings or hints), so the description stays
  byte-identical when they, or whole namespaces of them, change. `codemode` + `pinned` tools are
  always declared, outside the budget, and deferred (`loading: 'deferred'`) `all` tools count as
  `search` tools. One fixed line tells scripts to find unlisted tools with
  `searchTools(query, { limit?, namespace? })` (BM25 over names, descriptions, namespaces, and
  module descriptions): each hit has a one-line `signature` with the argument and result types
  (`codeModeToolSignature`; past 800 characters it is cut with a `describeTool` pointer). The
  description tells the model to call a tool whose exact name it already knows (listed, returned
  by an earlier search, or called before) without searching, and never to call a tool in the same
  script that found it: ranking is lexical and hits carry no access metadata, so an unseen hit
  could be a write. `describeTool(name)` gives the full documented declaration and
  `describeNamespace(name)` a namespace's tools.
- Results start with `Script completed` or `Script failed`, include the wall time, output, and the
  JSON return value, and are cut head and tail at `maxOutputChars`. Images beyond `maxImages` or
  `maxImageBytes` are dropped with a note. Failed scripts keep partial output and list the tool
  calls already made (they are not undone).
- `store(key, value)` writes of successful scripts are returned in
  `structuredContent.codemode.storeWrites`. `codeModeStoreFromToolResults(entries, { toolName? })`
  rebuilds the store for `loadStore` from `{ toolName, result }` entries, oldest first; it applies
  only results of the code mode tool (default `codemode`), so other tools cannot spoof writes, and
  keeps the 256 KiB-per-value and 1 MiB-total bounds by dropping offending writes. Transcript
  `ToolResultMessage`s carry no tool name: pair each with its assistant tool call's name.
- `beforeNestedCall({ call, context })` runs before each nested call; a failure rejects that call in
  the script with `<label>: <message>` and records it as `error` without executing it.
- `afterNestedCall({ call, outcome, durationMs, context, result? })` runs after each admitted
  nested call with `success`, `failure` (error result or unexpected failure), or `interrupted`
  (cancelled, for example still running when the script ended). Calls rejected before running are
  not reported. A failing hook (a failure, a defect, or a synchronous throw) is logged and never
  changes the call's result.
- A nested call that paused for a person's input (its error result carries the
  `input_required` marker, `toolInputRequired` from `@yolk-sdk/agent/protocol`) rejects with
  `error.code === 'input_required'`. It has not completed: whether or not the script caught the
  rejection, `structuredContent.codemode.inputRequired` lists every such pause
  (`ToolInputRequiredRef`s, merged per review tool) and a notice after the bounded output names the
  review call (`review_input({"pauseIds":[...]})`). See
  [ADR 0014](https://github.com/magoz/yolk-sdk/blob/main/docs/adr/0014-input-required-tool-calls.md).
- A nested call that is interrupted rejects with `<label> was cancelled.`; a defect rejects with
  `<label> failed unexpectedly.` (the same label as above). If an executor misses its deadline, the tool returns a `timeout` failure
  `timeoutMs` + 5 s after the start and aborts it.

## Re-execution and the tool ledger

Hosts that re-execute steps (Vercel Workflow's queue is at-least-once) pass a durable ledger to
`resolveTools(modules, context, { ledger: { store } })` (see `@yolk-sdk/agent/tools`). The
`codemode` call is itself ledgered, so a re-executed call never runs its script again:

- completed: the stored result is returned;
- still running elsewhere: the call waits for it (up to `maxWaitMs`/`deadline`);
- abandoned (the earlier execution crashed): an interrupted error result lists that script's
  ledgered nested calls as applied, failed, or unknown (started, no recorded result), states that
  they were not undone, and asks the model to verify. Hosts get the same entries in
  `structuredContent.codemode` without calling the store again:
  `{ ok: false, interrupted: true, interruptedCalls: { calls, complete, counts } }`, where each call
  is `{ key, toolName, args, status: 'applied' | 'failed' | 'unknown' }` (`args` compact JSON cut
  with a trailing `…`), bounded like `nestedCalls` (`maxNestedCalls` calls, 8 KiB of arguments per
  call, 32 KiB in total; `complete: false` when cut, here or by the ledger), and `counts` covers
  every entry. Types: `CodeModeInterruptedCalls`, `CodeModeInterruptedCall`,
  `CodeModeInterruptedCallStatus`. When the ledger cannot list the nested calls, the result stays
  interrupted, says they may already have been applied, and sets
  `interruptedCallsUnavailable: true` instead of `interruptedCalls`. When the script had already
  saved its staged plan (see Staged writes), the result names it as a finished script would
  (`codemode.plan` and the plan notice), read from the plan store under the call's plan id.

Nested write calls are ledgered under `<toolCallId>/<seq>` and receive a stable `idempotencyKey`.
Calls the ledger policy skips (by default read-only calls) are not listed.

## Staged writes

When the resolution has plans (`resolveTools(..., { interactionHost, plans: { store } })`) and a
plan review tool (`makePlanReviewTool` from `@yolk-sdk/agent/tools`), scripts get
`await stage(name, args)` for approval-gated tools marked `staging`. `stage` validates the arguments
and records the call without running or ledgering it. Once a script stages, it may only run read
tools, and `stage` is rejected after a direct write; duplicates and calls past
`maxCalls`/`maxArgsBytes` are rejected. A successful script saves
the plan once and its result tells the model to call `review_plan({ planId, planDigest })`
(`structuredContent.codemode.plan`); a failed script discards its staged calls. Approval-gated tools
stay fail-closed for `tools.<name>()`. Pass `staging: false` to turn it off or `staging: { maxCalls }`
to lower the cap.

A stageable tool may be **stage-only** (`callableBy: 'codemode'`, usually with `discovery: 'search'`):
it is never declared to the model, scripts find it with `searchTools()` (hits marked
`stageOnly: true`, with the `stage("<name>", args)` signature), and the only thing they can do with it is
`stage()` it. Model-callable stageable tools (`all`, deferred or not) are found the same way. See
[ADR 0007](https://github.com/magoz/yolk-sdk/blob/main/docs/adr/0007-tool-exposure-and-catalog.md).

Applied plan calls run inside the review action: they bypass `beforeNestedCall` and `ToolExecutor`
decorators. Wire the same per-call check as `makePlanReviewTool({ beforeCall })`. An applied call
that pauses for input is reported `input_required` and does not stop the apply. Review screens
show each staged call with the tool's `changePreview` from `@yolk-sdk/agent/tools`. See
[ADR 0005](https://github.com/magoz/yolk-sdk/blob/main/docs/adr/0005-staged-tool-plans.md) and
[ADR 0006](https://github.com/magoz/yolk-sdk/blob/main/docs/adr/0006-tool-change-previews.md).

## Catalog as instructions

`makeCodeModeTool({ executor, catalog: 'instructions' })` keeps the `codemode` description
invariant and delivers the catalog (every namespace with its tool count, listed tools within
`inlineBudget`, `pinned` tools always) as a host instruction: pass `toolSet.instructions` to
`RunConfig.instructions`, or, for durable hosts driving `runModelTurn`, append and persist
`instructionMessages(transcript, toolSet.instructions)` from `@yolk-sdk/agent/loop` before each
model step. A changed catalog is appended to the conversation, whole, instead of rewriting the
cached request prefix. Hosts with their own compaction keep `latestInstructionMessages(...)` from
`@yolk-sdk/agent/protocol` after their summary, as window compaction does.

## Limits

| Limit              | Default | Notes                                                                    |
| ------------------ | ------- | ------------------------------------------------------------------------ |
| `timeoutMs`        | 120000  | Clamped to `deadline(context)` minus 5 s, never below 1 s                |
| `memoryLimitBytes` | 64 MiB  | QuickJS heap cap                                                         |
| `maxNestedCalls`   | 256     | Further calls reject; also sizes the `nestedCalls` record (at most 4096) |
| `maxOutputChars`   | 40000   | Head-and-tail cut with an omission marker                                |
| `maxImages`        | 8       | Later images are dropped with a note                                     |
| `maxImageBytes`    | 4 MiB   | Base64 characters of images in total                                     |

## Cloudflare Workers

A Worker cannot start worker threads, so `makePiCodeModeExecutor` does not run there.
`makeDynamicWorkerCodeModeExecutor` runs each script in a fresh
[Dynamic Worker](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/)
isolate instead, with `globalOutbound: null` (no network access). The isolate evaluates pi's prelude
(vendored from `@earendil-works/pi-codemode` 1.0.0, MIT) around the script, so scripts see the same
globals (`tools`, `ALL_TOOLS`, `text`, `image`, `exit`, `console`, `store`/`load`) and the same
tools guard and rejection codes as on Node. Tool and global calls come back to the calling Worker
over RPC. TypeScript annotations are stripped with Sucrase first; Sucrase loads when the first script
runs (a dynamic `import()`, once per isolate), so importing `./cloudflare` or creating the executor
does not evaluate it.

```ts
import { env } from 'cloudflare:workers'
import { makeCodeModeTool } from '@yolk-sdk/codemode'
import { makeDynamicWorkerCodeModeExecutor } from '@yolk-sdk/codemode/cloudflare'

// The binding is read when a script runs, so the executor can live at module scope.
const executor = makeDynamicWorkerCodeModeExecutor({ loader: () => env.LOADER })

const codemode = makeCodeModeTool<HostContext>({ executor })
```

The Worker declares a Worker Loader binding (`"worker_loaders": [{ "binding": "LOADER" }]` in
Wrangler; the name is the host's). `env.LOADER` typed by Workers types satisfies `WorkerLoader`.
`compatibilityDate` (default `2026-05-12`) sets the script isolate's date.

Limits and lifetime:

- `cpuMs` (default 500, `defaultDynamicWorkerCpuMs`) is passed as the loaded Worker's
  `limits.cpuMs` and is the real ceiling of a script. Time spent waiting for tool calls is not CPU
  time. A script past it fails with `timeout` (`Execution exceeded its CPU limit of <cpuMs> ms`).
- The timeout and abort signal only answer the caller early: a synchronous loop cannot be stopped
  from the calling Worker, so the isolate may keep running (and billing) until its CPU limit.
- When an execution ends (result, timeout, abort, failure), tool and global calls still pending
  are answered at once with a fixed rejection (`The script ended before this call settled; await
every tool call before returning.`) and their signal aborts; calls arriving later get the same
  rejection without running. A Dynamic Worker counts as in flight while it waits on the host
  (Cloudflare allows 4 per request, 10 per Durable Object), so an unawaited call never keeps one
  open. The loaded Worker and its entrypoint are disposed (`Symbol.dispose`) right after.
- Every execution is one `load()`, which Cloudflare bills as one Dynamic Worker.

Errors: what the script controls reaches the caller as on Node (its thrown error's name, message
and stack, parse errors, tool and global rejections). Failures of the loader or the isolate itself
become fixed messages (`sandbox`: `Could not load the script sandbox.`, `The script sandbox
failed.`; `timeout` past the CPU limit), and a call whose RPC to the host fails rejects with `The
call could not reach the host.`; the runtime's error text never reaches the caller or the script.
`onInternalError` receives the original error for host logs ([Internal errors](#internal-errors)).

Other differences from the Node executor: `memoryLimitBytes` does not apply (Workers bound isolate
memory themselves); there is no per-executor concurrency cap; stack frames are not filtered.

## Internal errors

Both executors answer their own failures (not the script's) with fixed messages, so runtime error
text, which may carry host details or secrets, never reaches the script, the result, or the model.
To log the original error, pass `onInternalError` (`CodeModeInternalErrorObserver`):

```ts
const executor = makeDynamicWorkerCodeModeExecutor({
  loader: () => env.LOADER,
  // Host logs only: `cause` may carry secrets; never return it to the model.
  onInternalError: ({ stage, cause }) => logger.error('code mode executor failed', { stage, cause })
})
```

| `stage`     | Executor        | Fixed message the caller or script sees                     | `cause`                                                               |
| ----------- | --------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `load`      | Dynamic Workers | `sandbox`: `Could not load the script sandbox.`             | What loading Sucrase, `loader()`, `load()` or `getEntrypoint()` threw |
| `load`      | pi (Node)       | `sandbox`: `Could not create the sandbox.`                  | What `new CodemodeSandbox` threw                                      |
| `isolate`   | Dynamic Workers | `sandbox`: `The script sandbox failed.`                     | The isolate's `run` error                                             |
| `isolate`   | pi (Node)       | `sandbox`: `The script sandbox failed.`                     | pi's `sandbox` error record                                           |
| `cpu-limit` | Dynamic Workers | `timeout`: `Execution exceeded its CPU limit of <cpuMs> ms` | The isolate's `run` error                                             |
| `host-call` | Dynamic Workers | The call rejects with `The call could not reach the host.`  | The RPC error the isolate saw                                         |

It is called once per such failure and never for what the script controls (its errors, parse
errors, tool and global rejections), timeouts, or aborts; an isolate that fails after the execution
already timed out or was aborted is not reported. Whatever it throws or rejects with is ignored.
`host-call` reports come from the script's isolate, which the script shares, so a script can fake
one; the executor accepts at most `maxDynamicWorkerHostCallFailureReports` (10) per execution.

## Classifier tool

`makeClassifierTool({ classify })` wraps a `ClassifierModel` from `@yolk-sdk/agent/classification`
as a `codemode` + `listed` read tool (default name `classify`). Scripts classify one item per call;
calls beyond `maxConcurrency` (default 100 per script, keyed by the parent tool call id) queue.
Each call then takes a permit from `processLimiter`, shared across scripts and registrations:
`defaultClassifierProcessLimiter` (200 per process) unless you pass one built with
`makeClassifierConcurrencyLimiter(max)` or `false`. An interrupted waiting call releases its
permits. Nested-call records carry token usage; cost stays in the result's
`structuredContent.usage`.

## Host responsibilities

- Which tools are callable from scripts (`callableBy`, `discovery`, `loading`), approvals, and policy.
- Run authority for nested calls: decorators around the `ToolExecutor` (outside
  `ResolvedToolSet.execute`) do not see nested calls. Use `beforeNestedCall` or registration-level
  wrappers for per-call checks.
  Approval, input, interaction, background, `question`, and `subagent` tools never run from code
  mode (stageable approval tools are only staged, and run after review through the plan review
  tool, whose `beforeCall` is their per-call check).
- Where the tool is advertised (voice sessions do not get it in v1), deadlines, and limits.
- Next.js: `serverExternalPackages: ['@yolk-sdk/codemode', '@earendil-works/pi-codemode', 'quickjs-wasi']`.
- Vercel Workflow: run the code mode call inside the tool-batch step (`'use step'`), never inside a
  `'use workflow'` function, and supply a durable tool ledger: steps are at-least-once.

## Boundaries

- The root is runtime-neutral (no Node builtins) and depends only on `@yolk-sdk/agent` and the pure
  declaration renderer of `@earendil-works/pi-codemode`; the worker-thread engine lives behind
  `./node`, and the Dynamic Worker engine (`cloudflare:workers`, Sucrase) behind `./cloudflare`.
  `@yolk-sdk/agent` never imports code mode.
- The pi worker inherits a copy of `process.env`; scripts cannot read it (the VM has no `process`).
- pi buffers script text and image output on the host thread without a limit while the script
  runs; only the timeout bounds it. Results are bounded afterwards (`maxOutputChars`,
  `maxImages`, `maxImageBytes`).
- `stripTypeScriptTypes` is experimental in Node and prints one `ExperimentalWarning` per process.
