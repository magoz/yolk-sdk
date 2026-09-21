# @yolk-sdk/connectors

## 0.1.0-canary.88

### Minor Changes

- 3bcbcd5: Add portable email read/flag discovery and filtered listing, explicit batch mailbox mutations, and UID-scoped permanent deletion contracts with additive host methods and validated per-message outcomes.

  Gmail reports read state from the `UNREAD` label and flag state from the `STARRED` label (absent when labels are omitted), with matching typed filters on search/list, an explicit `gmail.set_read`, and individually addressed batch mutations plus immediate permanent deletion behind opt-in full-mail consent. Outlook reports `isRead` with follow-up flag state as `isFlagged`, typed list filters composed into `$filter`, and Graph JSON-batched mutations plus `permanentDelete`, which enters Recoverable Items rather than erasing retained data. Providers keep their native organization models (Gmail labels, Outlook flags/folders/categories, IMAP flags/keywords/folders); batch reports return complete per-ID outcomes with exact counts and sanitized codes only, and every succeeded generic move-shaped result requires destination `folder`.

### Patch Changes

- Updated dependencies [879f27b]
  - @yolk-sdk/agent@0.1.0-canary.88

## 0.1.0-canary.87

### Patch Changes

- 1e4cc7d: Add reviewed-email provider primitives: `gmail.send_message` submits complete host-generated base64url MIME for new emails or properly threaded replies, `outlook.update_draft` edits recipients, subject, and full replacement body on an existing draft, and `outlook.reply` sends the complete reviewed reply in one Graph `POST .../reply` with no intermediate mutable draft.

  The new `outlook.update_draft` and `outlook.reply` actions reject malformed UTF-16 (lone surrogates) in message and mailbox identities at the schema boundary, before credential or network access, so path encoding can no longer throw outside the typed failure channel. Valid Unicode, including valid surrogate pairs, and slash-containing opaque Graph IDs still encode as complete path segments.

  Gmail sending declares destructive access and reports accepted submission, not delivery. It uses the existing Google credential binding with a least-privilege send-scope hint; when OAuth scope metadata carries an existing compose/modify/full-mail grant, the action selects and re-resolves through that operation slot, preserving strict host enforcement without requesting unnecessary consent. The combined scope set is unchanged. MIME construction, header safety, sender/account binding, content review, and authorization remain host-owned.

  Outlook draft editing declares write access, preserves existing mailbox permission selection and immutable-ID headers, and retains the existing draft identity for recovery. Omitted fields remain unchanged and empty recipient arrays clear them. Update followed by send is not atomic or compare-and-swap. Neither operation retries automatically; uncertain sends require reconciliation before another attempt.

  Outlook direct reply declares destructive access and reuses the existing send-slot mailbox permission selection, mailbox guard, and immutable-ID headers. A required nonempty `to` array, required `cc` and `bcc` arrays that may be empty, `subject`, and the complete `body` travel in the single send request with text defaulting only in the outbound representation; no `comment`, `from`, quoted history, or draft round-trip is involved. Only HTTP 202 Accepted reports `{ accepted: true }`, meaning submission rather than delivery, with no message ID or exactly-once claim. Recognized rejections and ambiguous outcomes carry `underlying: { outcome: 'rejected' | 'unknown', retryable: false }` without retry hints or provider bodies.

- Updated dependencies [30f73f0]
  - @yolk-sdk/agent@0.1.0-canary.87

## 0.1.0-canary.86

### Patch Changes

- c8d74d8: Advance unchanged public packages in lockstep with action-backed interactions in the agent and harness packages. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [275d402]
  - @yolk-sdk/agent@0.1.0-canary.86

## 0.1.0-canary.85

### Minor Changes

- 5ea3b88: Add Gmail label create/get/update/delete plus starring, `outlook.move_message` and flagging plus Outlook master-category list/get/create/update/delete and message category assignment with required internet headers on get, plus required RFC 5322 headers on generic IMAP/POP3 get (breaking for existing `EmailClient` hosts that omit `headers`, now runtime-validated), optional host-backed IMAP keyword label mutations (`email.modify_labels`), flagging (`email.set_flag`), generic IMAP message relocation (`email.move`), and a pure `List-Unsubscribe` parser with spam-report and unsubscribe recipes. Preserve existing email adapters and document provider-specific permissions, non-atomic Outlook merges, destination UID remapping, and POP3/SMTP limitations.

### Patch Changes

- Updated dependencies [979db9e]
  - @yolk-sdk/agent@0.1.0-canary.85

## 0.1.0-canary.84

### Patch Changes

- Advance unchanged public packages in lockstep with the agent's normalized reasoning parsing fix for OpenAI-compatible chat completions. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [a627921]
  - @yolk-sdk/agent@0.1.0-canary.84

## 0.1.0-canary.83

### Patch Changes

- Advance unchanged public packages in lockstep with the agent's Vercel AI Gateway DeepSeek thinking-parameter fix. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [245e0b0]
  - @yolk-sdk/agent@0.1.0-canary.83

## 0.1.0-canary.82

### Patch Changes

- 0561764: Advance unchanged public packages in lockstep with typed input interactions and Vercel AI Gateway streaming/reasoning options. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [16fa58c]
- Updated dependencies [79a074a]
  - @yolk-sdk/agent@0.1.0-canary.82

## 0.1.0-canary.81

### Patch Changes

- 0cb0ec8: Fix Microsoft Outlook mailbox scope selection, reply-draft history preservation, and attachment listing compatibility.

  - Delegated access to an explicit `mailbox` now selects ordinary `Mail.Read` / `Mail.ReadWrite` / `Mail.Send` slots when the mailbox case-insensitively equals the resolved `OAuthCredential.accountId` (still addressed at `/users/{mailbox}`); Bearer credentials, missing account identity, or any mismatch keep `Mail.*.Shared` slots, and application-mode guards are unchanged. Explicit-mailbox delegated actions resolve identity through the scope-free `microsoft.oauth` binding slot before the enforcing operation slot.
  - `outlook.create_reply_draft` no longer posts a replacement `message.body`. It creates the reply draft without a body so Graph generates the quoted history, then PATCHes the draft with the supplied reply prepended (inside the generated HTML body element for HTML, newline-joined for text). If saving or reading back the generated body fails after creation, it retains sanitized `underlying: { draftId, retryable: false, recovery: 'read_edit_existing_draft' }` when the id is known, including typed transport/decode errors. Post-create HTTP failures use `outlook_create_reply_draft_partial` with the HTTP status but no `retryAfterMs`; read/edit the existing draft, never retry creation or delete it.
  - `outlook.list_attachments` selects only base attachment properties (`contentId` is a `fileAttachment`-derived property and is no longer selected across the polymorphic collection) and tolerates explicit null `lastModifiedDateTime` values in list and single-attachment responses.

- Updated dependencies [9f85933]
  - @yolk-sdk/agent@0.1.0-canary.81

## 0.1.0-canary.80

### Patch Changes

- Updated dependencies [82c3cad]
- Updated dependencies [df007e7]
- Updated dependencies [b3acb64]
  - @yolk-sdk/agent@0.1.0-canary.80

## 0.1.0-canary.79

### Minor Changes

- 746648a: Introduce selected branded identities while preserving string wire representations. This is a breaking pre-1.0 TypeScript API migration for hosts constructing the affected inputs or implementing adapters.

  - Knowledge scope/document references use `KnowledgeScopeId` and `KnowledgeDocumentId` from `@yolk-sdk/knowledge/documents`, including store, chunking, ingestion, and search contracts. Decode external/persisted IDs with their schemas; construct trusted constants with `.make`.
  - Harness Inbox/Driver lifecycle contracts distinguish `DrainToken` and `ParkGeneration` from `@yolk-sdk/harness/inbox`. Forward live returned values. These brands deliberately accept arbitrary strings and do not replace freshness, instance, or run-ownership checks.
  - Sandbox `normalizeWorkspaceCwd` returns `NormalizedWorkspaceCwd`, exported from the root. Raw command cwd inputs remain strings; normalization preserves directory-name whitespace and proves lexical shape only, not filesystem confinement.
  - Fortnox file discovery uses canonical `FortnoxGivenNumber` in both input and metadata; nonnumeric metadata is rejected. Invoice previews require `FortnoxDocumentNumber` and share invoice-read validation plus URL encoding rather than archive-ID restrictions. Archive IDs remain strings.
  - `defineAction` returns additive `TypedConnectorAction` with `executeTyped`, accepting and validating decoded input without replaying wire transforms, and retaining output types. Existing dynamic `execute`/`invoke` paths remain compatible. Implementations still validate external output data.

  Brands do not establish authorization or ownership. No database schema migration or agent-protocol ID changes are required.

### Patch Changes

- 3c243ee: Align all public SDK packages for the Go Responses replay fix and the branded-identity TypeScript migration. MCP and Vercel Workflows have no direct API or runtime changes in this release; they advance with the fixed SDK package group.
- Updated dependencies [3c243ee]
- Updated dependencies [2ab26c7]
  - @yolk-sdk/agent@0.1.0-canary.79

## 0.1.0-canary.78

### Minor Changes

- 5ff44d6: Upgrade the coordinated Effect runtime and platform dependencies to 4.0.0-rc.115. Hosts must use the matching Effect version.

  Adopt rc.115 schema-order construction, including `_tag` first: JSON field values and optional presence remain unchanged, but serialized property order can change. Schema errors now use the rc.115 native Error/SchemaIssue representation. Preserve strict Calendar boundary validation, closed empty tool schemas, portable custom JSON Schema output, and explicit WebSocket close semantics.

  Contributor property tests use native Effect arbitraries and Vitest 5. See the migration guide for API replacements and JSON Schema definition-name changes.

- 5ff44d6: `ConnectorIntegration` and `CredentialBinding` `metadata` is now `PortableMetadata`. Decode and `make` return a **snapshot copy** (null-prototype objects, new dense arrays; DAG aliases share snapshot nodes; input identity is not kept; snapshots are not frozen).

  Admitted data: own enumerable data keys (including `__proto__` / `constructor`), unknown extension keys, JSON `null` values, booleans, strings, finite numbers, nested plain/`null`-prototype objects, and dense arrays. Omitted metadata is absent.

  Rejected at every depth (no silent Date/Map/class→`{}`): root `null`/arrays/primitives, inherited or class prototypes, `Date`, `Map`, functions, `undefined` values, nonfinite numbers, cycles, sparse arrays, hidden/symbol keys, and accessor payload fields (getters are not invoked). `decodeUnknownEffect` fails with `SchemaError`; synchronous constructors/factories throw `Error` with a `SchemaIssue` cause. Proxy reflection traps are not covered by a general immunity claim.

  Integration `config` stays `Record<string, unknown>`. Credential secrets stay `credentialRef` + host `CredentialResolver`. Error `underlying` stays `unknown`. Hosts loading untrusted JSON should decode `PortableMetadata` (or the parent class).

### Patch Changes

- 5ff44d6: OpenAI Chat Completions and Responses admit `ToolDef.parameters` and tool-call `params` as `Schema.Json` before transport. Non-JSON fails non-retryable `LLMError` `provider_error`. `ToolDef.parameters` admits a `ToolJsonSchema` representation at construction; tool-call params and results stay opaque. Public Codex `OpenAiCodexTool.parameters` remains `unknown`. Inbound HTTP JSON and Responses SSE JSON admit `Schema.Json`; non-object SSE JSON is ignored, malformed non-JSON event text fails `invalid_response`, and HTTP error bodies stay raw text.

  `OpenAiProviderConfig.extraBody` now takes `OpenAiRequestExtras` JSON-object input, also used by Gateway. Request lowering snapshots surviving fields and discards canonical keys without reading their values. Surviving accessors and non-JSON values fail non-retryable `provider_error` with `Invalid … extraBody JSON: expected a JSON object`; getters are not invoked. Composed-body `Schema.Json` serialization after lone-surrogate rewriting remains the final finite-JSON defense.

  Public Realtime `OpenAiRealtimeFunctionTool.parameters` and `openAiRealtimeToolParameters` now require `Schema.Json`. Non-JSON advertisement fails `VoiceToolBridgeError` (sync throw / Effect fail). Mapper defects stay defects. Union-root lowering merges own `__proto__` / `constructor` via `Map`.

  Gmail `get_thread` / `list_attachments` MIME `payload` admits `Schema.Json` after JSON parse. Best-effort optional size omission and sibling preservation are unchanged. Raw HTTP `1e999` → `Infinity` rejects the whole payload (`ConnectorError` `validation_failed`). Public Gmail action classes and `gmail.get_attachment` are unchanged.

- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [00e4d60]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
  - @yolk-sdk/agent@0.1.0-canary.78

## 0.1.0-canary.77

### Patch Changes

- 6b9c60b: Release all seven public packages together.

  This canary introduces `@yolk-sdk/harness` run lifecycle and related agent loop composition, collection, Codex missing-final-output, and overflow-after-output changes. `@yolk-sdk/connectors`, `@yolk-sdk/knowledge`, `@yolk-sdk/mcp`, `@yolk-sdk/sandbox`, and `@yolk-sdk/vercel-workflows` are unchanged except for lockstep compatibility.

- Updated dependencies [978ea8f]
- Updated dependencies [978ea8f]
- Updated dependencies [7827908]
- Updated dependencies [6b9c60b]
  - @yolk-sdk/agent@0.1.0-canary.77

## 0.1.0-canary.76

### Patch Changes

- 8f5ea35: Add host-only retrieval for Google Drive download/export, Gmail, Outlook, IMAP/POP3, Notion, Telegram, Todoist attachments, Fortnox preview/archive, and R2 gets, plus bounded Dropbox/OneDrive writes and conditional R2 puts. Preserve GET-only binary adapters, base64 attachment actions, and R2 presigning. OneDrive update requires acknowledgeOverwrite and is unconditional, not CAS; Dropbox revision and R2 ETag preconditions stay strict. Add Fortnox list_supplier_invoice_files and Todoist list_comments read actions. Drive bytes default to drive.file with host-only drive.readonly opt-in; Fortnox archive/connectfile slots are opt-in and not added to the combined hint. No generic agent byte actions or app wiring.
- 34b4275: Add a host-only Dropbox original-byte download helper, `downloadDropboxFile`, on `@yolk-sdk/connectors/dropbox`. It mirrors the host-only OneDrive original-byte helper, but Dropbox never follows content redirects. It reuses the existing `dropbox.oauth` binding through a new `files.content.read` scope and `DropboxContentReadOAuthCredentialSlot` (now also included in `DropboxCombinedOAuthCredentialSlot`), calls the Dropbox content endpoint once through the optional bounded binary HTTP port, returns allowlisted `Dropbox-API-Result` metadata plus untouched bytes, and sanitizes failures to typed codes. Default Dropbox actions and agent serialization are unchanged. Hosts still implement connection-time network policy, streamed limits, and app-owned file materialization/read tools.
- Updated dependencies [8f5ea35]
- Updated dependencies [34b4275]
  - @yolk-sdk/agent@0.1.0-canary.76

## 0.1.0-canary.75

### Minor Changes

- 7f238d8: Add a host-only OneDrive/SharePoint original-byte download helper and an optional bounded binary HTTP port. Reuse existing Microsoft read credentials, resolve remote item identities, sanitize failures, and strip all original headers on download redirects. Default Microsoft actions and agent serialization are unchanged. Hosts still implement connection-time network policy, streamed limits, and app-owned file materialization/read tools.

### Patch Changes

- Updated dependencies [7f238d8]
  - @yolk-sdk/agent@0.1.0-canary.75

## 0.1.0-canary.74

### Patch Changes

- 20588d9: Keep package versions aligned with the agent's opt-in background tool execution and the
  Workflow child-observation updates. No additional implementation changes in these packages.
- Updated dependencies [79fe70b]
- Updated dependencies [79fe70b]
  - @yolk-sdk/agent@0.1.0-canary.74

## 0.1.0-canary.73

### Patch Changes

- 6672571: Add opt-in background subagent acknowledgements without premature child-completion events,
  public whole-batch HITL preflight, and generic bounded Workflow tool orchestration and durable
  child read/sleep seams. Preserve inline subagent compatibility and logical usage identity.
  The Next example wires independent foreground/background child workflows with owned durable
  reservations/results and tombstone-first explicit Stop cancellation.
- 2749df0: Add Effect-native `resolveMessageAttachmentSources` and `resolveMessagesAttachmentSources` protocol helpers. Traverse user, assistant, and tool-result media, including nested assistant provider tool results, while preserving metadata and ordering without mutation or caching. Document host-owned fresh signing inside provider retries, native PDF/image tool results, and bounded attachment transport.

  Validate Gmail discovery attachment sizes as nonnegative integers and omit malformed optional size metadata. Keep download limits, decoded-byte validation, authorization, storage, and extraction policy host-owned.

- Updated dependencies [6672571]
- Updated dependencies [2749df0]
  - @yolk-sdk/agent@0.1.0-canary.73

## 0.1.0-canary.72

### Patch Changes

- 79b6ff8: Align installation examples with the SDK's Effect version, correct Google connector tool wiring, document Outlook optional read inputs, and date previously released canary migrations.
- 9897531: Add `@yolk-sdk/connectors/fortnox` with nine read-only actions for company information and list/get customers, invoices, suppliers, and supplier invoices. Include typed schemas, pagination, resource-scoped OAuth credential hints, provider failure handling, and agent-tool access metadata. Hosts retain HTTP execution, OAuth lifecycle, credentials, and policy; Fortnox OAuth scopes themselves still grant read and write access.
- 782092d: Normalize null and blank optional inputs for Outlook message search and listing, including null page sizes, before execution. Direct connector callers and generated agent tools now share the compatibility behavior while preserving real cursors, input validation, application-mailbox guards, and provider failures.
- Updated dependencies [79b6ff8]
- Updated dependencies [9897531]
- Updated dependencies [782092d]
  - @yolk-sdk/agent@0.1.0-canary.72

## 0.1.0-canary.71

### Minor Changes

- 5967590: Add `outlook.set_read`, `outlook.trash`, and `outlook.untrash` actions through Microsoft Graph with mailbox-aware write permissions. Add matching generic email actions for IMAP through optional `EmailClient.setRead`, `trash`, and `untrash` host methods, preserving existing adapters and rejecting POP3 mutations. Restore defaults to the inbox or an explicit destination, not the original folder.

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.71

## 0.1.0-canary.70

### Patch Changes

- Updated dependencies [7c636c9]
  - @yolk-sdk/agent@0.1.0-canary.70

## 0.1.0-canary.69

### Patch Changes

- Updated dependencies [9747ec9]
  - @yolk-sdk/agent@0.1.0-canary.69

## 0.1.0-canary.68

### Minor Changes

- 4b3c984: Require Google Calendar event boundaries to contain exactly one non-empty date or date-time value, and expose strict non-null alternatives to agent tool providers.

### Patch Changes

- 73e7a9b: Refresh public guidance for durable user-message events, voice WebSocket wiring, Calendar event boundaries, and Workflow testing.
- Updated dependencies [73e7a9b]
  - @yolk-sdk/agent@0.1.0-canary.68

## 0.1.0-canary.67

### Patch Changes

- 57795cf: Add single-message Gmail attachment discovery and typed retrieval output with validated Gmail base64url data plus standard-base64 content while preserving existing wire fields.
- 57795cf: Add Outlook attachment metadata listing and file attachment retrieval through Microsoft Graph, including inline attachment discovery and shared-mailbox permission selection.
- 57795cf: Refresh public package descriptions, connector access guidance, and documented package subpaths.
- 57795cf: Add generic IMAP and POP3 attachment retrieval through an optional host email port method, returning decoded file bytes as base64 with normalized attachment metadata while preserving existing host adapters.
- Updated dependencies [0da67d1]
- Updated dependencies [57795cf]
  - @yolk-sdk/agent@0.1.0-canary.67

## 0.1.0-canary.66

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.66

## 0.1.0-canary.65

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.65

## 0.1.0-canary.64

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.64

## 0.1.0-canary.63

### Minor Changes

- 9085104: Add Google Drive metadata listing, search, lookup, folder creation, trash, and permanent deletion actions with action-scoped Google OAuth consent hints.

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.63

## 0.1.0-canary.62

### Patch Changes

- Updated dependencies [7677e18]
  - @yolk-sdk/agent@0.1.0-canary.62

## 0.1.0-canary.61

### Patch Changes

- Updated dependencies [025b16b]
- Updated dependencies [f495460]
  - @yolk-sdk/agent@0.1.0-canary.61

## 0.1.0-canary.60

### Patch Changes

- c4eea3f: Add a portable generic email connector with host-provided IMAP, POP3, and SMTP transport, normalized message schemas, IMAP draft creation, separate incoming and SMTP credential slots, and username/password runtime credentials.
- Updated dependencies [8ac2ad9]
  - @yolk-sdk/agent@0.1.0-canary.60

## 0.1.0-canary.59

### Minor Changes

- 3770fcd: Add the Dropbox OAuth connector with metadata, search, pagination, and file-management actions.
- 8c9ba43: Add a Microsoft Graph v1.0 connector with one shared `microsoft.oauth` credential binding, scoped Outlook and OneDrive OAuth slots, delegated/application Exchange and drive targeting, typed Outlook mail actions, and OneDrive list, search, metadata, folder-create, and recycle-bin actions. Connector actions can now declare default read, write, or destructive access metadata for agent adapters.

### Patch Changes

- a5581f7: Refresh public package documentation with verified imports, runtime boundaries, and host responsibilities.
- Updated dependencies [eb908b7]
- Updated dependencies [a5581f7]
  - @yolk-sdk/agent@0.1.0-canary.59

## 0.1.0-canary.58

### Patch Changes

- Updated dependencies [a4a3d52]
  - @yolk-sdk/agent@0.1.0-canary.58

## 0.1.0-canary.57

### Patch Changes

- da9e8ba: Refresh package documentation with runtime requirements, host responsibilities, subpath boundaries, and corrected usage examples.
- Updated dependencies [da9e8ba]
- Updated dependencies [de55946]
  - @yolk-sdk/agent@0.1.0-canary.57

## 0.1.0-canary.56

### Patch Changes

- Updated dependencies [2013d5e]
  - @yolk-sdk/agent@0.1.0-canary.56

## 0.1.0-canary.55

### Patch Changes

- Updated dependencies [6297363]
  - @yolk-sdk/agent@0.1.0-canary.55

## 0.1.0-canary.54

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.54

## 0.1.0-canary.53

### Patch Changes

- Updated dependencies [a47adb1]
  - @yolk-sdk/agent@0.1.0-canary.53

## 0.1.0-canary.52

### Patch Changes

- Updated dependencies [15d0159]
  - @yolk-sdk/agent@0.1.0-canary.52

## 0.1.0-canary.51

### Patch Changes

- d0f1744: Use Afloat's deployed `https://useafloat.com/mcp` endpoint for remote MCP connections.
  - @yolk-sdk/agent@0.1.0-canary.51

## 0.1.0-canary.50

### Minor Changes

- 123dabf: Add an official Afloat remote MCP connector contract with the canonical endpoint, required MCP protocol version, API-key credential slot, and server-side auth-data action.

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.50

## 0.1.0-canary.49

### Patch Changes

- 9b50918: Resolve Figma refresh tokens and OAuth client secrets through host runtime credentials instead of integration config.
- b1f81eb: Keep Gmail attachment content out of normalized thread bodies and tolerate malformed body encoding.
  - @yolk-sdk/agent@0.1.0-canary.49

## 0.1.0-canary.48

### Patch Changes

- 300d4ef: Clarify that Gmail thread tools return normalized output and require `full` for decoded bodies.
- Updated dependencies [6cfc7fb]
  - @yolk-sdk/agent@0.1.0-canary.48

## 0.1.0-canary.47

### Patch Changes

- Updated dependencies [b0576d3]
  - @yolk-sdk/agent@0.1.0-canary.47

## 0.1.0-canary.46

### Patch Changes

- Classify Anthropic context overflow, support tokenizer-backed compaction estimates, and return
  normalized Gmail threads without raw MIME or attachment bytes.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.46

## 0.1.0-canary.45

### Patch Changes

- Updated dependencies [d8c0b7a]
  - @yolk-sdk/agent@0.1.0-canary.45

## 0.1.0-canary.44

### Patch Changes

- Updated dependencies [607255e]
  - @yolk-sdk/agent@0.1.0-canary.44

## 0.1.0-canary.43

### Patch Changes

- Updated dependencies [5c53852]
  - @yolk-sdk/agent@0.1.0-canary.43

## 0.1.0-canary.42

### Patch Changes

- Add compaction checkpoint formatting and one-shot context-overflow retry helpers.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.42

## 0.1.0-canary.41

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.41

## 0.1.0-canary.40

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.40

## 0.1.0-canary.39

### Patch Changes

- Expose Effect-native attachment and durable workflow helpers, and refresh package documentation for current public exports.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.39

## 0.1.0-canary.38

### Patch Changes

- Harden agent transport and voice Effect boundaries.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.38

## 0.1.0-canary.37

### Patch Changes

- Publish canary with agent client stream continuation fixes and package docs updates.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.37

## 0.1.0-canary.36

### Patch Changes

- Updated dependencies [afb30a0]
  - @yolk-sdk/agent@0.1.0-canary.36

## 0.1.0-canary.35

### Patch Changes

- Updated dependencies [e9d235d]
- Updated dependencies [26b8b4d]
  - @yolk-sdk/agent@0.1.0-canary.35

## 0.1.0-canary.34

### Patch Changes

- Updated dependencies [01719c0]
  - @yolk-sdk/agent@0.1.0-canary.34

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

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.33

## 0.1.0-canary.32

### Patch Changes

- Add Effect-native Vercel Workflow host wrappers and refresh package documentation.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.32

## 0.1.0-canary.31

### Patch Changes

- Simplify knowledge to document, file, chunk, context, and search contracts.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.31

## 0.1.0-canary.30

### Patch Changes

- Updated dependencies [4148be9]
  - @yolk-sdk/agent@0.1.0-canary.30

## 0.1.0-canary.29

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.29

## 0.1.0-canary.28

### Patch Changes

- Updated dependencies [90b0558]
  - @yolk-sdk/agent@0.1.0-canary.28

## 0.1.0-canary.27

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.27

## 0.1.0-canary.26

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.26

## 0.1.0-canary.25

### Patch Changes

- Fix connector provider pagination, Google scoped OAuth, Gmail drafts/send-as, LinkedIn queued email lookup, and R2 public URL handling.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.25

## 0.1.0-canary.24

### Patch Changes

- Add Gmail send-as alias support for draft actions.
  - @yolk-sdk/agent@0.1.0-canary.24

## 0.1.0-canary.23

### Patch Changes

- Updated dependencies [e8ac8ce]
  - @yolk-sdk/agent@0.1.0-canary.23

## 0.1.0-canary.22

### Patch Changes

- Updated dependencies [378cd92]
  - @yolk-sdk/agent@0.1.0-canary.22

## 0.1.0-canary.21

### Patch Changes

- Surface typed provider failure metadata, retry state, and retry-aware chat items.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.21

## 0.1.0-canary.20

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.20

## 0.1.0-canary.19

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.19

## 0.1.0-canary.18

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.18

## 0.1.0-canary.17

### Patch Changes

- 92d966b: Expose structured model-visible tool error details.
- Updated dependencies [92d966b]
- Updated dependencies [6a6d7a6]
  - @yolk-sdk/agent@0.1.0-canary.17

## 0.1.0-canary.16

### Patch Changes

- Updated dependencies [ca545a6]
  - @yolk-sdk/agent@0.1.0-canary.16

## 0.1.0-canary.15

### Minor Changes

- Unify public package shape around `@yolk-sdk/agent` subpaths, fold React/OAuth/provider/skillset/voice APIs into the agent package, and rename Vercel Workflow imports to `@yolk-sdk/vercel-workflows`.

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.15

## 0.1.0-canary.14

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.14

## 0.1.0-canary.13

### Minor Changes

- Add model-visible message envelopes with timestamps, author display names, and annotations.

### Patch Changes

- Updated dependencies
- Updated dependencies [3797339]
  - @yolk-sdk/agent@0.1.0-canary.13

## 0.0.1-canary.12

### Patch Changes

- Updated dependencies [b5a297a]
  - @yolk-sdk/agent@0.0.1-canary.12

## 0.0.1-canary.11

### Patch Changes

- Updated dependencies [0c7ed24]
  - @yolk-sdk/agent@0.0.1-canary.11

## 0.0.1-canary.10

### Patch Changes

- @yolk-sdk/agent@0.0.1-canary.10

## 0.0.1-canary.9

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.0.1-canary.9

## 0.0.1-canary.8

### Patch Changes

- Updated dependencies [76d5c21]
  - @yolk-sdk/agent@0.0.1-canary.8

## 0.0.1-canary.7

### Patch Changes

- @yolk-sdk/agent@0.0.1-canary.7

## 0.0.1-canary.6

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.0.1-canary.6

## 0.0.1-canary.5

### Patch Changes

- @yolk-sdk/agent@0.0.1-canary.5

## 0.0.1-canary.4

### Patch Changes

- Updated dependencies [992ae2c]
  - @yolk-sdk/agent@0.0.1-canary.4

## 0.0.1-canary.3

### Patch Changes

- @yolk-sdk/agent@0.0.1-canary.3

## 0.0.1-canary.2

### Patch Changes

- 55bc6c7: Prepare next canary release.
- Updated dependencies [55bc6c7]
  - @yolk-sdk/agent@0.0.1-canary.2

## 0.0.1-canary.1

### Patch Changes

- Prepare next canary release.
- Updated dependencies
  - @yolk-sdk/agent@0.0.1-canary.1

## 0.0.1-canary.0

### Patch Changes

- 4232c86: Prepare first public canary release.
- Updated dependencies [4232c86]
  - @yolk-sdk/agent@0.0.1-canary.0
