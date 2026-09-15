# @yolk-sdk/agent

## 0.1.0-canary.78

### Minor Changes

- 5ff44d6: Export canonical tagged constructors on existing subpaths: `PlainHitlResponse` and `RuntimeRequest` values, React chat ADTs, harness inbox/outcome/`StopDecision` companions, knowledge source/scope `.make`, and workflow `WorkflowStepResult` / `VercelAgentWorkflowRunResult`.

  `Data.taggedEnum` values are plain objects with `_tag` last, not Equal/Hash classes. Prefer constructors over handwritten `{ _tag }` objects and omit absent optionals.

- 5ff44d6: Upgrade the coordinated Effect runtime and platform dependencies to 4.0.0-rc.115. Hosts must use the matching Effect version.

  Adopt rc.115 schema-order construction, including `_tag` first: JSON field values and optional presence remain unchanged, but serialized property order can change. Schema errors now use the rc.115 native Error/SchemaIssue representation. Preserve strict Calendar boundary validation, closed empty tool schemas, portable custom JSON Schema output, and explicit WebSocket close semantics.

  Contributor property tests use native Effect arbitraries and Vitest 5. See the migration guide for API replacements and JSON Schema definition-name changes.

- 00e4d60: Add OpenCode Go API-key provider support for host-selected Chat Completions, Anthropic Messages, and OpenAI Responses protocols, with explicit output limits and native tool/reasoning handling.

  Add best-effort Go subscription usage snapshots for rolling, weekly, and monthly allowance windows using the fixed API-key usage endpoint. Hosts retain credential, model, polling, and UI policy.

  Share Anthropic lowering/parsing without applying Claude OAuth fingerprints to Go. Reject filtered Messages output and ignore frames after terminal completion. Sanitize Go provider errors while preserving classified metadata.

- 5ff44d6: `WebRtcPeerConnectionLike.addTrack` on `@yolk-sdk/agent/voice/browser` is a void command (was unused `unknown`). Hosts and fakes must not read a sender. Real `RTCPeerConnection.addTrack` remains assignable. No export-map change.

  Voice raw-argument JSON on `@yolk-sdk/agent/voice`: `protocolToolCallFromVoice` and `decideVoiceToolCall` admit finite JSON. Actual `null` / `false` / `0` still admit as those values. Raw text `1e999` uses the existing malformed fallbacks instead of publishing `Infinity` (projection params `'1e999'`; approval display `{ argumentsJson: '1e999' }`). Nested overflow takes the same fallbacks. Do not demonstrate with `JSON.stringify(Infinity)` (that is `null`). Execution schema validation and approval identifiers/gates are unchanged.

  `@yolk-sdk/mcp/client` and `@yolk-sdk/mcp/protocol` export Schema owners `InitializeClientInfo`, `InitializeParams`, `InitializedNotification`, and `ToolsCallParams`. Prefer Schema owners for new construction. Compatibility `makeJsonRpcRequest`, `makeInitializeParams`, and `makeInitializedNotification` remain and omit `params` when `undefined`. No new export subpath.

- 5ff44d6: **Breaking type imports** (runtime and wire unchanged; no compatibility aliases):

  - `LoopConfigShape` → `LoopConfigSettings` from `@yolk-sdk/agent/loop`
  - `RunStoreShape` → `RunStoreApi` from `@yolk-sdk/harness/store`
  - `InboxShape` → `InboxApi` from `@yolk-sdk/harness/inbox`
  - `DriverShape` → `DriverApi` from `@yolk-sdk/harness/driver`

  ```ts
  import type { LoopConfigSettings } from '@yolk-sdk/agent/loop'
  import type { RunStoreApi } from '@yolk-sdk/harness/store'
  import type { InboxApi } from '@yolk-sdk/harness/inbox'
  import type { DriverApi } from '@yolk-sdk/harness/driver'
  ```

- 5ff44d6: Breaking: `OpenAiProviderConfig.extraBody` takes JSON-object input (`OpenAiRequestExtras`). Untyped runtime input is still snapshotted and validated at request lowering; layer creation stays Effect-lazy and does not walk extras or credentials.

  Admission copies own data properties once (cycle-stack + DAG memo), then uses that snapshot. Surviving accessors, functions, `undefined`, nonfinite numbers, cycles, arrays-at-root, `null`, primitives, Date/Map, and class/custom-prototype objects fail non-retryable `LLMError` `provider_error` with a fixed `Invalid … extraBody JSON: expected a JSON object` message that does not echo values. Canonical keys `model`, `messages`, `stream`, `tools`, `parallel_tool_calls`, `max_completion_tokens`, and `max_tokens` — plus `reasoning` when `reasoningEffortFormat` is `'reasoning-object'` — are omitted by key without reading values. JSON `null`/`false`/`0`, own `__proto__`/`constructor` keys, dense arrays, and DAG aliases are kept. Identity is not preserved: extras on the request are a snapshot. Composed-body `Schema.Json` serialization after lone-surrogate rewrite remains the last finite-JSON defense. Vercel AI Gateway emits JSON `models` / `providerOptions` as `OpenAiRequestExtras`.

  Migrate hosts: pass portable JSON objects only; do not rely on live getters, class instances, or serialize-time extraBody validation. See the agent README and migration guide for the new admission boundary.

- 5ff44d6: `ToolDef.parameters` admits a JSON Schema **representation** at construction: boolean schema or plain JSON object (unknown annotation keywords allowed as JSON). This is not meta-schema validation and is not `Schema.Json` for tool call params, results, or HITL — those stay opaque.

  Admission is identity-preserving (not a Record snapshot): enumerable data-only own string keys, including own `__proto__`/`constructor`, dense `Array.prototype` arrays, primitives, null-prototype objects, and DAG aliases. Accessors are rejected from property descriptors and are not invoked. Cycles, nonfinite numbers, functions, `undefined` values, Date/Map/class/custom prototypes, and sparse arrays fail before a tool runs. Effect/Result decoding reports `SchemaError`; synchronous `ToolDef.make` and `makeTool`'s generated-document admission throw the installed Effect constructor's `Error` shape with a `SchemaIssue` cause. Proxy traps on `ownKeys`/`getOwnPropertyDescriptor` are not claimed immune.

  Background activation wraps boolean `true`/`false` parameter documents as `arguments` schemas (not `{}`). Unsupported `$ref`/resource keywords still fail only at activation.

  MCP `tools/list` `inputSchema` admits the object arm at decode (`McpError` `validation`). Boolean MCP input schemas are rejected there. Omitted MCP input schemas still default to `{ type: 'object', additionalProperties: true }`.

- 5ff44d6: Voice sessions are now an injectable Effect resource graph instead of a React-owned factory trio.

  This is a breaking 0.x change: `makeVoiceController` no longer accepts a `transport` value and instead yields `VoiceTransport`. Hosts that already have an API value should `Effect.provideService(VoiceTransport, transport)` or pass `Layer.succeed(VoiceTransport, transport)` into `VoiceSession.layer`. `Layer.succeed` injects a caller-owned transport and does not allocate or finalize it.

  - New `VoiceSession` (`@yolk-sdk/agent/voice`) composes one session from a supplied transport layer, `VoiceController`, and optional `eventLog`. Configured durable logging is session-owned: controller events are captured even without an external `events` consumer, and omitting `eventLog` never reads an ambient `VoiceEventOutbox`.
  - `webRtcVoiceTransportLayer` and `webSocketVoiceTransportLayer` publish a connected transport as `VoiceTransport`. `VoiceController.layer` / `VoiceEventOutbox.layer` wrap the existing scoped factories.
  - `useYolkVoice` still owns UI state, latest callbacks, HITL helpers, attempt cancellation, and audio-element identity. It no longer imports service constructors; each `start()` provides a fresh `VoiceSession.layer`.

- 5ff44d6: Claude lowering requires `ToolDef.parameters` and `ToolCall.params` to decode as `Schema.Json`; non-JSON fails non-retryable `LLMError` `provider_error`. Lone-surrogate rewrite is re-decoded as JSON (failure, not skip). HTTP non-JSON errors still classify from status.

  `useAgentChat` dispatches/returns the existing `AgentChatAction` and hook-result constructors (`Data.taggedEnum` plains, `_tag` last, not Equal/Hash classes). Prefer constructors and `$is`; omit absent optionals. `Schema.TaggedStruct.make` still validates duration plains.

- 5ff44d6: OpenAI Chat Completions and Responses admit `ToolDef.parameters` and tool-call `params` as `Schema.Json` before transport. Non-JSON fails non-retryable `LLMError` `provider_error`. `ToolDef.parameters` admits a `ToolJsonSchema` representation at construction; tool-call params and results stay opaque. Public Codex `OpenAiCodexTool.parameters` remains `unknown`. Inbound HTTP JSON and Responses SSE JSON admit `Schema.Json`; non-object SSE JSON is ignored, malformed non-JSON event text fails `invalid_response`, and HTTP error bodies stay raw text.

  `OpenAiProviderConfig.extraBody` now takes `OpenAiRequestExtras` JSON-object input, also used by Gateway. Request lowering snapshots surviving fields and discards canonical keys without reading their values. Surviving accessors and non-JSON values fail non-retryable `provider_error` with `Invalid … extraBody JSON: expected a JSON object`; getters are not invoked. Composed-body `Schema.Json` serialization after lone-surrogate rewriting remains the final finite-JSON defense.

  Public Realtime `OpenAiRealtimeFunctionTool.parameters` and `openAiRealtimeToolParameters` now require `Schema.Json`. Non-JSON advertisement fails `VoiceToolBridgeError` (sync throw / Effect fail). Mapper defects stay defects. Union-root lowering merges own `__proto__` / `constructor` via `Map`.

  Gmail `get_thread` / `list_attachments` MIME `payload` admits `Schema.Json` after JSON parse. Best-effort optional size omission and sibling preservation are unchanged. Raw HTTP `1e999` → `Infinity` rejects the whole payload (`ConnectorError` `validation_failed`). Public Gmail action classes and `gmail.get_attachment` are unchanged.

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

### Minor Changes

- 7827908: Add optional `LLMError.responseIssue: 'missing_done'` for kernel zero-Done completions, `collectModelTurnAttempt` for partial-failure model-turn collection, and shared overflow compaction that runs only before published output. `collectModelTurn` still finalizes `assistantMessage` only from `AssistantMessage` events. Pure typed sink/stream failures stay `SinkFailed`/`StreamFailed`; Causes that also contain a defect or interruption stay on the error channel, including Fail annotations.

### Patch Changes

- 978ea8f: Recover Codex streams that omit a final `output` payload and normalize context-window errors in the provider.
- 978ea8f: Name the loop composition kernel: `makeAgentLoopLayer`, `decorateLLMProvider`, `collectModelTurn`, and `collectModelTurnAttempt`. Omitted tools use `ToolExecutor.unavailable`.
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
- 79fe70b: Add explicit opt-in, model-chosen background tool calls. `makeTool`/`ToolRegistration` accept a
  `background: true` capability that stays inert until `resolveTools` receives a lifecycle-owning
  `BackgroundToolHost`. Activated tools expose a required `{ execution, arguments }` envelope with the
  original schema nested unchanged; the registry validates without business effects, strips control
  fields, and returns one acknowledgement `ToolResult` with typed `acceptance` metadata. The loop
  emits `ToolExecutionAccepted` instead of completion or usage, approval ids bind the exact payload
  and mode for activated calls, and client/React projections treat `Accepted` as settled but not
  completed and protect acceptance from stale Started/input replay. Activation rejects unsupported
  JSON Schema references/resource boundaries with `background_unsupported_schema` while preserving
  ordinary document-root `$defs` references and literal default/example data. Activated definitions
  fail closed at realtime advertisement and voice dispatch (including replayed approvals and the
  low-level bridge); voice toolsets must resolve without a background host. Definitions and behavior
  without a host are unchanged.

  Preserve entire accepted calls and receipts across active-event replay, terminal/next-turn cleanup,
  and hydration without classifying admission as completion. Add typed Effect realtime mapper/config
  builders alongside the synchronous APIs, preserving fail-closed voice behavior. Activated makeTool
  business-argument failures retain their structured model-visible contract before any effects. Share
  receipt-preserving result-to-message conversion and loop-owned tool names. Document intentionally
  lossless, potentially long canonical-payload approval IDs and host input/storage responsibilities.

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

### Patch Changes

- 7c636c9: Upgrade the Effect runtime to beta.80 so rejected HTTP response bodies retain their typed transport errors instead of becoming cleanup defects and leaving durable-run streams pending. Keep the Effect platform packages aligned with that runtime.

  Ensure HTTP callback producers forward all failure causes to consumers, including unexpected host callback defects, without wrapping defects as recoverable transport errors.

## 0.1.0-canary.69

### Patch Changes

- 9747ec9: Forward run-level reasoning effort to every Vercel AI Gateway model through the Gateway reasoning object.

## 0.1.0-canary.68

### Patch Changes

- 73e7a9b: Refresh public guidance for durable user-message events, voice WebSocket wiring, Calendar event boundaries, and Workflow testing.

## 0.1.0-canary.67

### Minor Changes

- 0da67d1: Add replay-safe durable user-message events and skip empty tool-batch steps when a workflow model turn continues without tool calls.

### Patch Changes

- 57795cf: Refresh public package descriptions, connector access guidance, and documented package subpaths.

## 0.1.0-canary.66

## 0.1.0-canary.65

## 0.1.0-canary.64

## 0.1.0-canary.63

## 0.1.0-canary.62

### Patch Changes

- 7677e18: Require a host-owned Grok CLI `clientVersion` on `XAiGrokProviderConfig`, sent as `x-grok-client-version`, because the xAI CLI proxy version-gates subscription requests and rejects missing or outdated versions with HTTP 426.

## 0.1.0-canary.61

### Patch Changes

- 025b16b: Preserve paragraph boundaries between OpenAI Responses reasoning summary parts.
- f495460: Add a best-effort xAI Grok consumer subscription-allowance adapter with modern and safe legacy normalization, explicit xAI identity headers, and sanitized private-endpoint failures.

## 0.1.0-canary.60

### Patch Changes

- 8ac2ad9: Add a dedicated Vercel AI Gateway provider with API key or OIDC authentication, provider routing, model fallbacks, safe error attribution, tests, and public documentation.

## 0.1.0-canary.59

### Patch Changes

- eb908b7: Add xAI Grok subscription OAuth/broker helpers and a streaming Responses provider for the xAI CLI proxy, with host-owned output limits, normalized reasoning/tools/usage, and safe provider failures.
- a5581f7: Refresh public package documentation with verified imports, runtime boundaries, and host responsibilities.

## 0.1.0-canary.58

### Patch Changes

- a4a3d52: Add best-effort Anthropic Claude and OpenAI Codex subscription-allowance snapshot adapters with portable Effect HTTP, shared schemas, sanitized errors, and host-owned polling policy.

## 0.1.0-canary.57

### Patch Changes

- da9e8ba: Refresh package documentation with runtime requirements, host responsibilities, subpath boundaries, and corrected usage examples.
- de55946: Classify Codex context-window failures as context overflow, support endpoint-specific input budgets, expose subagent usage and redacted typed error summaries (including partial failed-run usage), reject subagent streams without terminal events, and clarify that ChatGPT Codex ignores output-token configuration. Carry tool-owned nested-model usage through durable workflow state and HITL failures, preserve wire-safe partial-progress failures, and normalize Workflow turn limits to positive integers.

## 0.1.0-canary.56

### Patch Changes

- 2013d5e: Keep Anthropic tool input schemas valid when Effect Schema emits repeated constraints inside `allOf`.

## 0.1.0-canary.55

### Minor Changes

- 6297363: Rename the model-facing `task` delegation tool and its public helpers to `subagent` so hosts can distinguish isolated child-agent runs from durable application tasks.

## 0.1.0-canary.54

### Minor Changes

- Forward supported protocol reasoning efforts to Anthropic Claude through `output_config.effort`.

### Patch Changes

- Preserve every sibling function call in streamed OpenAI Codex Responses while deduplicating final-response replays by call ID.

## 0.1.0-canary.53

### Minor Changes

- a47adb1: Let hosts expose validated model and reasoning-effort choices on the task subagent tool, and include the selected reasoning effort in structured task results.

## 0.1.0-canary.52

### Patch Changes

- 15d0159: Omit the unsupported `max_output_tokens` field from ChatGPT subscription Codex requests while retaining required host `maxOutputTokens` configuration.

## 0.1.0-canary.51

## 0.1.0-canary.50

## 0.1.0-canary.49

## 0.1.0-canary.48

### Patch Changes

- 6cfc7fb: Require hosts to configure model-specific output limits for Anthropic and OpenAI providers.

## 0.1.0-canary.47

### Patch Changes

- b0576d3: Fail Claude turns truncated at `max_tokens` instead of reporting normal completion.

## 0.1.0-canary.46

### Patch Changes

- Classify Anthropic context overflow, support tokenizer-backed compaction estimates, and return
  normalized Gmail threads without raw MIME or attachment bytes.

## 0.1.0-canary.45

### Patch Changes

- d8c0b7a: Send image and document tool results to OpenAI Codex as native function output content.

## 0.1.0-canary.44

### Patch Changes

- 607255e: Send image and document tool results to Anthropic Claude as native content blocks.

## 0.1.0-canary.43

### Patch Changes

- 5c53852: Pass URL-backed documents through as OpenAI Codex Responses input files.

## 0.1.0-canary.42

### Patch Changes

- Add compaction checkpoint formatting and one-shot context-overflow retry helpers.

## 0.1.0-canary.41

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

### Patch Changes

- afb30a0: `voiceSeedTextsFromMessages` gains `{ includeAuthors }`: prefixes user seeds with author display names so multi-user transcripts keep who-said-what when replayed into realtime voice sessions.

## 0.1.0-canary.35

### Patch Changes

- e9d235d: Harden model-produced text: `replaceLoneSurrogates`/`replaceLoneSurrogatesDeep` protocol utils, applied to lowered provider request bodies (OpenAI, Codex, Claude) and OpenAI Realtime client codec payloads so lone UTF-16 surrogates in replayed transcripts cannot poison model calls.
- 26b8b4d: Durable voice session logs: versioned `VoiceSessionLogState` + pure `foldStoredVoiceEvents` batch fold, deterministic tool event ids (`voiceToolEventId`, `storedVoiceToolEvents`, `storedToolEventsFromOutcome`) so server-witnessed tool logs dedupe against client replays, `makeVoiceEventOutbox` + `useYolkVoice` `eventLog` option for at-least-once client event batching, and projection now keeps streamed draft text when finals arrive with empty transcripts.

## 0.1.0-canary.34

### Patch Changes

- 01719c0: Lower union-root (`anyOf`) tool parameters to a single object schema in `toOpenAiRealtimeTool`; OpenAI Realtime hangs until a gateway timeout (504) on union-root function tools. Exposes `openAiRealtimeToolParameters`.

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

### Patch Changes

- 4148be9: Poll empty durable run continuation chunks and abort promptly while waiting.

## 0.1.0-canary.29

### Patch Changes

- Expose terminal agent event detection and add Workflow terminal commit-barrier helpers.

## 0.1.0-canary.28

### Patch Changes

- 90b0558: Fix Anthropic streamed usage deltas and include cache tokens in input totals.

## 0.1.0-canary.27

### Patch Changes

- Add durable run continuation and HITL resume client helpers.

## 0.1.0-canary.26

### Minor Changes

- Add replay-safe workflow event sequencing and chat projection helpers.

## 0.1.0-canary.25

### Patch Changes

- Fix connector provider pagination, Google scoped OAuth, Gmail drafts/send-as, LinkedIn queued email lookup, and R2 public URL handling.

## 0.1.0-canary.24

## 0.1.0-canary.23

### Patch Changes

- e8ac8ce: Support URL-backed image and PDF attachment lowering in agent providers.

## 0.1.0-canary.22

### Patch Changes

- 378cd92: Turn recoverable tool execution failures into model-visible error tool results, add transcript repair/validation helpers, and preflight dangling tool calls before provider lowering.

## 0.1.0-canary.21

### Patch Changes

- Surface typed provider failure metadata, retry state, and retry-aware chat items.

## 0.1.0-canary.20

### Patch Changes

- Add text document attachment helpers.

## 0.1.0-canary.19

## 0.1.0-canary.18

## 0.1.0-canary.17

### Patch Changes

- 92d966b: Expose structured model-visible tool error details.
- 6a6d7a6: Add helpers for model-visible recoverable tool failures.

## 0.1.0-canary.16

### Minor Changes

- ca545a6: Add pure agent compaction utilities under `@yolk-sdk/agent/compaction`.

## 0.1.0-canary.15

### Minor Changes

- Unify public package shape around `@yolk-sdk/agent` subpaths, fold React/OAuth/provider/skillset/voice APIs into the agent package, and rename Vercel Workflow imports to `@yolk-sdk/vercel-workflows`.

## 0.1.0-canary.14

## 0.1.0-canary.13

### Minor Changes

- Add model-visible message envelopes with timestamps, author display names, and annotations.
- 3797339: Add model-visible message envelope fields for timestamps, author display names, and annotations.

## 0.0.1-canary.12

### Patch Changes

- b5a297a: Add HITL response helpers and serializable question results.

## 0.0.1-canary.11

### Patch Changes

- 0c7ed24: Drain HTTP agent streams after terminal events.

## 0.0.1-canary.10

## 0.0.1-canary.9

### Patch Changes

- Add typed attachment sources for inline media, URLs, and host-owned refs.

## 0.0.1-canary.8

### Patch Changes

- 76d5c21: Add document chat content parts with provider lowering.

## 0.0.1-canary.7

## 0.0.1-canary.6

### Patch Changes

- Add package-owned task subagent helpers for non-recursive tool exposure, result formatting, and protocol-aligned subagent run ids.

## 0.0.1-canary.5

## 0.0.1-canary.4

### Patch Changes

- 992ae2c: Require exact HITL request matches before resuming runtime sessions.

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
