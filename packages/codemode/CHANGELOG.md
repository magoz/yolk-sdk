# @yolk-sdk/codemode

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
