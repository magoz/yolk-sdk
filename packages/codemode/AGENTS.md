# Code Mode Package

`@yolk-sdk/codemode` implements code mode (`docs/adr/0002-code-mode.md`): a tool whose scripts call
the other code-mode-callable tools of the same `resolveTools` resolution. The agent tool contract
(`callableBy`, `discovery`, output schemas, nested tool access, nested-call records, the `describe`
hook) lives in `@yolk-sdk/agent`; this package never redefines it.

## Subpaths

| Subpath                   | Source         | Role                                                                                      |
| ------------------------- | -------------- | ----------------------------------------------------------------------------------------- |
| `@yolk-sdk/codemode`      | `src/index.ts` | Executor interface, `makeCodeModeTool`, catalog, search, bounding, store, classifier tool |
| `@yolk-sdk/codemode/node` | `src/node.ts`  | `makePiCodeModeExecutor` over `@earendil-works/pi-codemode` (exact 1.0.0)                 |

Files: `executor.ts` (engine-neutral `CodeModeExecutor` types), `catalog.ts` (nested tool catalog,
fair listing, description), `search.ts` (BM25 `searchTools`), `output.ts` (result text, head-and-tail
bounding, call summary), `store.ts` (`codeModeStoreFromToolResults`), `tool.ts`
(`makeCodeModeTool`), `classifier-tool.ts` (`makeClassifierTool`), `node.ts` (pi executor).

## Boundaries

- Root code is runtime-neutral: no Node builtins, no pi runtime (`@earendil-works/pi-codemode` root
  or `/worker`, `quickjs-wasi`), and no `./node` import. Only the pure
  `@earendil-works/pi-codemode/declarations` (and `/source`) subpaths are allowed. Boundary-enforced.
- Among Yolk packages, code mode depends only on `@yolk-sdk/agent` (`protocol`, `loop`, `tools`,
  `classification`); `@yolk-sdk/agent` never imports code mode.
- The executor interface is Promise-based on purpose: engines (pi, a Workers executor) plug in
  without Effect. `makeCodeModeTool` bridges with `Effect.tryPromise` (its signal aborts the script
  on interruption) and runs nested calls as fibers of a `FiberSet` scoped to the tool call, forked
  with the call's services and interrupted through the nested call's signal; never use a detached
  `Effect.runPromise`.

## Design rules

- Nested calls go only through `nested.execute` (the resolved execute path). Never call tool
  executors directly; never bypass input decoding or registration wrappers.
- Host decorators around the `ToolExecutor` (outside `ResolvedToolSet.execute`) never see nested
  calls. Per-call run-authority checks belong in `beforeNestedCall` (a failure rejects the call in
  the script and records it as `error` without executing) or registration-level wrappers.
- A nested fiber that ends with interrupts only rejects with `was cancelled`; any other failure
  (a defect) rejects with `failed unexpectedly` and records `error`.
- `executor.execute` has an Effect backstop at `timeoutMs` + 5 s (`timeout` failure, signal
  aborted); waits for nested fibers to stop after interruption are bounded by 5 s each.
- Nested call ids are `<toolCallId>/<seq>` (1-based) so hosts can derive idempotency keys. Calls
  rejected by `maxNestedCalls` get no id and are not recorded.
- Record every executed nested call with `recordNestedToolCall`; calls still running when the script
  ends are interrupted (`FiberSet.clear`) and recorded `cancelled`. Never store nested results.
- Description: intro, globals one line each, nested tools by namespace (with the module
  `description` under the heading), then one fixed line pointing to `searchTools`/`describeTool`/
  `describeNamespace`. `codemode` + `listed` tools are declared with pi's renderer within
  `inlineBudget` (four characters per estimated token), chosen fairly (each round every namespace
  places its cheapest remaining tool; a namespace whose next tool does not fit drops out). `all`
  tools get one line each outside the budget. `search` tools never contribute anything (no
  headings, hints, or counts), so adding or removing them, even whole namespaces, leaves the text
  byte-identical.
- Globals (`searchTools`, `describeTool`, `describeNamespace`) cover every nested tool and are not
  recorded as calls.
- Store writes are reported only for successful scripts and only in `structuredContent.codemode`.
  `codeModeStoreFromToolResults` takes `{ toolName, result }` entries and applies only results of
  the configured code mode tool name; it keeps pi's bounds (256 Ki characters of JSON per value,
  1 Mi in total with keys) by dropping offending writes, keeping the previous value.
- Results keep at most `maxImages` (8) images and `maxImageBytes` (4 MiB of base64); later images
  are dropped with a note. pi buffers output on the host thread without a limit while a script
  runs; only the timeout bounds it.
- The Node executor strips TypeScript with `node:module` `stripTypeScriptTypes` inside an async
  function wrapper (positions preserved) and maps failures to `script` errors; one sandbox (worker +
  VM) per execution, closed in `finally`; the per-executor concurrency cap counts queue time against
  the timeout.
- Code mode access is `write`; nested calls keep their own access metadata.
- `makeClassifierTool` takes the classifier `classify` function or service; provider options stay
  host-owned. The concurrency cap is per script: semaphores are keyed by the parent tool call id
  of `<parentToolCallId>/<seq>` (else the call id) and removed when idle. `costUsd` has no
  `AgentUsage` field: nested-call records carry token usage only, and cost stays in the result's
  `structuredContent.usage`.

## Tests

- `test/pi-executor.test.ts`: real pi executor end-to-end through `resolveTools`.
- `test/catalog.test.ts`: listing, fairness, stability, description hook, search.
- `test/tool.test.ts`: limits and plumbing with a fake executor (defects, `beforeNestedCall`,
  backstops), bounding, store rebuild and bounds.
- `test/pi-executor.test.ts` also covers store and image limits, cancellation, and the executor
  concurrency cap.
- `test/classifier-tool.test.ts`: classifier tool through scripts, per-script cap, errors.
