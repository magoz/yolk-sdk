# @yolk-sdk/codemode

## 0.1.0-canary.103

### Minor Changes

- e4ca456: Add staged tool plans (ADR 0005): code mode scripts stage approval-gated writes for one human review instead of running them, and Yolk applies exactly the calls the person selects.

  - Mark tools stageable with `makeTool({ approval, staging })` (`ToolDef.staging`, `isToolStageable`; optional `staging.precheck`/`staging.preview` hooks). Stageable tools need `approval` and side-effect-free validation (new `ToolRegistryError` causes `staging_unsupported_policy`, `staging_validation_required`). Direct script calls of approval-gated tools stay fail-closed.
  - Staging requires `resolveTools(..., { interactionHost, plans: { store } })` and one `makePlanReviewTool` registration (multiple registrations fail with `plan_review_duplicate`); voice and subagent resolutions without them never get it. New `ToolPlanStore` port with `makeInMemoryToolPlanStore`, `ToolPlan`/`StagedCall` Schemas, `NestedToolExecutor.staging`, and `ResolvedToolSet.plans`. `plans.planId({ call })` sets plan ids (default the code mode call id; staged keys are `<planId>/s<n>`).
  - Code mode scripts get a `stage(name, args)` global (`makeCodeModeTool({ staging })`; `false` turns it off, `{ maxCalls }` lowers the cap). `stage` validates the arguments and executes or ledgers nothing. It rejects duplicates, calls past `maxCalls`/`maxArgsBytes`, and mixing with direct writes in one script. Only a successful script saves its plan, reported in `CodeModeStructuredContent.codemode.plan`; a failed script discards its staged calls.
  - A person reviews once through `review_plan({ planId, planDigest })` (response `{ selectedKeys }`, untick only). Yolk applies exactly the selected calls, in staged order and at most once, through the normal execute path and tool ledger (`<reviewCallId>/<n>`), with `onFailure: 'stop' | 'continue'`. A partial apply is `completed` with per-call statuses. `previewToolPlan`, `previewStoredToolPlan`, and `toolPlanKeyPages` page bounded previews; `ToolPlanOutcome`, `ToolPlanCallOutcome`, `ToolPlanPreview`, and `ToolPlanPreviewPage` are Effect Schemas.
  - `beforeCall` is the only per-call host authority hook for applied calls: they bypass `beforeNestedCall` and `ToolExecutor` decorators.
  - With a tool ledger, each apply runs behind a ledger entry for its review call, so a redelivered step waits for an in-flight apply and returns its real outcome; listings report a call `not_run` only when provable, else `unknown`. Resolve the review step with the same ledger scope on every delivery and keep ledger entries as long as the review receipts.
  - Interactions: an optional `unknownOutcome({ call, submissionId, phase })` hook (`'replay' | 'seal'`; only `replay` may report a proven `outcome`), and raw registrations' action `validate` (`InteractionActionHandler.validate`) now receives the normalized `call` (`makeInteractionTool` action `validate` is unchanged). An accepted receipt whose call no longer validates is dispatched, so the executor reports a receipt another delivery already started or settled instead of invalid arguments.
  - Breaking types: interaction call validators (`InteractionCallValidator`) and `InteractionPreflight.validateAction` may fail with `InteractionHostError` when host storage is unavailable. `prepareToolBatch` then fails with `ToolError` `unavailable` (a new error channel; retry the step), `validateInteractionSubmission` answers the new `InteractionAdmissionError` cause `unavailable`, and execution fails closed.

### Patch Changes

- Updated dependencies [e4ca456]
  - @yolk-sdk/agent@0.1.0-canary.103

## 0.1.0-canary.102

### Patch Changes

- b3584f5: Advance unchanged public packages in lockstep with the Gmail draft `multipart/alternative` bodies, the optional draft `contentType`, and the `gmail.get_thread` decoding fix in `@yolk-sdk/connectors`, and the matching Google emulator draft MIME in `@yolk-sdk/emulators`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [b3584f5]
  - @yolk-sdk/agent@0.1.0-canary.102

## 0.1.0-canary.101

### Patch Changes

- 6afe855: Advance unchanged public packages in lockstep with the `gmail.list_threads` thread listing and `metadataHeaders` selections in `@yolk-sdk/connectors` and the matching Google emulator support in `@yolk-sdk/emulators`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [6afe855]
  - @yolk-sdk/agent@0.1.0-canary.101

## 0.1.0-canary.100

### Patch Changes

- 36620a8: Advance unchanged public packages in lockstep with the Google Calendar `sendUpdates` support in `@yolk-sdk/connectors`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [36620a8]
  - @yolk-sdk/agent@0.1.0-canary.100

## 0.1.0-canary.99

### Minor Changes

- c248eb0: Add a durable tool-call ledger, so a re-executed step never runs a ledgered tool call twice under the same ledger key. Details: [`@yolk-sdk/agent/tools` README, Durable tool ledger](https://github.com/magoz/yolk-sdk/blob/main/packages/agent/src/tools/README.md#durable-tool-ledger).

  - `@yolk-sdk/agent/tools`: `resolveTools(modules, context, { ledger: { store } })` takes a host-implemented `ToolLedgerStore` scoped by the host (for example the Workflow run id plus turn): an atomic `claim` returning `ToolLedgerClaim` (`Fresh | Completed | InFlight | Abandoned`), `heartbeat`, `complete`, and `list(parentKey)`. Ledgered calls (`defaultToolLedgerPolicy`: every non-`read` tool plus the built-in `subagent` tool; override with `isLedgered`, composing the default to keep `subagent`) share one seam for top-level calls (`call.id`) and nested code mode calls (`<parentCallId>/<seq>`). Input and interaction tools are never ledgered; their at-most-once guarantee is the host's `InteractionHost` receipts. A completed call returns its stored result without executing; an in-flight one waits until it completes or `maxWaitMs`/`deadline` passes, then returns a model-visible timeout; an abandoned one (lease expired, no result) is never re-run and tells the model it may already have been applied; the same key holding a different call is a model-visible conflict. Claim failures fail closed. Without `ledger`, behavior is unchanged.
  - Host obligations: persist `args` (an 8 KiB audit preview), `argsTruncated`, and `argsDigest` from each fresh claim and return them on every entry (`argsDigest` is lower-case hex SHA-256 of the canonical JSON of the raw `call.params`; store it as `char(64)`); keep store operations interruptible, since the ledger's per-attempt timeouts cannot cut uninterruptible store work; reserve about 15 s of the step budget after `deadline` for recording outcomes; keep call ids unique within a ledger scope.
  - Tool executors receive `idempotencyKey` (`<scope>:<ledger key>`) in `ToolExecutionInput` whenever a ledger is configured; `makeTool` and the built-in subagent registration (`SubagentExecutionInput.idempotencyKey`) forward it, and custom wrappers must forward it like `nested`. Registrations accept `abandonedResult` to describe an abandoned call; its `nested` input is `undefined` when the store cannot list the nested entries.
  - New ledger options: `leaseMs`, `heartbeatIntervalMs`, `pollIntervalMs`, `maxWaitMs`, `deadline`, `maxResultBytes`, and `onLedgerDecision` (one `ToolLedgerDecision` per ledgered call for logs and metrics; it never affects execution).
  - New exports: `ToolLedgerStore`, `ToolLedgerOptions`, `ToolLedgerClaim`, `ToolLedgerClaimRequest`, `ToolLedgerHeartbeatRequest`, `ToolLedgerEntry` (persist with `Schema.toCodecJson`), `ToolLedgerOutcome`, `ToolLedgerSucceeded`, `ToolLedgerFailed`, `ToolLedgerFailure`, `ToolLedgerError`, `ToolLedgerErrorDetails`, `ToolLedgerArgs`, `ToolLedgerPolicyInput`, `ToolLedgerAbandonedInput`, `ToolLedgerDecision`, `ToolLedgerDecisionEvent`, `InMemoryToolLedgerStore`, `makeInMemoryToolLedgerStore` (reference store; not durable), `classifyToolLedgerEntry`, `sortToolLedgerEntries`, `toolLedgerArgs`, `toolLedgerResult`, `toolIdempotencyKey`, `defaultToolLedgerPolicy`, `abandonedToolCallResult`, and the defaults `defaultToolLedgerLeaseMs`, `defaultToolLedgerPollIntervalMs`, `defaultToolLedgerMaxWaitMs`, `defaultToolLedgerMaxResultBytes`, `toolLedgerCompleteTimeoutMs`, and `toolLedgerMaxArgsBytes`.
  - `@yolk-sdk/agent/protocol`: `NestedToolCalls` gains optional per-status `counts` (`NestedToolCallCounts`) covering every call, dropped ones included. `makeNestedToolCallRecorder({ maxCalls })` sizes the record (default `nestedToolCallMaxCalls`, 256; clamped by `nestedToolCallRecordLimit` to at most `nestedToolCallMaxRecordedCalls`, 4096). New exports `truncateCodePoints`, `boundNestedToolCallArgs`, and `BoundedNestedToolCallArgs`.
  - `@yolk-sdk/codemode`: with a ledger, the `codemode` call itself is ledgered, so a re-executed call never re-runs its script. When the earlier execution was abandoned it returns an interrupted error result that lists the script's ledgered nested calls as applied, failed, or unknown (`structuredContent.codemode.interruptedCalls`, or `interruptedCallsUnavailable: true` when the store cannot list them). The `nestedCalls` record is sized from `limits.maxNestedCalls` (up to 4096) instead of a fixed 256 and carries per-status counts. New `afterNestedCall({ call, outcome, durationMs, context, result? })` hook reports `success`, `failure`, or `interrupted` for each nested call; a failing hook is logged and never changes the call's result.
  - `@yolk-sdk/vercel-workflows`: documents that tool-batch steps are at-least-once (redelivered after crashes and concurrently with a running execution, even with `noWorkflowStepRetry`), so hosts that resolve tools in a step must supply a durable ledger. No API change.

### Patch Changes

- Updated dependencies [c248eb0]
  - @yolk-sdk/agent@0.1.0-canary.99

## 0.1.0-canary.98

### Patch Changes

- def9f9c: Advance unchanged public packages in lockstep with the new `@yolk-sdk/extractors` package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [def9f9c]
  - @yolk-sdk/agent@0.1.0-canary.98

## 0.1.0-canary.97

### Minor Changes

- bdb29d0: Make code mode tool calls predictable for scripts.

  - The pi executor (`makePiCodeModeExecutor`) reads each tool argument once, the way `JSON.stringify` does (getters and `toJSON` run once), into a checked JSON copy and sends that copy. It rejects arguments that JSON would silently change, inside the script and before the call reaches the host (it never runs and is not recorded): non-finite numbers, invalid `Date`s, `undefined`/function/symbol array items and holes, function/symbol/bigint values, cycles, and non-plain objects without `toJSON` (`Map`, `Set`, `RegExp`, `Error`, class instances), including inside `toJSON` results. Arguments with more than 100000 values or nested more than 64 levels deep are rejected too, never sent unchecked. The `TypeError` names the call and path, for example `tools.search: argument at limit is NaN; pass a finite number or omit the key`, `tools.search: argument at since is an invalid Date; pass a valid Date or an ISO string`, or `tools.search: argument has more than 100000 values; split the work across calls`. `undefined`-valued keys stay allowed (absent), and a valid `Date` becomes its ISO string. An error thrown by a getter or `toJSON` rejects the call with that error. The checks use built-ins captured before the script runs and the copy has no prototypes, so scripts that change built-ins cannot alter what is checked or sent. Script line numbers, `return`, `exit()`, `tools["raw.name"]`, and unknown-tool suggestions are unchanged; only line-1 columns shift.
  - Breaking (0.x minor): nested calls that end in an error result, a `beforeNestedCall` failure, or the `maxNestedCalls` limit now reject in the script with `tools.<identifier>: <message>` instead of the bare message; a tool whose identifier an earlier tool already uses is labelled `tools["<name>"]` (how scripts reach it while that name is free; a tool whose identifier and name are both taken stays unreachable, as before). Cancelled and failed-unexpectedly rejections use the same label. `ToolResult.nestedCalls` records keep the raw message. `CodeModeCatalogTool` gains a required `callLabel` (set it on hand-built catalog entries), and `CodeModeExecutorTool` gains an optional `callLabel` that `makeCodeModeTool` sets for executors.
  - `CodeModeExecutorTool`/`CodeModeExecutor` document the JSON argument rules for custom executors, and the code mode description says arguments must be plain JSON and how rejections read.

- b5c2b69: Upgrade the coordinated Effect runtime and platform dependencies to the stable Effect 4.0.0 release. Hosts must use the matching Effect version.

  Effect 4.0.0 removes the `effect/unstable/*` entrypoints: import from `effect/http`, `effect/socket`, `effect/sql`, `effect/process` and the other `effect/<area>` paths, and take `Arbitrary` from `effect`. The former `effect/Encoding` module is split into `effect/encoding/*` (for example `Base64.encode` from `effect/encoding/Base64`).

  Effect 4.0.0 exports `Schema.isPattern` to JSON Schema only when the regex flags are `u` (optionally with `d`, `g` or `y`; not `v`, and not `u` with `i`, `m` or `s`). Yolk's connector, emulator and conformance patterns now use `u`, so connector tool parameters keep their model-visible `pattern` hints with unchanged runtime validation; the Fortnox identifier pattern is advertised as its equivalent BMP-only character class. Add `u` to `Schema.isPattern` regexes in host tool parameter schemas to keep their patterns. String `Schema.isMinLength(n)` and the `Schema.isBetweenLength` minimum (n ≥ 2) are now advertised as `minLength: ceil(n / 2)`. See the migration guide.

### Patch Changes

- Updated dependencies [b5c2b69]
- Updated dependencies [4f24fe8]
  - @yolk-sdk/agent@0.1.0-canary.97

## 0.1.0-canary.96

### Minor Changes

- 367aceb: Add `@yolk-sdk/codemode` (ADR 0002, step 2): a code mode tool whose input is a short JavaScript program (an async function body) that calls the host's resolved tools, filters and aggregates their results, and returns only what matters.

  - `makeCodeModeTool({ executor, name?, inlineBudget?, limits?, deadline?, loadStore?, beforeNestedCall? })` returns a `write` registration (default name `codemode`, input `{ code }`) with nested tool access. Nested calls run through the resolution's execute path with the same host context, get ids `<toolCallId>/<seq>`, are capped by `maxNestedCalls` (default 256), resolve to `structuredContent` for tools with an output schema and to text otherwise, reject with an `Error` on error results, and are recorded on `ToolResult.nestedCalls` with summed token usage. Interrupted calls reject with `was cancelled`; defects reject with `failed unexpectedly` and are recorded as errors. Calls still running when a script ends are cancelled and recorded as such; the wait for them to stop is bounded.
  - `beforeNestedCall({ call, context })` runs before each nested call; a failure rejects that call in the script with its message and records an error without executing it. Decorators around the host `ToolExecutor` never see nested calls, so per-call run-authority checks belong here or in registration-level wrappers.
  - The resolved description lists the script globals and the nested tools by namespace (with `ToolModule.description` under each heading): `codemode` + `listed` tools with TypeScript declarations within an inline budget (default 3,000 estimated tokens) filled fairly across namespaces, `callableBy: 'all'` tools with one line each outside the budget, and one fixed line pointing to `searchTools(query, { limit?, namespace? })` (BM25 over names, descriptions, namespaces, and module descriptions), `describeTool(name)`, and `describeNamespace(name)`. `codemode` + `search` tools contribute nothing, so adding or removing them, even whole modules of them, leaves the description byte-identical.
  - Results start with `Script completed` or `Script failed`, include the wall time, the output (images as image parts), and the JSON return value, and are cut head and tail at `maxOutputChars` (default 40,000). Images beyond `maxImages` (default 8) or `maxImageBytes` (default 4 MiB of base64) are dropped with a note. Failures add the error and the tool calls already made. Limits: timeout (default 120 s, clamped to `deadline` minus 5 s, at least 1 s, with a `timeout` backstop 5 s after it for executors that miss it) and VM heap (default 64 MiB). The pi engine buffers output on the host thread without a limit while a script runs; only the timeout bounds it.
  - Store writes of successful scripts are returned in `structuredContent.codemode.storeWrites`; `codeModeStoreFromToolResults(entries, { toolName? })` rebuilds the store for `loadStore` from `{ toolName, result }` entries, applying only results of the code mode tool (default `codemode`) and dropping writes beyond 256 KiB per value or 1 MiB in total.
  - `makeClassifierTool({ classify, name?, maxConcurrency?, processLimiter?, description? })` exposes a `ClassifierModel` as a `codemode` + `listed` read tool with compact JSON answers, the full result (including `usage.costUsd`) as `structuredContent`, token usage on `ToolResult.usage`, and model-visible error results. Each classification takes a per-script permit (`maxConcurrency`, default 100, keyed by the parent tool call id) and then a process permit from `processLimiter`, a limiter shared across scripts and registrations: by default the module-level `defaultClassifierProcessLimiter` (200 concurrent classifications per process), or one built with `makeClassifierConcurrencyLimiter(max)`, or `false` to disable the process cap. Interrupting a call while it waits releases its permits.
  - `@yolk-sdk/codemode/node` adds `makePiCodeModeExecutor({ wasm?, workerUrl?, maxConcurrentExecutions? })` on `@earendil-works/pi-codemode` 1.0.0: one QuickJS (WebAssembly) VM in a fresh worker thread per script, TypeScript annotations stripped with Node's `stripTypeScriptTypes`, and a concurrency cap per executor (default 4). Requires Node.js 22.19+; Next.js hosts add `serverExternalPackages: ['@yolk-sdk/codemode', '@earendil-works/pi-codemode', 'quickjs-wasi']`.

  `@yolk-sdk/agent/tools`: registrations (and `makeTool`) accept an optional `describe({ tools })` hook. For registrations with `nestedToolAccess: true`, `resolveTools` computes the resolved definition's description from the nested tools of the resolution; `def.description` stays the static fallback. New type `NestedToolDescriber`.

### Patch Changes

- Updated dependencies [367aceb]
- Updated dependencies [367aceb]
- Updated dependencies [367aceb]
- Updated dependencies [0ce9c3e]
- Updated dependencies [00904fd]
- Updated dependencies [425c172]
- Updated dependencies [9f7aba3]
- Updated dependencies [ccc64a3]
- Updated dependencies [6d3b497]
- Updated dependencies [9ff96b8]
- Updated dependencies [0c58a89]
- Updated dependencies [92f016f]
  - @yolk-sdk/agent@0.1.0-canary.96
