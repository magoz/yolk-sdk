# @yolk-sdk/vercel-workflows

## 0.1.0-canary.122

### Patch Changes

- 6d9787f: Advance in lockstep with `@yolk-sdk/connectors`, whose action inputs now advertise only finite numbers (integer counts and page sizes of at least 1, some with upper bounds, and finite GitHub issue-field numbers and Fortnox nullable amounts). These packages have no direct changes in this release.

## 0.1.0-canary.121

### Patch Changes

- 59d338d: Advance in lockstep with `@yolk-sdk/mcp`, whose `makeMcpToolServer().handleHttpRequest` now finishes every exchange before it returns, so no tool call runs after the caller's scope has closed. These packages have no direct changes in this release.

## 0.1.0-canary.120

### Patch Changes

- 79595fc: Advance in lockstep with `@yolk-sdk/agent`, which now shows Claude (compatibility mode) the real type of `Schema.optional` tool params instead of an unconstrained value. These packages have no direct changes in this release.

## 0.1.0-canary.119

## 0.1.0-canary.118

### Patch Changes

- f7f6d58: Republish every public package in lockstep after an incomplete `0.1.0-canary.117` publish: npm held `@yolk-sdk/extractors@0.1.0-canary.117`, so `@yolk-sdk/extractors`, `@yolk-sdk/pool`, `@yolk-sdk/sandbox` and `@yolk-sdk/vercel-workflows` were never published at that version. This release contains no implementation changes beyond `0.1.0-canary.117`; install this version (with all `@yolk-sdk/*` packages on it) instead of `0.1.0-canary.117`.

## 0.1.0-canary.117

### Patch Changes

- 47827d8: Advance unchanged public packages in lockstep with the `@yolk-sdk/connectors` fix for email attachments above ~3 MB (the attachment base64 is no longer pattern-checked) and the one-copy byte decoding and new `base64ToBytes` in `@yolk-sdk/agent`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.116

### Patch Changes

- 02953b4: Upgrade the coordinated Effect runtime and platform dependencies to Effect 4.0.5. Hosts must use the matching Effect version.

  Effect 4.0.5 drops a typed failure when an interruption skipped its recovery handler, so a connector conformance run interrupted while a case's cleanup fails, a write's outcome is unknown, or a cleanup is refused now ends interrupt-only instead of with the case's error. The problem still reaches `ConformanceCleanupReporter`. See the migration guide.

## 0.1.0-canary.115

### Patch Changes

- e662c70: Advance unchanged public packages in lockstep with `@yolk-sdk/agent`, which now reports one typed `AgentStatus` per run and per subagent (ADR 0010). These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.114

### Patch Changes

- e2de782: Advance unchanged public packages in lockstep with the file claim check (ADR 0009): agents move
  files between tools by `fileId`, and the new `@yolk-sdk/files` package provides the object-storage
  file store and file tools. These packages have no direct implementation changes in this release;
  keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.113

### Patch Changes

- 2b74f9c: Advance unchanged public packages in lockstep with `@yolk-sdk/agent`, which now streams Claude thinking summaries and replays signed thinking. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.112

## 0.1.0-canary.111

### Patch Changes

- a1e32bb: Advance unchanged public packages in lockstep with `@yolk-sdk/codemode`, whose description now tells the model to call known tools without searching again. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.110

### Patch Changes

- 47e7fb3: Advance unchanged public packages in lockstep with `@yolk-sdk/codemode`, whose `searchTools` hits now include each tool's call signature. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.109

### Patch Changes

- 8bb8c83: Advance unchanged public packages in lockstep with the `@yolk-sdk/codemode` fix that makes every stageable tool searchable and describable from code mode scripts, including model-callable and deferred ones. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.108

### Patch Changes

- 013b918: Advance unchanged public packages in lockstep with tool exposure and catalog instructions in `@yolk-sdk/agent` and `@yolk-sdk/codemode` (ADR 0007: deferred tool loading with `tool_search`, stage-only tools, the code mode catalog as a host instruction), deferred loading through `@yolk-sdk/mcp` and `@yolk-sdk/connectors` exposure, and the Claude Code 2.1.299 identity in `@yolk-sdk/agent`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.107

### Patch Changes

- d3c2f98: Advance unchanged public packages in lockstep with the Fortnox Developer Portal scopes in `@yolk-sdk/connectors` (91 actions across the article, price, costcenter, payment, offer, print, inbox, settings, and profile scopes), the matching `@yolk-sdk/emulators` Fortnox read routes, and provider prompt caching in `@yolk-sdk/agent` (ADR 0008). These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.106

### Patch Changes

- 1cc86e7: Bind tool approval to the call instead of the tool's current policy when a pause resumes. Previously `prepareApprovalCall` checked whether the tool still required approval before reading the recorded answer, so a tool whose policy flipped to automatic between the request and the answer ran even when the human denied it. In a resume batch, an exact-match recorded `ToolApprovalResponse` now wins (denied: the denied result, never executed; approved: executed), and a denial under another approval id of the same call (after an execution-mode change) also denies. New optional `awaitingRequests` (the resumed pause's `AgentAwaitingInput.requests`) on `run`, `runToolBatch` and `prepareToolBatch` keeps an unanswered approval request pending even when the tool no longer requires approval: the same request while it still names the call, else a fresh one, its preview recomputed (or dropped without a previewer). A fresh batch (a new model turn) never settles an approval from recorded answers: the current policy decides and a gated call asks again, because a provider may reuse call ids. This closes a consent bypass that predates this change, where a new gated call reusing an earlier approved id executed. Answers consumed by a resumed batch no longer reach later model turns of the same run, and a call is settled only by a result in its own result window, so a provider-reused call id stays pending. `run`, `prepareToolBatch` and `runToolBatch` take an explicit `resume` (default: transcript pending calls with responses, `awaitingRequests` or an interaction host for `run`; `awaitingRequests` or responses given for the batch functions). Append-backed `runRuntime` forwards its logged pause automatically with only the paused batch's responses (sibling answers included, never an earlier batch's, even within one run). Transcript-mode and stateless hosts must pass `awaitingRequests` and only the responses of the batch being resumed (non-empty `hitlResponses` means resume), or set `resume` explicitly. `@yolk-sdk/vercel-workflows` passes each resumed tool step the pause's requests (`VercelAgentWorkflowToolBatchStepInput.awaitingRequests`) for hosts to forward.

## 0.1.0-canary.105

### Patch Changes

- c1b73d3: Advance unchanged public packages in lockstep with Gmail draft attachments in `@yolk-sdk/connectors` (optional `attachments` on `gmail.draft_compose`, `gmail.draft_update`, and `gmail.draft_reply`) and the matching `@yolk-sdk/emulators` README note: the Google emulator does not emulate the Gmail draft media upload, so a draft with attachments answers its unrecognised 400. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.104

### Patch Changes

- 31b7e48: Advance unchanged public packages in lockstep with tool change previews in `@yolk-sdk/agent` (one before → after preview for approval-gated calls, shown on direct approvals and staged plan reviews). These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.103

### Patch Changes

- 1d51430: Advance unchanged public packages in lockstep with staged tool plans in `@yolk-sdk/agent` and `@yolk-sdk/codemode` (code mode scripts stage approval-gated tool calls that a person reviews once before they are applied). These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.102

### Patch Changes

- b3584f5: Advance unchanged public packages in lockstep with the Gmail draft `multipart/alternative` bodies, the optional draft `contentType`, and the `gmail.get_thread` decoding fix in `@yolk-sdk/connectors`, and the matching Google emulator draft MIME in `@yolk-sdk/emulators`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.101

### Patch Changes

- 6afe855: Advance unchanged public packages in lockstep with the `gmail.list_threads` thread listing and `metadataHeaders` selections in `@yolk-sdk/connectors` and the matching Google emulator support in `@yolk-sdk/emulators`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.100

### Patch Changes

- 36620a8: Advance unchanged public packages in lockstep with the Google Calendar `sendUpdates` support in `@yolk-sdk/connectors`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.99

### Patch Changes

- c248eb0: Add a durable tool-call ledger, so a re-executed step never runs a ledgered tool call twice under the same ledger key. Details: [`@yolk-sdk/agent/tools` README, Durable tool ledger](https://github.com/magoz/yolk-sdk/blob/main/packages/agent/src/tools/README.md#durable-tool-ledger).

  - `@yolk-sdk/agent/tools`: `resolveTools(modules, context, { ledger: { store } })` takes a host-implemented `ToolLedgerStore` scoped by the host (for example the Workflow run id plus turn): an atomic `claim` returning `ToolLedgerClaim` (`Fresh | Completed | InFlight | Abandoned`), `heartbeat`, `complete`, and `list(parentKey)`. Ledgered calls (`defaultToolLedgerPolicy`: every non-`read` tool plus the built-in `subagent` tool; override with `isLedgered`, composing the default to keep `subagent`) share one seam for top-level calls (`call.id`) and nested code mode calls (`<parentCallId>/<seq>`). Input and interaction tools are never ledgered; their at-most-once guarantee is the host's `InteractionHost` receipts. A completed call returns its stored result without executing; an in-flight one waits until it completes or `maxWaitMs`/`deadline` passes, then returns a model-visible timeout; an abandoned one (lease expired, no result) is never re-run and tells the model it may already have been applied; the same key holding a different call is a model-visible conflict. Claim failures fail closed. Without `ledger`, behavior is unchanged.
  - Host obligations: persist `args` (an 8 KiB audit preview), `argsTruncated`, and `argsDigest` from each fresh claim and return them on every entry (`argsDigest` is lower-case hex SHA-256 of the canonical JSON of the raw `call.params`; store it as `char(64)`); keep store operations interruptible, since the ledger's per-attempt timeouts cannot cut uninterruptible store work; reserve about 15 s of the step budget after `deadline` for recording outcomes; keep call ids unique within a ledger scope.
  - Tool executors receive `idempotencyKey` (`<scope>:<ledger key>`) in `ToolExecutionInput` whenever a ledger is configured; `makeTool` and the built-in subagent registration (`SubagentExecutionInput.idempotencyKey`) forward it, and custom wrappers must forward it like `nested`. Registrations accept `abandonedResult` to describe an abandoned call; its `nested` input is `undefined` when the store cannot list the nested entries.
  - New ledger options: `leaseMs`, `heartbeatIntervalMs`, `pollIntervalMs`, `maxWaitMs`, `deadline`, `maxResultBytes`, and `onLedgerDecision` (one `ToolLedgerDecision` per ledgered call for logs and metrics; it never affects execution).
  - New exports: `ToolLedgerStore`, `ToolLedgerOptions`, `ToolLedgerClaim`, `ToolLedgerClaimRequest`, `ToolLedgerHeartbeatRequest`, `ToolLedgerEntry` (persist with `Schema.toCodecJson`), `ToolLedgerOutcome`, `ToolLedgerSucceeded`, `ToolLedgerFailed`, `ToolLedgerFailure`, `ToolLedgerError`, `ToolLedgerErrorDetails`, `ToolLedgerArgs`, `ToolLedgerPolicyInput`, `ToolLedgerAbandonedInput`, `ToolLedgerDecision`, `ToolLedgerDecisionEvent`, `InMemoryToolLedgerStore`, `makeInMemoryToolLedgerStore` (reference store; not durable), `classifyToolLedgerEntry`, `sortToolLedgerEntries`, `toolLedgerArgs`, `toolLedgerResult`, `toolIdempotencyKey`, `defaultToolLedgerPolicy`, `abandonedToolCallResult`, and the defaults `defaultToolLedgerLeaseMs`, `defaultToolLedgerPollIntervalMs`, `defaultToolLedgerMaxWaitMs`, `defaultToolLedgerMaxResultBytes`, `toolLedgerCompleteTimeoutMs`, and `toolLedgerMaxArgsBytes`.
  - `@yolk-sdk/agent/protocol`: `NestedToolCalls` gains optional per-status `counts` (`NestedToolCallCounts`) covering every call, dropped ones included. `makeNestedToolCallRecorder({ maxCalls })` sizes the record (default `nestedToolCallMaxCalls`, 256; clamped by `nestedToolCallRecordLimit` to at most `nestedToolCallMaxRecordedCalls`, 4096). New exports `truncateCodePoints`, `boundNestedToolCallArgs`, and `BoundedNestedToolCallArgs`.
  - `@yolk-sdk/codemode`: with a ledger, the `codemode` call itself is ledgered, so a re-executed call never re-runs its script. When the earlier execution was abandoned it returns an interrupted error result that lists the script's ledgered nested calls as applied, failed, or unknown (`structuredContent.codemode.interruptedCalls`, or `interruptedCallsUnavailable: true` when the store cannot list them). The `nestedCalls` record is sized from `limits.maxNestedCalls` (up to 4096) instead of a fixed 256 and carries per-status counts. New `afterNestedCall({ call, outcome, durationMs, context, result? })` hook reports `success`, `failure`, or `interrupted` for each nested call; a failing hook is logged and never changes the call's result.
  - `@yolk-sdk/vercel-workflows`: documents that tool-batch steps are at-least-once (redelivered after crashes and concurrently with a running execution, even with `noWorkflowStepRetry`), so hosts that resolve tools in a step must supply a durable ledger. No API change.

## 0.1.0-canary.98

### Patch Changes

- def9f9c: Advance unchanged public packages in lockstep with the new `@yolk-sdk/extractors` package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.97

### Minor Changes

- b5c2b69: Upgrade the coordinated Effect runtime and platform dependencies to the stable Effect 4.0.0 release. Hosts must use the matching Effect version.

  Effect 4.0.0 removes the `effect/unstable/*` entrypoints: import from `effect/http`, `effect/socket`, `effect/sql`, `effect/process` and the other `effect/<area>` paths, and take `Arbitrary` from `effect`. The former `effect/Encoding` module is split into `effect/encoding/*` (for example `Base64.encode` from `effect/encoding/Base64`).

  Effect 4.0.0 exports `Schema.isPattern` to JSON Schema only when the regex flags are `u` (optionally with `d`, `g` or `y`; not `v`, and not `u` with `i`, `m` or `s`). Yolk's connector, emulator and conformance patterns now use `u`, so connector tool parameters keep their model-visible `pattern` hints with unchanged runtime validation; the Fortnox identifier pattern is advertised as its equivalent BMP-only character class. Add `u` to `Schema.isPattern` regexes in host tool parameter schemas to keep their patterns. String `Schema.isMinLength(n)` and the `Schema.isBetweenLength` minimum (n ≥ 2) are now advertised as `minLength: ceil(n / 2)`. See the migration guide.

## 0.1.0-canary.96

### Patch Changes

- 23c322c: Advance unchanged public packages in lockstep with the new `@yolk-sdk/codemode` package, the new experimental `@yolk-sdk/conformance` and `@yolk-sdk/emulators` packages, classifier models and the code mode tool contract in `@yolk-sdk/agent`, and the new conformance subpaths in `@yolk-sdk/agent`, `@yolk-sdk/connectors`, and `@yolk-sdk/mcp`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.95

### Patch Changes

- 8d919b4: Advance unchanged public packages in lockstep with Gmail multipart sending and host-only Outlook draft attachment uploads in the connectors package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.94

## 0.1.0-canary.93

## 0.1.0-canary.92

### Patch Changes

- 7bc4f70: Advance unchanged public packages in lockstep with the new GitHub connector at `@yolk-sdk/connectors/github`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.91

### Patch Changes

- bd61ed3: Advance unchanged public packages in lockstep with OpenAI-compatible tool-result attachment lowering and connector email Sent-copy plus OneDrive move and copy actions. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.90

### Patch Changes

- 76d6c5c: Advance unchanged public packages in lockstep with native PDF attachment lowering in the agent package and Fortnox customer and invoice writes in the connectors package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.89

### Patch Changes

- 7eab996: Advance unchanged public packages in lockstep with the host-neutral background subagent guidance in the agent package and the Dropbox create-folder response fix in the connectors package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.88

### Patch Changes

- 879f27b: Advance unchanged public packages in lockstep with the portable email batch, filter, and permanent-deletion primitives in the connectors package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.87

### Patch Changes

- 30f73f0: Advance unchanged public packages in lockstep with the reviewed-email submission primitives in the connectors package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.86

### Patch Changes

- c8d74d8: Advance unchanged public packages in lockstep with action-backed interactions in the agent and harness packages. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.85

### Patch Changes

- 979db9e: Advance unchanged public packages in lockstep with the generic-email label, flag, move, and header additions. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.84

### Patch Changes

- Advance unchanged public packages in lockstep with the agent's normalized reasoning parsing fix for OpenAI-compatible chat completions. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.83

### Patch Changes

- Advance unchanged public packages in lockstep with the agent's Vercel AI Gateway DeepSeek thinking-parameter fix. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.82

### Patch Changes

- 0561764: Advance unchanged public packages in lockstep with typed input interactions and Vercel AI Gateway streaming/reasoning options. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.81

### Patch Changes

- 0fae398: Advance the unchanged public packages in lockstep with the agent chat-stream diagnostics and Microsoft Outlook connector fixes. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.80

## 0.1.0-canary.79

### Patch Changes

- 3c243ee: Align all public SDK packages for the Go Responses replay fix and the branded-identity TypeScript migration. MCP and Vercel Workflows have no direct API or runtime changes in this release; they advance with the fixed SDK package group.

## 0.1.0-canary.78

### Minor Changes

- 5ff44d6: Export canonical tagged constructors on existing subpaths: `PlainHitlResponse` and `RuntimeRequest` values, React chat ADTs, harness inbox/outcome/`StopDecision` companions, knowledge source/scope `.make`, and workflow `WorkflowStepResult` / `VercelAgentWorkflowRunResult`.

  `Data.taggedEnum` values are plain objects with `_tag` last, not Equal/Hash classes. Prefer constructors over handwritten `{ _tag }` objects and omit absent optionals.

- 5ff44d6: Upgrade the coordinated Effect runtime and platform dependencies to 4.0.0-rc.115. Hosts must use the matching Effect version.

  Adopt rc.115 schema-order construction, including `_tag` first: JSON field values and optional presence remain unchanged, but serialized property order can change. Schema errors now use the rc.115 native Error/SchemaIssue representation. Preserve strict Calendar boundary validation, closed empty tool schemas, portable custom JSON Schema output, and explicit WebSocket close semantics.

  Contributor property tests use native Effect arbitraries and Vitest 5. See the migration guide for API replacements and JSON Schema definition-name changes.

### Patch Changes

- 5ff44d6: Tighten `makeTool({ invalidParamsMessage })` on `@yolk-sdk/agent/tools` to
  `(error: Schema.SchemaError) => string`. Default remains
  `Invalid ${name} arguments: ${String(error)}`, including the `SchemaError(...)` wrapper.
  In Effect rc.115, `SchemaError` extends native `Error`, but the wrapper remains part of this
  tool-message contract; do not default to `.message`. Existing
  `(error: unknown) => string` callbacks remain assignable. No new export subpath.

  Tighten `commitThenWriteTerminalEvent({ writeCommitError })` on `@yolk-sdk/vercel-workflows` to
  the existing `CommitError` generic from `commit`. Result `commitError` / `error` fields stay
  `unknown`. Existing `(error: unknown) => …` callbacks remain assignable. No generic expansion.

- 5ff44d6: Keep each Workflow tool-batch HITL response array independent from the loop's accumulator, preserving response order and element identity. Normalize custom React chat transport rejections through the existing transport error owner, retaining their underlying cause and recognizing aborts.

  Return a JSON-RPC invalid-request response when a legacy MCP HTTP request body cannot be read. Precisely narrow missing-sandbox SDK errors to HTTP 404/410 without assuming an object-shaped error payload or discarding other API errors.

## 0.1.0-canary.77

### Patch Changes

- 6b9c60b: Release all seven public packages together.

  This canary introduces `@yolk-sdk/harness` run lifecycle and related agent loop composition, collection, Codex missing-final-output, and overflow-after-output changes. `@yolk-sdk/connectors`, `@yolk-sdk/knowledge`, `@yolk-sdk/mcp`, `@yolk-sdk/sandbox`, and `@yolk-sdk/vercel-workflows` are unchanged except for lockstep compatibility.

## 0.1.0-canary.76

### Patch Changes

- 8f5ea35: Add host-only retrieval for Google Drive download/export, Gmail, Outlook, IMAP/POP3, Notion, Telegram, Todoist attachments, Fortnox preview/archive, and R2 gets, plus bounded Dropbox/OneDrive writes and conditional R2 puts. Preserve GET-only binary adapters, base64 attachment actions, and R2 presigning. OneDrive update requires acknowledgeOverwrite and is unconditional, not CAS; Dropbox revision and R2 ETag preconditions stay strict. Add Fortnox list_supplier_invoice_files and Todoist list_comments read actions. Drive bytes default to drive.file with host-only drive.readonly opt-in; Fortnox archive/connectfile slots are opt-in and not added to the combined hint. No generic agent byte actions or app wiring.
- 34b4275: Add a host-only Dropbox original-byte download helper, `downloadDropboxFile`, on `@yolk-sdk/connectors/dropbox`. It mirrors the host-only OneDrive original-byte helper, but Dropbox never follows content redirects. It reuses the existing `dropbox.oauth` binding through a new `files.content.read` scope and `DropboxContentReadOAuthCredentialSlot` (now also included in `DropboxCombinedOAuthCredentialSlot`), calls the Dropbox content endpoint once through the optional bounded binary HTTP port, returns allowlisted `Dropbox-API-Result` metadata plus untouched bytes, and sanitizes failures to typed codes. Default Dropbox actions and agent serialization are unchanged. Hosts still implement connection-time network policy, streamed limits, and app-owned file materialization/read tools.

## 0.1.0-canary.75

### Minor Changes

- 7f238d8: Add a host-only OneDrive/SharePoint original-byte download helper and an optional bounded binary HTTP port. Reuse existing Microsoft read credentials, resolve remote item identities, sanitize failures, and strip all original headers on download redirects. Default Microsoft actions and agent serialization are unchanged. Hosts still implement connection-time network policy, streamed limits, and app-owned file materialization/read tools.

## 0.1.0-canary.74

### Patch Changes

- 79fe70b: Reject disabled question calls without entering HITL, and distinguish matching subagent
  observations from terminal child completion without charging nested usage. Supply deterministic
  zero-based read/sleep attempt indices to `awaitWorkflowChild` so durable hosts can bound
  observation polling and apply capped backoff while preserving existing zero-argument callbacks.

## 0.1.0-canary.73

### Patch Changes

- 6672571: Add opt-in background subagent acknowledgements without premature child-completion events,
  public whole-batch HITL preflight, and generic bounded Workflow tool orchestration and durable
  child read/sleep seams. Preserve inline subagent compatibility and logical usage identity.
  The Next example wires independent foreground/background child workflows with owned durable
  reservations/results and tombstone-first explicit Stop cancellation.
- 2749df0: Add Effect-native `resolveMessageAttachmentSources` and `resolveMessagesAttachmentSources` protocol helpers. Traverse user, assistant, and tool-result media, including nested assistant provider tool results, while preserving metadata and ordering without mutation or caching. Document host-owned fresh signing inside provider retries, native PDF/image tool results, and bounded attachment transport.

  Validate Gmail discovery attachment sizes as nonnegative integers and omit malformed optional size metadata. Keep download limits, decoded-byte validation, authorization, storage, and extraction policy host-owned.

## 0.1.0-canary.72

### Patch Changes

- 79b6ff8: Align installation examples with the SDK's Effect version, correct Google connector tool wiring, document Outlook optional read inputs, and date previously released canary migrations.
- 9897531: Add `@yolk-sdk/connectors/fortnox` with nine read-only actions for company information and list/get customers, invoices, suppliers, and supplier invoices. Include typed schemas, pagination, resource-scoped OAuth credential hints, provider failure handling, and agent-tool access metadata. Hosts retain HTTP execution, OAuth lifecycle, credentials, and policy; Fortnox OAuth scopes themselves still grant read and write access.
- 782092d: Normalize null and blank optional inputs for Outlook message search and listing, including null page sizes, before execution. Direct connector callers and generated agent tools now share the compatibility behavior while preserving real cursors, input validation, application-mailbox guards, and provider failures.

## 0.1.0-canary.71

## 0.1.0-canary.70

## 0.1.0-canary.69

## 0.1.0-canary.68

### Patch Changes

- 73e7a9b: Refresh public guidance for durable user-message events, voice WebSocket wiring, Calendar event boundaries, and Workflow testing.

## 0.1.0-canary.67

### Patch Changes

- 0da67d1: Add replay-safe durable user-message events and skip empty tool-batch steps when a workflow model turn continues without tool calls.
- 57795cf: Refresh public package descriptions, connector access guidance, and documented package subpaths.

## 0.1.0-canary.66

### Patch Changes

- Document the `workflow@^5.0.0-beta.42` requirement, the `./testing` subpath, and region-pinned streaming behavior in the published README.

## 0.1.0-canary.65

### Patch Changes

- a2b7057: Require `workflow@^5.0.0-beta.42`: the 5.x line makes Vercel Workflow runs region-pinned
  (multi-region default since 5.0.0-beta.33), serving storage, queuing, and durable streams
  region-locally instead of routing through `iad1`. Verified against the real v5 local world by the
  package directive integration tests.

## 0.1.0-canary.64

### Minor Changes

- a9bd5e2: Add a `./testing` subpath exporting `TestWorkflowWorld`, a behavioral Vercel
  Workflow platform emulator for host tests: run lifecycle, append-only durable
  streams with close-once -> HTTP 409 "already completed" conflicts, a step
  executor honoring `fn.maxRetries` with 1-based `getStepMetadata().attempt`
  metadata, hooks/resume, cancellation, a `VercelWorkflowsSdkClient` adapter for
  `VercelWorkflows.layerFromSdk`, and a `testWorkflowModule` surface for mocking
  the ambient `workflow` module.

## 0.1.0-canary.63

## 0.1.0-canary.62

## 0.1.0-canary.61

## 0.1.0-canary.60

## 0.1.0-canary.59

### Patch Changes

- a5581f7: Refresh public package documentation with verified imports, runtime boundaries, and host responsibilities.

## 0.1.0-canary.58

## 0.1.0-canary.57

### Patch Changes

- da9e8ba: Refresh package documentation with runtime requirements, host responsibilities, subpath boundaries, and corrected usage examples.
- de55946: Classify Codex context-window failures as context overflow, support endpoint-specific input budgets, expose subagent usage and redacted typed error summaries (including partial failed-run usage), reject subagent streams without terminal events, and clarify that ChatGPT Codex ignores output-token configuration. Carry tool-owned nested-model usage through durable workflow state and HITL failures, preserve wire-safe partial-progress failures, and normalize Workflow turn limits to positive integers.

## 0.1.0-canary.56

## 0.1.0-canary.55

## 0.1.0-canary.54

## 0.1.0-canary.53

## 0.1.0-canary.52

## 0.1.0-canary.51

## 0.1.0-canary.50

## 0.1.0-canary.49

### Patch Changes

- 9b50918: Normalize non-finite Workflow retry attempt counts to one attempt instead of retrying forever.

## 0.1.0-canary.48

## 0.1.0-canary.47

## 0.1.0-canary.46

## 0.1.0-canary.45

## 0.1.0-canary.44

## 0.1.0-canary.43

## 0.1.0-canary.42

### Patch Changes

- Add compaction checkpoint formatting and one-shot context-overflow retry helpers.

## 0.1.0-canary.41

### Patch Changes

- 6303c57: Remove terminal-event helper stream closing so workflow loop owns final close.

## 0.1.0-canary.40

### Patch Changes

- Make public client, Workflow, and sandbox helpers Effect-native.

## 0.1.0-canary.39

### Patch Changes

- Expose Effect-native attachment and durable workflow helpers, and refresh package documentation for current public exports.

## 0.1.0-canary.38

### Patch Changes

- Harden agent transport and voice Effect boundaries.

## 0.1.0-canary.37

### Patch Changes

- Publish canary with agent client stream continuation fixes and package docs updates.

## 0.1.0-canary.36

## 0.1.0-canary.35

## 0.1.0-canary.34

## 0.1.0-canary.33

### Patch Changes

- Voice as a first-class agent modality in `@yolk-sdk/agent`:

  - `@yolk-sdk/agent/voice`: provider-neutral voice protocol, client controller, server tool handler with approval HITL, transcript projection, durable voice event ids, WebSocket transport, and one-shot TTS/STT service contracts (`VoiceSpeechSynthesizer`, `VoiceTranscriber`, `VoiceSpeechRequest.instructions` for delivery-style steering).
  - `@yolk-sdk/agent/voice/browser`: Effect-native browser WebRTC voice transport with a fakeable runtime seam.
  - `@yolk-sdk/agent/voice/react`: headless `useYolkVoice` browser hook.
  - `@yolk-sdk/agent/providers/openai/realtime`: OpenAI Realtime session config, event codecs, and voice client codec.
  - `@yolk-sdk/agent/providers/openai/speech`: OpenAI TTS/STT adapters; 429 responses surface as `VoiceSpeechError` code `rate_limited` so hosts can distinguish quota exhaustion from outages.
  - Projection keys assistant drafts per provider output item (falling back to response id): back-to-back responses, multi-item responses, and duplicate final transcript event families no longer concatenate, wipe, or duplicate projected messages.

  Other `@yolk-sdk/*` packages ship as part of the lockstep canary release.

## 0.1.0-canary.32

### Patch Changes

- Add Effect-native Vercel Workflow host wrappers and refresh package documentation.

## 0.1.0-canary.31

### Patch Changes

- Simplify knowledge to document, file, chunk, context, and search contracts.

## 0.1.0-canary.30

## 0.1.0-canary.29

### Patch Changes

- Expose terminal agent event detection and add Workflow terminal commit-barrier helpers.

## 0.1.0-canary.28

## 0.1.0-canary.27

## 0.1.0-canary.26

### Minor Changes

- Add replay-safe workflow event sequencing and chat projection helpers.

## 0.1.0-canary.25

### Patch Changes

- Fix connector provider pagination, Google scoped OAuth, Gmail drafts/send-as, LinkedIn queued email lookup, and R2 public URL handling.

## 0.1.0-canary.24

## 0.1.0-canary.23

## 0.1.0-canary.22

## 0.1.0-canary.21

### Patch Changes

- Surface typed provider failure metadata, retry state, and retry-aware chat items.

## 0.1.0-canary.20

## 0.1.0-canary.19

## 0.1.0-canary.18

## 0.1.0-canary.17

### Patch Changes

- 92d966b: Expose structured model-visible tool error details.

## 0.1.0-canary.16

## 0.1.0-canary.15

### Minor Changes

- Unify public package shape around `@yolk-sdk/agent` subpaths, fold React/OAuth/provider/skillset/voice APIs into the agent package, and rename Vercel Workflow imports to `@yolk-sdk/vercel-workflows`.

## 0.1.0-canary.14

## 0.1.0-canary.13

### Minor Changes

- Add model-visible message envelopes with timestamps, author display names, and annotations.

## 0.0.1-canary.12

## 0.0.1-canary.11

## 0.0.1-canary.10

## 0.0.1-canary.9

## 0.0.1-canary.8

## 0.0.1-canary.7

### Patch Changes

- Add package-owned workflow orchestration with HITL await-input resume support.

## 0.0.1-canary.6

## 0.0.1-canary.5

## 0.0.1-canary.4

## 0.0.1-canary.3

## 0.0.1-canary.2

### Patch Changes

- 55bc6c7: Prepare next canary release.

## 0.0.1-canary.1

### Patch Changes

- Prepare next canary release.

## 0.0.1-canary.0

### Patch Changes

- 4232c86: Prepare first public canary release.
