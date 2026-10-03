# @yolk-sdk/codemode

Code mode for Yolk agents: one tool whose input is a short JavaScript program that calls the host's
resolved tools, filters and aggregates their results, and returns only what matters.

## Install

```bash
pnpm add @yolk-sdk/codemode@canary @yolk-sdk/agent@canary effect@4.0.0
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.
Use the SDK's matching Effect version (`4.0.0`) in host code.
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
- A call resolves to `structuredContent` for tools with an output schema and to the text content
  otherwise; error results, `beforeNestedCall` failures, and calls past `maxNestedCalls` reject
  with an `Error` whose message is `tools.<id>: <text>`, or `tools["<name>"]: <text>` for a tool
  whose identifier an earlier tool already uses (the nested-call record keeps the raw text). Calls
  still running when the script ends are cancelled and recorded as `cancelled`.
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
  byte-identical when they, or whole namespaces of them, change. One fixed line tells scripts to
  find unlisted tools with `searchTools(query, { limit?, namespace? })` (BM25 over names,
  descriptions, namespaces, and module descriptions), `describeTool(name)`, and
  `describeNamespace(name)`.
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
  `interruptedCallsUnavailable: true` instead of `interruptedCalls`.

Nested write calls are ledgered under `<toolCallId>/<seq>` and receive a stable `idempotencyKey`.
Calls the ledger policy skips (by default read-only calls) are not listed.

## Limits

| Limit              | Default | Notes                                                                    |
| ------------------ | ------- | ------------------------------------------------------------------------ |
| `timeoutMs`        | 120000  | Clamped to `deadline(context)` minus 5 s, never below 1 s                |
| `memoryLimitBytes` | 64 MiB  | QuickJS heap cap                                                         |
| `maxNestedCalls`   | 256     | Further calls reject; also sizes the `nestedCalls` record (at most 4096) |
| `maxOutputChars`   | 40000   | Head-and-tail cut with an omission marker                                |
| `maxImages`        | 8       | Later images are dropped with a note                                     |
| `maxImageBytes`    | 4 MiB   | Base64 characters of images in total                                     |

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

- Which tools are callable from scripts (`callableBy`, `discovery`), approvals, and policy.
- Run authority for nested calls: decorators around the `ToolExecutor` (outside
  `ResolvedToolSet.execute`) do not see nested calls. Use `beforeNestedCall` or registration-level
  wrappers for per-call checks.
  Approval, input, interaction, background, `question`, and `subagent` tools never run from code
  mode.
- Where the tool is advertised (voice sessions do not get it in v1), deadlines, and limits.
- Next.js: `serverExternalPackages: ['@yolk-sdk/codemode', '@earendil-works/pi-codemode', 'quickjs-wasi']`.
- Vercel Workflow: run the code mode call inside the tool-batch step (`'use step'`), never inside a
  `'use workflow'` function, and supply a durable tool ledger: steps are at-least-once.

## Boundaries

- The root is runtime-neutral (no Node builtins) and depends only on `@yolk-sdk/agent` and the pure
  declaration renderer of `@earendil-works/pi-codemode`; the worker-thread engine lives behind
  `./node`. `@yolk-sdk/agent` never imports code mode.
- The pi worker inherits a copy of `process.env`; scripts cannot read it (the VM has no `process`).
- pi buffers script text and image output on the host thread without a limit while the script
  runs; only the timeout bounds it. Results are bounded afterwards (`maxOutputChars`,
  `maxImages`, `maxImageBytes`).
- `stripTypeScriptTypes` is experimental in Node and prints one `ExperimentalWarning` per process.
