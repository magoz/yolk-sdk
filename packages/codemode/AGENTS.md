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
- Nested call ids are `<toolCallId>/<seq>` (1-based) so hosts can derive idempotency keys. Calls
  rejected by `maxNestedCalls` get no id and are not recorded.
- Record every executed nested call with `recordNestedToolCall`; calls still running when the script
  ends are interrupted (`FiberSet.clear`) and recorded `cancelled`. Never store nested results.
- Description: intro, globals one line each, nested tools by namespace. `codemode` + `listed` tools
  are declared with pi's renderer within `inlineBudget` (four characters per estimated token),
  chosen fairly (each round every namespace places its cheapest remaining tool; a namespace whose
  next tool does not fit drops out). `all` tools get one line and count against the budget.
  `search` tools never appear; namespace notes carry no counts so the text stays stable when search
  tools change.
- Globals (`searchTools`, `describeTool`, `describeNamespace`) cover every nested tool and are not
  recorded as calls.
- Store writes are reported only for successful scripts and only in `structuredContent.codemode`.
- The Node executor strips TypeScript with `node:module` `stripTypeScriptTypes` inside an async
  function wrapper (positions preserved) and maps failures to `script` errors; one sandbox (worker +
  VM) per execution, closed in `finally`; the per-executor concurrency cap counts queue time against
  the timeout.
- Code mode access is `write`; nested calls keep their own access metadata.
- `makeClassifierTool` takes the classifier `classify` function or service; provider options stay
  host-owned. `costUsd` has no `AgentUsage` field, so it stays in the result's `usage`.

## Tests

- `test/pi-executor.test.ts`: real pi executor end-to-end through `resolveTools`.
- `test/catalog.test.ts`: listing, fairness, stability, description hook, search.
- `test/tool.test.ts`: limits and plumbing with a fake executor, bounding, store rebuild.
- `test/classifier-tool.test.ts`: classifier tool through scripts, concurrency cap, errors.
