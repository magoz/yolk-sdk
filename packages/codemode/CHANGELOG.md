# @yolk-sdk/codemode

## 0.1.0-canary.165

### Patch Changes

- 76a643f: Advance in lockstep with `@yolk-sdk/agent`: its new `@yolk-sdk/agent/chat` subpath is the chat projection without React, an event's cost no longer grows with the chat's history, the projection's state has Effect Schemas, and `seenEventIds` is an Effect `HashSet`. These packages have no direct changes in this release.
- Updated dependencies [cfb0e27]
  - @yolk-sdk/agent@0.1.0-canary.165

## 0.1.0-canary.164

### Patch Changes

- 338a76f: Advance in lockstep with `@yolk-sdk/vercel-workflows`: its Cloudflare runtime can prepare a run's object before the run starts (`prepareRun`, `startWithRunId`, `registerRunPreloads`). These packages have no direct changes in this release.
- Updated dependencies [338a76f]
  - @yolk-sdk/agent@0.1.0-canary.164

## 0.1.0-canary.163

### Patch Changes

- 909b7c1: `makeDynamicWorkerCodeModeExecutor`: a script stopped by its CPU limit keeps the output it sent before its last call, and its wall time should no longer stop where it started spinning (#419).

  - The isolate now sends the output printed since its previous tool or global call with each call. An execution that ends without the isolate's answer (its CPU limit, a failed isolate, the timeout, an abort) returns the output printed before the script's last call (decoded and capped by the prelude's output limits, a prefix of what was printed), where it returned none. Output printed after that call is still lost: a spinning isolate shares the calling Worker's thread and can send nothing. A completed script returns all of its output, each item once, as before.
  - A CPU-limit failure settles one timer turn later. A Worker's clock moves only at I/O and timers, so the run's wall time (`wallTimeMs`, `Script failed after … ms`) stopped where the script started spinning, for example 201 ms for a script that took 2.7 s. The timer turn lets the clock move first; local workerd does not enforce CPU limits, so it can only be checked on deployed Workers.

- Updated dependencies [f4b28c7]
  - @yolk-sdk/agent@0.1.0-canary.163

## 0.1.0-canary.162

### Minor Changes

- aab270f: Upgrade `@earendil-works/pi-codemode` from 1.0.0 to 1.6.0 (the Node executor's engine, and the prelude the Dynamic Worker executor vendors). Scripts behave the same except:

  - Built-ins are frozen and built-in globals are read-only before the script runs, on both executors, so a script cannot patch them (`Array.prototype.toJSON = ...` has no effect; `defineProperty` on a built-in throws). Subclasses can still set `name`, `message` and the other commonly overridden members on their own instances.
  - A script fails with a `RangeError` (`script` error) once it has printed 16 Mi characters or 100,000 `text()`, `image()` and `console.*` items, instead of growing the host's memory until the timeout.
  - A script spinning on promise jobs (`while (true) await null`) is stopped at the timeout like a synchronous loop. `image()` errors describe the accepted block as `{ type: "image", data, mimeType }` instead of an MCP image block.
  - `console.*` prints `NaN` and `Infinity` as `text()` does, instead of `null`. A thrown error's `name` and `message` are reported as strings, and a thrown value that cannot be described fails the script with `The script threw a value that cannot be described`.
  - Tool declarations in the code mode description, `describeTool` and `describeNamespace` show schema constraints TypeScript cannot express as comment tags on the property (`// @integer @minimum 0 @default 10`), which puts such objects on several lines. Descriptions of tools with such constraints are longer, so fewer of them fit `inlineBudget` and their text changes once. A local `$ref` with a malformed percent escape now renders as `unknown` instead of failing the whole catalog.

  `makePiCodeModeExecutor` keeps an execution's concurrency slot until its worker has exited: pi 1.3 settles a result once it has asked the worker to stop. Output items keep the `CodeModeOutputItem` shape (pi's `console: true` marker is dropped).

### Patch Changes

- Updated dependencies [aab270f]
  - @yolk-sdk/agent@0.1.0-canary.162

## 0.1.0-canary.161

### Minor Changes

- 34b7f96: `readOnlyNestedCallGate` takes `admitModelCall?: (input: CodeModeBeforeNestedCallInput) => boolean`,
  a predicate over the same `{ call, tool, access }` input as `admit`. When it returns `true` for a
  tool marked `invokesModel`, the call is not refused with `invokes_model`, so a host can let scripts
  call bounded model reads such as `classify` while still refusing open-ended ones. It relaxes only
  the model check: the call still needs effective access `read` (or `admit`), so a write marked
  `invokesModel` is refused as `not_read`, and approval-gated and unavailable tools stay refused. It
  is asked only about `invokesModel` tools; one that throws refuses the call (`The call could not be
admitted.`), like a throwing `admit`. Without it, model-invoking tools are refused as before.

### Patch Changes

- Updated dependencies [34b7f96]
  - @yolk-sdk/agent@0.1.0-canary.161

## 0.1.0-canary.160

### Minor Changes

- 6f9a9e3: Run code mode scripts outside a model turn, gate them to reads, mark tools that call a model, and
  keep message envelopes on chat items.

  `@yolk-sdk/codemode`:

  - `runCodeModeScript({ executor, code, nested, parentCallId, limits?, deadline?, store?, beforeNestedCall?, afterNestedCall?, staging? })`
    runs one script without a model tool call and returns a `CodeModeScriptResult`: `ok`, the JSON
    `value` and `storeWrites` of a successful script or its `error`, the unbounded `output`, every
    nested call (`calls`, `CodeModeScriptCall` with `refusal`), the bounded `nestedCalls` record,
    `usage`, `usageIncomplete`, `inputRequired`, `staged`, `timeoutMs` and `wallTimeMs`. It never
    fails; interrupting it aborts the script and cancels running nested calls. `makeCodeModeTool` now
    runs every script through it, so dispatch, limits, the deadline clamp, the executor backstop, the
    store and both hooks are one path; its results are unchanged.
  - `beforeNestedCall` also receives the called `tool` (`NestedTool`) and the call's effective
    `access`, and may refuse with `new CodeModeNestedCallRefused({ code, message })`: the script sees
    `error.code`, and the call's `refusal` keeps both. Existing hooks (`{ call, context }`, string
    failures) keep working. A hook that throws or dies now refuses the call, recording
    `The call could not be admitted.` as its `refusal`, instead of escaping the call.
  - `readOnlyNestedCallGate({ admit? })`: a ready-made `beforeNestedCall` that admits only calls whose
    effective access is `read` and refuses approval-gated and `invokesModel` tools, failing closed,
    with codes `unavailable`, `approval_required`, `invokes_model` and `not_read`. `admit` relaxes only
    the access check.
  - `makeClassifierTool` sets `invokesModel: true`.
  - `CodeModeLimits`, `defaultCodeModeLimits`, `CodeModeStagingOptions` and the deadline constants
    move to the new script module; they are exported from the root as before.

  `@yolk-sdk/agent`:

  - `ResolvedToolSet.nestedExecutor({ parentCallId })` returns the `NestedToolExecutor` a
    nested-access registration gets, bound to a host id instead of a tool call (nested ids
    `<parentCallId>/<seq>`, ledgered under parent key `parentCallId`), without staging. It is a
    required field: hosts that build `ResolvedToolSet` values by hand (test fakes) must add it. The
    warning for code-mode-only tools without a nested-access registration now says they stay
    reachable through it.
  - `ToolRegistration.invokesModel` and the `makeTool` option mark a tool that calls a model when it
    runs. `resolveTools` copies it to `ToolMetadata.invokesModel` and `NestedTool.invokesModel`; it is
    never sent to providers. The `subagent` tool sets it.
  - React: `buildAgentChatMessages` keeps assistant message envelopes (`createdAtMs`, `author`,
    `annotations`) from the transcript, as live events already did, so `toAgentMessages` round-trips
    them. `buildAgentChatItems` copies a message's envelope onto its `UserMessage` and
    `AssistantMessage` items (`AgentChatItemEnvelope`, each field only when set), so hosts render
    annotated host-authored messages without reading their own snapshots.

### Patch Changes

- Updated dependencies [6f9a9e3]
  - @yolk-sdk/agent@0.1.0-canary.160

## 0.1.0-canary.159

### Minor Changes

- 628ebd5: Mark tool-attributed usage that under-counts its nested work. `ToolResult` gains an optional `usageIncomplete: true`: `usage` misses (part of) a nested model call that completed without the usage report it was billed for (a child stream's `LLMStreamEnd.usageUnavailable`, a provider's `LLMDone.usageUnavailable`, a classification without usage). It may stand without `usage` (nothing was reported) and, like `usage`, is never model-visible: `toolResultMessageFromResult` drops it. Tools that run their own model calls set it.

  The nested-call recorder carries it: `NestedToolCallInput.usageIncomplete` is kept on the call's `NestedToolCallRecord.usageIncomplete`, and `recordNestedToolCall` ORs it over every call, dropped ones included, so `nestedToolCallResultFields` returns `usageIncomplete: true` beside the summed `usage`. The result boundary, file capture and the tool ledger (its stored copy, the typed-too-large copy and replays) keep it with `usage`.

  `collectModelTurn` and `collectModelTurnAttempt` carry a marked `LLMStreamEnd` as `ModelTurnResult.usageUnavailable: true` (absent otherwise), so a tool that runs child model turns can set `usageIncomplete` from them. Harness `attemptModelTurn` carries it on `StepOutcome.Completed` and `Continue`.

  Code mode copies each nested result's `usageIncomplete` onto its record and the script's result. `makeClassifierTool` marks a classification the classifier answered without usage (a result, or `ClassificationResponseInvalid`) as `usageIncomplete`; request and provider errors are not marked. It assumes a classifier that reports the usage it spends: one that never does marks every answered call.

  The fields are absent when every report arrived and on results recorded before they existed, so stored results and ledger entries decode unchanged.

### Patch Changes

- Updated dependencies [0e5d1ac]
- Updated dependencies [628ebd5]
  - @yolk-sdk/agent@0.1.0-canary.159

## 0.1.0-canary.158

### Patch Changes

- d4141e3: Advance in lockstep with `@yolk-sdk/connectors`, which adds Fortnox bookkeeping actions (financial years, accounts, voucher series, vouchers, voucher file connections, and SIE files). These packages have no direct changes in this release.
- Updated dependencies [d4141e3]
  - @yolk-sdk/agent@0.1.0-canary.158

## 0.1.0-canary.157

### Patch Changes

- 7892f30: Advance in lockstep with `@yolk-sdk/connectors`, whose Fortnox supplier invoice reads now accept the JSON forms Fortnox sends beyond its OpenAPI types, and whose Fortnox reads fail an amount past the double range as `validation_failed`. These packages have no direct changes in this release.
- Updated dependencies [7892f30]
  - @yolk-sdk/agent@0.1.0-canary.157

## 0.1.0-canary.156

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.156

## 0.1.0-canary.155

### Patch Changes

- d4d8714: Upgrade the coordinated Effect runtime and platform dependencies to Effect 4.1.5 (patch releases of Effect 4.1). Hosts must move `effect` and the coordinated `@effect/*` runtime packages to 4.1.5 together with Yolk. Yolk APIs are unchanged.
- Updated dependencies [d4d8714]
  - @yolk-sdk/agent@0.1.0-canary.155

## 0.1.0-canary.154

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.154

## 0.1.0-canary.153

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.153

## 0.1.0-canary.152

### Patch Changes

- 3b47dce: `@yolk-sdk/codemode/cloudflare` loads Sucrase when the Dynamic Worker executor runs its first script instead of on import, so a Worker that builds the executor but runs no script does not evaluate it. A Sucrase load failure answers `Could not load the script sandbox.` (`onInternalError` stage `load`).
  - @yolk-sdk/agent@0.1.0-canary.152

## 0.1.0-canary.151

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.151

## 0.1.0-canary.150

### Minor Changes

- 3d379c1: `makeDynamicWorkerCodeModeExecutor` (`@yolk-sdk/codemode/cloudflare`) and `makePiCodeModeExecutor` (`@yolk-sdk/codemode/node`) take a new option `onInternalError` (`CodeModeInternalErrorObserver`: `(error: CodeModeInternalError) => void`, `CodeModeInternalError` being `{ stage, cause }`), so the host can log the original error behind a failure that the result and the script only see as a fixed message. `stage` (`CodeModeInternalErrorStage`) is `load` (the sandbox could not be created or loaded), `isolate` (it failed while running), `cpu-limit` (a Dynamic Worker past its CPU limit), or `host-call` (a Dynamic Worker call's RPC to the host failed; at most `maxDynamicWorkerHostCallFailureReports`, 10, per execution, since the script's isolate reports it and a script could fake one). It is called once per such failure with the original error, never for script errors, parse errors, tool and global rejections, timeouts, or aborts, and whatever it throws or rejects with is ignored. The cause never reaches the script, the result, or the model.
- 3d379c1: `makePiCodeModeExecutor` (`@yolk-sdk/codemode/node`) now answers its own failures with fixed messages, as the Dynamic Worker executor does, so runtime error text never reaches the model: `Could not create the sandbox.` (before: `Could not create the sandbox: <error>`), and `The script sandbox failed.` for pi's `sandbox` failures (before: pi's text, such as `Failed to load QuickJS: <error>` or a worker crash). `onInternalError` receives the original error (`load` and `isolate`). Script errors, timeouts, and aborts are unchanged.

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.150

## 0.1.0-canary.149

### Minor Changes

- c33874c: `makeDynamicWorkerCodeModeExecutor` (`@yolk-sdk/codemode/cloudflare`) loads every script with a CPU limit: new option `cpuMs` (default 500, `defaultDynamicWorkerCpuMs`) is passed as `limits.cpuMs` and is the real ceiling of a script, since the timeout and abort signal only answer the caller early and cannot stop a synchronous loop. A script past it fails with `timeout` (`Execution exceeded its CPU limit of <cpuMs> ms`). `WorkerLoaderCode` gains the required `limits` field, so a custom loader typed against it sees it. When an execution ends (result, timeout, abort, failure), tool and global calls still pending are rejected at once (`The script ended before this call settled; await every tool call before returning.`) and their signal aborts, later calls are rejected without running, and the loaded Worker and its entrypoint are disposed when they support `Symbol.dispose`, so an unawaited call no longer keeps a Dynamic Worker in flight. Loader, isolate, and host RPC failures now reach the caller and the script as fixed messages (`Could not load the script sandbox.`, `The script sandbox failed.`, `The call could not reach the host.`) instead of the runtime's error text; script-thrown errors are unchanged.

### Patch Changes

- Updated dependencies [c112350]
- Updated dependencies [c112350]
- Updated dependencies [22f42c0]
- Updated dependencies [5039d29]
  - @yolk-sdk/agent@0.1.0-canary.149

## 0.1.0-canary.148

### Patch Changes

- Updated dependencies [1cd7e4c]
- Updated dependencies [e5bcedb]
- Updated dependencies [b501399]
- Updated dependencies [2c8e618]
- Updated dependencies [cb15a7b]
  - @yolk-sdk/agent@0.1.0-canary.148

## 0.1.0-canary.147

### Patch Changes

- Updated dependencies [e7bb9e6]
- Updated dependencies [6dc0b32]
- Updated dependencies [e7bb9e6]
  - @yolk-sdk/agent@0.1.0-canary.147

## 0.1.0-canary.146

### Patch Changes

- Updated dependencies [0de4b07]
- Updated dependencies [964b602]
- Updated dependencies [ad085cd]
  - @yolk-sdk/agent@0.1.0-canary.146

## 0.1.0-canary.145

### Patch Changes

- Updated dependencies [c1aaaeb]
  - @yolk-sdk/agent@0.1.0-canary.145

## 0.1.0-canary.144

### Patch Changes

- d8758cf: `@yolk-sdk/codemode`: a code mode call abandoned after its script saved a staged plan now names that plan. Before, the re-execution's interrupted result listed the ledgered nested calls but never the plan, so the model never learned its id and digest and could not `review_plan` it. The interrupted result now carries `structuredContent.codemode.plan` (`{ id, digest, count, reviewToolName }`) and the plan notice (`stagedToolPlanNotice`) after the bounded listing, before any input-required notice, as a finished script writes them, so the ledger's bounding keeps them too. `@yolk-sdk/agent/tools`: `ToolLedgerAbandonedInput` gains an optional `plan` (`StagedToolPlanRef`), which `resolveTools` sets for nested-access registrations of a resolution with staged tool plans when the plan store holds an unclaimed, intact plan in its scope under the call's plan id (`plans.planId({ call })`, default the call id); it is never read from model data, and a host plan id that throws or is invalid leaves it unset, and a plan store failure or a read slower than 5 s (`toolLedgerCompleteTimeoutMs`) is logged and leaves it unset.
- 6afa1c5: Advance in lockstep with `@yolk-sdk/sandbox`, which adds a Cloudflare Containers backend (`@yolk-sdk/sandbox/cloudflare`). These packages have no direct changes in this release.
- Updated dependencies [0bd8166]
- Updated dependencies [d8758cf]
- Updated dependencies [6afa1c5]
  - @yolk-sdk/agent@0.1.0-canary.144

## 0.1.0-canary.143

### Patch Changes

- Updated dependencies [bfbc4e9]
- Updated dependencies [83e4a7b]
  - @yolk-sdk/agent@0.1.0-canary.143

## 0.1.0-canary.142

### Minor Changes

- 8a3c032: Add `@yolk-sdk/codemode/cloudflare`: `makeDynamicWorkerCodeModeExecutor({ loader, compatibilityDate? })` runs code mode scripts on Cloudflare Workers, each in a fresh Dynamic Worker isolate (a Worker Loader binding, `WorkerLoader`) without network access. Scripts get the same globals, tools guard, and tool rejection codes as `makePiCodeModeExecutor`; tool and global calls return to the calling Worker over RPC, TypeScript is stripped with Sucrase (a new dependency), and the timeout and abort signal end the execution from the caller. The tools guard now lives in one module both executors share; pi's in-VM prelude is vendored (MIT) with a test that fails when the installed `@earendil-works/pi-codemode` copy differs.

### Patch Changes

- Updated dependencies [8a3c032]
  - @yolk-sdk/agent@0.1.0-canary.142

## 0.1.0-canary.141

### Patch Changes

- Updated dependencies [d634a02]
- Updated dependencies [38f38cf]
- Updated dependencies [3fe00ec]
  - @yolk-sdk/agent@0.1.0-canary.141

## 0.1.0-canary.140

### Minor Changes

- 8998b9e: Finish tool calls that paused for a person's input (ADR 0014). A tool whose remote call paused (an MCP server asking a form over `2026-07-28` multi round-trip requests) stores the pause and returns `makeInputRequiredToolResult`: an error result carrying `{ code: 'input_required', inputRequired: { reviewToolName, pauseIds } }` (`toolInputRequired` reads it back). The new `makeInputReviewTool` interaction (`review_input({ pauseIds })`, renderer `input_review`) loads the stored pauses through a host `InputReviewHost`, admits one answer per pause, and resumes each pause once; its result lists every pause as `completed`, `input_required` (asked again), `not_sent` or `unknown` (`InputReviewOutcome`). Plan apply reports such calls with the new `input_required` status (with their ref, never stopping the apply; `ToolPlanCallCounts.input_required` is optional so earlier outcomes still decode), and code mode reports them in `structuredContent.codemode.inputRequired` and a notice even when the script caught the rejection. Yolk's MCP server gains forwarding tools (`forward: true`, optional `approval`): a remote tool's pause is asked of the server's own client under a signed, stateless forward state and resumed with its answers (`McpForwardRound`).

  Breaking for exhaustive consumers: `ToolPlanCallStatus` gains `input_required` and `McpServerTool` gains `McpServerForwardingTool`, so exhaustive `switch`es and `Record<ToolPlanCallStatus, …>` maps need a new case. `maxInputReviewPauses` is also exported from `@yolk-sdk/agent/protocol`. MCP clients keep a remote error result's structured content that decodes as the input-required marker under `remoteStructuredContent`.

### Patch Changes

- Updated dependencies [8998b9e]
  - @yolk-sdk/agent@0.1.0-canary.140

## 0.1.0-canary.139

### Patch Changes

- 7c3a30d: Upgrade the coordinated Effect runtime and platform dependencies to Effect 4.1.4 (patch releases of Effect 4.1). Hosts must move `effect` and the coordinated `@effect/*` runtime packages to 4.1.4 together with Yolk. Yolk APIs are unchanged.
- Updated dependencies [7c3a30d]
  - @yolk-sdk/agent@0.1.0-canary.139

## 0.1.0-canary.138

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.138

## 0.1.0-canary.137

### Patch Changes

- Updated dependencies [41ba67b]
  - @yolk-sdk/agent@0.1.0-canary.137

## 0.1.0-canary.136

### Patch Changes

- Updated dependencies [12dfd4e]
  - @yolk-sdk/agent@0.1.0-canary.136

## 0.1.0-canary.135

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.135

## 0.1.0-canary.134

### Patch Changes

- dc74275: Advance in lockstep with `@yolk-sdk/agent`, whose tool argument validation errors now name a number or boolean the model sent as a JSON string, with the literal to send instead. The tools of `@yolk-sdk/connectors`, `@yolk-sdk/knowledge`, `@yolk-sdk/sandbox` and `@yolk-sdk/files` already append that hint, so their errors gain the line. These packages have no direct changes in this release.
- Updated dependencies [21fd3fe]
  - @yolk-sdk/agent@0.1.0-canary.134

## 0.1.0-canary.133

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.133

## 0.1.0-canary.132

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.132

## 0.1.0-canary.131

### Patch Changes

- 6e9bd7d: Advance in lockstep with `@yolk-sdk/agent`, whose providers now fail a returned tool call with an empty or padded id or name as a typed `invalid_response` instead of a defect, and `@yolk-sdk/vercel-workflows`, whose `TestWorkflowWorld` now stores step errors through the platform's serializer and records unstorable ones in `inspect(runId).unstorableStepErrors`. These packages have no direct changes in this release.
- Updated dependencies [59c9747]
  - @yolk-sdk/agent@0.1.0-canary.131

## 0.1.0-canary.130

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.130

## 0.1.0-canary.129

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.129

## 0.1.0-canary.128

### Patch Changes

- cae5998: Advance in lockstep with `@yolk-sdk/connectors`, which adds Microsoft Teams chats, channels, meeting lookup and transcripts to `@yolk-sdk/connectors/microsoft`. These packages have no direct changes in this release.
- Updated dependencies [cae5998]
  - @yolk-sdk/agent@0.1.0-canary.128

## 0.1.0-canary.127

### Patch Changes

- 5a12835: Advance in lockstep with `@yolk-sdk/connectors`, which adds SharePoint site search, site drive listing and sharing-link resolution to `@yolk-sdk/connectors/microsoft`. These packages have no direct changes in this release.
- Updated dependencies [5a12835]
  - @yolk-sdk/agent@0.1.0-canary.127

## 0.1.0-canary.126

### Minor Changes

- bcb26c8: Typed tool results (ADR 0013): a tool's typed output is the single contract for code mode scripts, files are typed fields of that output, and script values never contain file labels.

  - `@yolk-sdk/agent`: `makeTool` overloads. With `output`, `execute` returns `{ output }`; Yolk encodes it with `Schema.toCodecJson(output)` (a value that does not encode is a value-free `execution` `ToolError`) and shows the model `render(value, files)` when given, else a string output as is, else the compact JSON of the encoding with file labels. Without `output`, `execute` returns `{ content }`. Returning a raw `ToolResult` still works this canary but is deprecated. `resolveTools` checks every successful result of a registration with an output schema through `ToolRegistration.decodeOutput` (`makeTool` sets it from `output`; `toolOutputDecoder` for raw registrations): excess properties rejected, plain JSON only, the checked value passed on, a mismatch dropped with a value-free warning; a registration with `def.outputSchema` but no decoder fails `output_validation_required`. Encodings that are not plain JSON (bytes in a `Schema.Any` field) fail closed; `Schema.Void` encodes as `null`. `output` schemas must encode without services (`ToolOutputSchema`). With explicit type arguments the typed `makeTool` takes three (context, parameters, output); `ToolFile` in `parameters` throws. Files returned as `FilePart` by tools without `output` no longer reach scripts. New protocol file fields: `ToolFile` (tools return `FileBytes`, optionally `view: true`; the encoding holds `FileRef` or `FileUnavailable`), `ToolFileCapture` (provided by `resolveTools` to every registration; `makeToolFileCapture`), `typedToolResult`, `encodeToolOutput`, `toolFileJsonSchemaDefinitions`. `ToolResult.files` is derived from file fields. Capture no longer inserts text labels: captured image/document/audio parts are followed by a `File` part with a `Ref` source, an inline image/document/audio part that cannot be stored stays inline (without a `File` part), and unstored `File` parts become `File` parts with the new `Omitted { reason }` source (`FileSource`); providers render the same text, but readers older than this release cannot decode transcripts holding `Omitted`. Capture is idempotent. `ModelVisibleToolError` gains `code`. For raw interaction registrations, `def.outputSchema`/`decodeOutput` describe the completed action's own value (`structuredContent.result`), checked before the receipt is settled (bounded to 5 s; past it the value is dropped). The tool ledger stores typed values whole (content cut first) or, when the value alone is over the bound, a fixed error result, and keeps `File` parts structural through every reduction.
  - `@yolk-sdk/codemode`: typed tools resolve to their declared value (arrays and primitives included, nothing merged); a typed result without a value rejects `<label>: returned an invalid result`; untyped tools resolve to their text parts only; failures reject with the text and `error.code` (also through the pi executor). Breaking for scripts: no more `files` merged into values or `{ text, files }`. The description declares `FileRef`/`FileUnavailable` and says `string` results are text; signatures show file fields by name.
  - `@yolk-sdk/mcp`: adapted tools declare `{ value, files }` and `callRemoteMcpServerTool`/`callLocalMcpServerTool`/resumable calls return `mcpToolResult`: `value` is `structuredContent`, else the text of text blocks and embedded text resources parsed once when it is one JSON object or array, else the text; blobs, images and audio are file fields, stored through the new `fileCapture` call option or the ambient capture. Hosts building registrations from `mcpToolToToolDef` defs must set `decodeOutput: mcpToolOutputDecoder`: `resolveTools` requires a decoder for a declared `outputSchema` (`output_validation_required`). Local calls now list tools in the same session and validate `structuredContent` against the listed `outputSchema`. Breaking for scripts and for hosts reading MCP `structuredContent`.
  - `@yolk-sdk/connectors`: `fileOutput` actions (`gmail`/`outlook`/`email` `get_attachment`) declare `{ value, files }` with file fields instead of trailing `FilePart`s, and their descriptions say so. Breaking for scripts reading `{ ...metadata, files }`. Their tool listings (output schemas and descriptions) change once, so hosts that key grants or caches on a tool's listing see one change.

### Patch Changes

- Updated dependencies [bcb26c8]
  - @yolk-sdk/agent@0.1.0-canary.126

## 0.1.0-canary.125

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.125

## 0.1.0-canary.124

### Patch Changes

- 6a1c1d4: Upgrade the coordinated Effect runtime and platform dependencies to Effect 4.1.2. Hosts must use the matching Effect version, and adopt Effect 4.1's own breaking changes where their code uses the affected APIs (`effect/Crypto`, `HttpClientRequest.method` as `string`, `KeyValueStore`, `FileSystem.make`, `ChildProcess` templates, `McpServer` registrations). `@effect/platform-node` 4.1 requires `ws` ^8.22.1; dedupe `ws` if a Workflow build reports duplicate step ids.

  Tool JSON Schemas generated from Effect schemas are flatter: Effect 4.1 merges a nested `anyOf` into its parent and no longer duplicates a named definition used by both a required and an optional property. What a schema admits is unchanged, and the `yolk:null-means-omitted` marker still tells the codec-added `null` from a `Schema.NullOr` `null`. Hosts that list tools over MCP serve changed tool schemas once, so grants keyed on a tool snapshot digest return to their default for the affected tools.

- Updated dependencies [6a1c1d4]
- Updated dependencies [4f6cd82]
  - @yolk-sdk/agent@0.1.0-canary.124

## 0.1.0-canary.123

### Patch Changes

- Updated dependencies [fc21cd8]
  - @yolk-sdk/agent@0.1.0-canary.123

## 0.1.0-canary.122

### Patch Changes

- 6d9787f: Advance in lockstep with `@yolk-sdk/connectors`, whose action inputs now advertise only finite numbers (integer counts and page sizes of at least 1, some with upper bounds, and finite GitHub issue-field numbers and Fortnox nullable amounts). These packages have no direct changes in this release.
- Updated dependencies [6d9787f]
  - @yolk-sdk/agent@0.1.0-canary.122

## 0.1.0-canary.121

### Patch Changes

- 59d338d: Advance in lockstep with `@yolk-sdk/mcp`, whose `makeMcpToolServer().handleHttpRequest` now finishes every exchange before it returns, so no tool call runs after the caller's scope has closed. These packages have no direct changes in this release.
- Updated dependencies [59d338d]
  - @yolk-sdk/agent@0.1.0-canary.121

## 0.1.0-canary.120

### Patch Changes

- 79595fc: Advance in lockstep with `@yolk-sdk/agent`, which now shows Claude (compatibility mode) the real type of `Schema.optional` tool params instead of an unconstrained value. These packages have no direct changes in this release.
- Updated dependencies [a9eee1b]
  - @yolk-sdk/agent@0.1.0-canary.120

## 0.1.0-canary.119

### Minor Changes

- 67cfa52: Read-only calls of `write` tools stay retryable under the tool ledger. `makeTool({ isReadCall })` (registration `isReadCall(call)`) marks a non-`read` tool's read-only calls, for example the list operations of a tool that also updates; their effective access (`toolCallAccess`) is `read`. `ToolLedgerPolicyInput.readCall` carries it and `defaultToolLedgerPolicy` no longer ledgers such calls, so a read that crashed before recording its outcome is re-run instead of refused on every retry as possibly applied. Arguments that do not decode, and an `isReadCall` that fails or dies, mean not a read. `NestedToolExecutor.access(call)` exposes a nested call's effective access, and code mode records it on the new optional `NestedToolCallRecord.access` (`NestedToolCallAccess`), so hosts can audit nested writes without parsing arguments. Hosts that build `NestedToolExecutor` objects themselves must add `access`.

### Patch Changes

- Updated dependencies [67cfa52]
  - @yolk-sdk/agent@0.1.0-canary.119

## 0.1.0-canary.118

### Patch Changes

- f7f6d58: Republish every public package in lockstep after an incomplete `0.1.0-canary.117` publish: npm held `@yolk-sdk/extractors@0.1.0-canary.117`, so `@yolk-sdk/extractors`, `@yolk-sdk/pool`, `@yolk-sdk/sandbox` and `@yolk-sdk/vercel-workflows` were never published at that version. This release contains no implementation changes beyond `0.1.0-canary.117`; install this version (with all `@yolk-sdk/*` packages on it) instead of `0.1.0-canary.117`.
- Updated dependencies [f7f6d58]
  - @yolk-sdk/agent@0.1.0-canary.118

## 0.1.0-canary.117

### Patch Changes

- 47827d8: Advance unchanged public packages in lockstep with the `@yolk-sdk/connectors` fix for email attachments above ~3 MB (the attachment base64 is no longer pattern-checked) and the one-copy byte decoding and new `base64ToBytes` in `@yolk-sdk/agent`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [190c928]
  - @yolk-sdk/agent@0.1.0-canary.117

## 0.1.0-canary.116

### Patch Changes

- 02953b4: Upgrade the coordinated Effect runtime and platform dependencies to Effect 4.0.5. Hosts must use the matching Effect version.

  Effect 4.0.5 drops a typed failure when an interruption skipped its recovery handler, so a connector conformance run interrupted while a case's cleanup fails, a write's outcome is unknown, or a cleanup is refused now ends interrupt-only instead of with the case's error. The problem still reaches `ConformanceCleanupReporter`. See the migration guide.

- Updated dependencies [02953b4]
- Updated dependencies [995762e]
  - @yolk-sdk/agent@0.1.0-canary.116

## 0.1.0-canary.115

### Patch Changes

- e662c70: Advance unchanged public packages in lockstep with `@yolk-sdk/agent`, which now reports one typed `AgentStatus` per run and per subagent (ADR 0010). These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [5f08b0f]
  - @yolk-sdk/agent@0.1.0-canary.115

## 0.1.0-canary.114

### Minor Changes

- fddf4a6: File claim check (ADR 0009): agents move files between tools by `fileId`; `File` bytes never reach
  the model, scripts, the tool ledger or the transcript (inline images, documents and audio the model
  views keep their inline source for now).

  - `@yolk-sdk/agent/protocol`: `FilePart` joins `ContentPart` (bytes to move, lowered by every
    provider as its text label only), `filePartFromBytes`, `bytesToBase64`, `filePartText`,
    `FileDescriptor`, `FileId`, `fileLabel`, `fileNotCapturedLabel`, `formatFileSize`, `isFileId`, `normalizeFileMimeType`,
    and `ToolResult.files` (captured descriptors, not sent to providers).
  - `@yolk-sdk/agent/tools`: `resolveTools(modules, context, { files: { store, maxFileBytes? } })`
    captures every executed result (direct, nested and staged) before the ledger: inline `File`
    parts are stored through the host `FileStoreApi` and rewritten to `Ref { id: fileId }`; inline
    image, document and audio parts are stored and followed by their label (the model still sees
    them). Without `files`, or when storing fails or a file is over the bound (default 100 MiB),
    inline `File` parts become a "file not captured" label. Exports `FileStoreApi`,
    `FileStoreError`, `ToolFileCaptureOptions`, `captureToolResultFiles`, and
    `defaultMaxCapturedFileBytes`. The tool ledger keeps `files` through every reduction step and on
    replay.
  - `@yolk-sdk/codemode`: a nested call that captured files also resolves `files: [{ fileId, name,
mimeType, size }]`, merged into an object result or as `{ text, files }`; the code mode
    description says so.
  - `@yolk-sdk/mcp`: embedded resource blobs in tool results become `FilePart`s instead of base64
    text; the MCP server lowers a `FilePart` with inline bytes to an embedded resource blob and a
    captured one to its label.
  - New `@yolk-sdk/files`: `makeObjectStorageFileStore` (a `FileStoreApi` over a host
    `ObjectStorageApi`: keys `<prefix>/<scope>/<fileId>`, `fileId` derived from scope and content
    hash, no database), `deleteScopeFiles`, `fileIdFor`, `isValidFileScope`, and `makeFileToolModule` with `file_upload`
    (`PUT` to an https URL over a host `FileUploadTransportApi`) and `file_url` (signed download
    link).
  - New `@yolk-sdk/files` tools `file_to_sandbox` (copy a file into the workspace, default
    `files/<fileId>/<name>`) and `file_from_sandbox` (turn a workspace file into a `fileId`, MIME type inferred
    from the extension), present when the host passes a sandbox with file transfer (the structural
    `FileSandboxApi`/`FileSandboxError` port, which `@yolk-sdk/sandbox` `SandboxApi` satisfies).
  - `@yolk-sdk/sandbox`: optional binary `SandboxApi.writeFile`/`readFile` on workspace-relative
    paths (`normalizeWorkspacePath`, `NormalizedWorkspacePath`), implemented by the Vercel layer (streamed, bounded reads) and
    `makeFakeSandboxFiles`; `SandboxInputErrorCause` gains `invalid_path`, `file_not_found` and
    `file_too_large`; `VercelSandboxHandle` gains `readFile` and `VercelSandboxFile.content` accepts
    bytes.
  - `@yolk-sdk/connectors`: actions may declare `fileOutput` (a byte-free tool output schema and a
    `split` into files). The agent bridge declares that schema and returns the bytes as `FilePart`s.
    `gmail.get_attachment`, `outlook.get_attachment` and `email.get_attachment` use it, so as agent
    tools they return a file instead of base64 (`connector.invoke` is unchanged).
    `gmail.get_attachment` takes optional `filename` and `mimeType` (from `gmail.list_attachments`,
    echoed unverified in the output) to name and type the file. New
    `connectorActionFile`, `sniffBase64MimeType`, `GmailGetAttachmentFileOutput`,
    `OutlookGetAttachmentFileOutput` and `EmailGetAttachmentFileOutput`.

  Host migration:

  - `ContentPart` has a new `File` member: exhaustive `Match`es over content parts need a case
    (render `filePartText`).
  - Custom `VercelSandboxHandle` implementations and fakes need `readFile`.
  - As agent tools, `gmail.get_attachment`, `outlook.get_attachment` and `email.get_attachment` now
    return a file instead of base64 (`structuredContent` keeps only metadata), and connector sinks
    such as Gmail draft attachments do not take `fileId`s yet: hosts that forwarded attachment
    base64 through the model need their own file-aware tool.
  - MCP embedded blobs reach the model as a file label instead of base64 text.
  - The code mode description gains one line (one cache prefix change).

### Patch Changes

- Updated dependencies [fddf4a6]
  - @yolk-sdk/agent@0.1.0-canary.114

## 0.1.0-canary.113

### Patch Changes

- 2b74f9c: Advance unchanged public packages in lockstep with `@yolk-sdk/agent`, which now streams Claude thinking summaries and replays signed thinking. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [67ec15e]
  - @yolk-sdk/agent@0.1.0-canary.113

## 0.1.0-canary.112

### Patch Changes

- Updated dependencies [c3da661]
- Updated dependencies [c3da661]
  - @yolk-sdk/agent@0.1.0-canary.112

## 0.1.0-canary.111

### Patch Changes

- a1e32bb: The code mode description, its "more tools" line, and the instructions-mode catalog tell the model to call a tool whose exact name it already knows (listed, returned by an earlier `searchTools`, or called earlier in the session) directly, without searching again, and never to call a tool in the same script that found it: search ranking is lexical and hits carry no access metadata, so an unseen hit could be a write. The description text changes once, so a cached prompt prefix that contains it is rebuilt after upgrading.
- Updated dependencies [a1e32bb]
  - @yolk-sdk/agent@0.1.0-canary.111

## 0.1.0-canary.110

### Minor Changes

- 47e7fb3: `searchTools` hits include `signature`: the call on one line with its argument and result types (for example `tools.crm_find({ email: string; }): Promise<string>`, or `stage("name", { … })` for a stageable tool), without description comments and at most 800 characters (`maxCodeModeSearchSignatureChars`; a longer one is cut with a `describeTool` pointer), so a script calls a found tool in its next run without a `describeTool` round trip. New exports `codeModeToolSignature` and `maxCodeModeSearchSignatureChars`; `CodeModeSearchHit` gains the required `signature` field. The code mode description says so, and its `store()` line now invites keeping large fetched data (up to 256 KiB per value) and filtering it in a later script instead of fetching it again. The description text changes once, so a cached prompt prefix that contains it is rebuilt after upgrading.

### Patch Changes

- Updated dependencies [47e7fb3]
  - @yolk-sdk/agent@0.1.0-canary.110

## 0.1.0-canary.109

### Patch Changes

- 8bb8c83: Code mode scripts find every stageable tool with `searchTools()` (hits marked `stageOnly: true`), read it with `describeTool()` (rendered as the `stage()` call), and the catalog counts it in its namespace, whatever its `callableBy`. Before, only stage-only (`callableBy: 'codemode'`) tools were searchable, so a model-callable stageable tool was reachable from scripts only through the description's Stageable list, and a deferred one (`loading: 'deferred'`) not at all. Deferred stageable tools are not named in the Stageable list (like `search` tools), and a direct `tools.<name>()` call of any stageable tool rejects with a hint to `stage()` it.
- Updated dependencies [8bb8c83]
  - @yolk-sdk/agent@0.1.0-canary.109

## 0.1.0-canary.108

### Minor Changes

- 013b918: Add host instructions and the code mode catalog as an instruction (ADR 0007). `RunInstruction` (`{ key, state, render(current) }`) and `RunConfig.instructions` keep an instruction current in the conversation: before each model request the loop appends a user-role instruction message (a `UserMessage` with the non-model-visible `instruction: { key, state }` envelope) only when its state changed, never rewriting earlier messages, so a changing instruction never invalidates the cached request prefix. Durable hosts driving `runModelTurn` append and persist `instructionMessages(transcript, instructions)` themselves; `runModelTurn` does not accept `instructions`. Nested-access registrations contribute through `instruct`, collected in `ResolvedToolSet.instructions`. `makeCodeModeTool({ catalog: 'instructions' })` keeps the `codemode` description invariant and delivers the catalog (every namespace with its tool count and description, listed tools within the inline budget) as such an instruction, rendered in full on every change: `render` never sees the previous state, because compaction keeps only the latest message of each key. `ToolDiscovery` gains `pinned`: always listed, outside the inline budget. The React chat projection (`buildAgentChatMessages`, `appendProtocolMessage`) never shows instruction messages as user messages. Hosts that cannot append messages to their persisted conversation may render an instruction into their system prompt instead. A removal is recorded as an instruction message without `state`, so any JSON state, `null` included, compares normally; `latestInstructionMessages` returns the current message of each key, and window compaction keeps them after its summary. `RuntimeConfig.instructions` forwards instructions to the loop. Duplicate instruction keys are rejected (`duplicate_instruction`), as is `instruct` without nested access. The chat projection keeps hidden instruction messages on the previous chat message (`instructionsAfter`) so `toAgentMessages` round-trips them. In instructions mode the `codemode` description documents `stage()` whenever staging is offered, so it stays invariant when the first stageable tool connects.
- 013b918: Add deferred tool loading (ADR 0007). `ToolDef.loading: 'deferred'` keeps a model-callable tool out of provider requests until the package `tool_search` tool (added by `resolveTools` when deferred tools resolve; opt out with `toolSearch: false`) activates it; the loop then declares it from the next request on (`declaredToolDefs`). Activation is derived from `tool_search` results in the transcript, never stored, so every step and redelivery declares the same tools. Approval-gated tools may be deferred and keep their approval. `rankToolSearchDocuments` (BM25) is shared by `tool_search` and code mode `searchTools`; code mode treats deferred tools like `search` tools. Activation counts only results answering a `tool_search` call of the assistant message they follow, so reused call ids never activate tools. `ToolExposure` (the `makeTool`, connector, and MCP `exposure` options) gains `loading`, typed only for model-callable tools; `mcpToolToToolDef` passes it through. `resolveTools` rejects `loading` on raw `callableBy: 'codemode'` definitions (`invalid_tool_exposure`) and deferral of `tool_search`, `question`, `subagent`, input, interaction, plan-review, background, and nested-access tools (`deferred_unsupported_tool`). `tool_search` rejects unknown arguments like other tools. New exports: `ToolLoading`, `isDeferredTool`, `declaredToolDefs`, `activatedToolNames`, `ToolSearchActivation`, `toolSearchToolName` (protocol); `makeToolSearchTool`, `rankToolSearchDocuments`, `toolSearchTokens`, `defaultToolSearchLimit`, `maxToolSearchLimit` (tools).
- 013b918: Add stage-only tools (ADR 0007): a stageable approval-gated tool may be `callableBy: 'codemode'` (usually with `discovery: 'search'`), so it is never declared to providers and costs no model context. Code mode scripts find it with `searchTools()` (hits marked `stageOnly: true`), read it with `describeTool()` (rendered as the `stage()` call), and can only `stage()` it for `review_plan`; direct calls stay fail-closed and plan review and apply are unchanged. `stage()` accepts the raw name or the catalog identifier, and an unknown name suggests at most five close stageable tools. The code mode description never names stage-only `search` tools, so they leave it byte-identical once any stageable tool exists. `resolveTools` warns when a stage-only tool resolves without staged tool plans. A direct `tools.<name>()` call of a stage-only tool rejects with a hint to `stage()` it (`CodeModeExecuteOptions.unbound`), and `pinned` stage-only tools are always named in the Stageable section.

### Patch Changes

- Updated dependencies [013b918]
- Updated dependencies [3e34c1b]
- Updated dependencies [013b918]
- Updated dependencies [013b918]
  - @yolk-sdk/agent@0.1.0-canary.108

## 0.1.0-canary.107

### Patch Changes

- d3c2f98: Advance unchanged public packages in lockstep with the Fortnox Developer Portal scopes in `@yolk-sdk/connectors` (91 actions across the article, price, costcenter, payment, offer, print, inbox, settings, and profile scopes), the matching `@yolk-sdk/emulators` Fortnox read routes, and provider prompt caching in `@yolk-sdk/agent` (ADR 0008). These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [8972e3c]
  - @yolk-sdk/agent@0.1.0-canary.107

## 0.1.0-canary.106

### Patch Changes

- Updated dependencies [1cc86e7]
  - @yolk-sdk/agent@0.1.0-canary.106

## 0.1.0-canary.105

### Patch Changes

- c1b73d3: Advance unchanged public packages in lockstep with Gmail draft attachments in `@yolk-sdk/connectors` (optional `attachments` on `gmail.draft_compose`, `gmail.draft_update`, and `gmail.draft_reply`) and the matching `@yolk-sdk/emulators` README note: the Google emulator does not emulate the Gmail draft media upload, so a draft with attachments answers its unrecognised 400. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [c1b73d3]
  - @yolk-sdk/agent@0.1.0-canary.105

## 0.1.0-canary.104

### Patch Changes

- 31b7e48: Advance in lockstep with tool change previews in `@yolk-sdk/agent`; no code mode implementation changes. Hosts that stage tool calls: plan review previews now come from each tool's `changePreview` hook in `@yolk-sdk/agent`, which replaces `staging.preview`.
- Updated dependencies [d5d557e]
  - @yolk-sdk/agent@0.1.0-canary.104

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
