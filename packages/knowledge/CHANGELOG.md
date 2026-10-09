# @yolk-sdk/knowledge

## 0.1.0-canary.105

### Patch Changes

- c1b73d3: Advance unchanged public packages in lockstep with Gmail draft attachments in `@yolk-sdk/connectors` (optional `attachments` on `gmail.draft_compose`, `gmail.draft_update`, and `gmail.draft_reply`) and the matching `@yolk-sdk/emulators` README note: the Google emulator does not emulate the Gmail draft media upload, so a draft with attachments answers its unrecognised 400. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [c1b73d3]
  - @yolk-sdk/agent@0.1.0-canary.105

## 0.1.0-canary.104

### Patch Changes

- 31b7e48: Advance unchanged public packages in lockstep with tool change previews in `@yolk-sdk/agent` (one before → after preview for approval-gated calls, shown on direct approvals and staged plan reviews). These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [d5d557e]
  - @yolk-sdk/agent@0.1.0-canary.104

## 0.1.0-canary.103

### Patch Changes

- 1d51430: Advance unchanged public packages in lockstep with staged tool plans in `@yolk-sdk/agent` and `@yolk-sdk/codemode` (code mode scripts stage approval-gated tool calls that a person reviews once before they are applied). These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
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

### Patch Changes

- ee80a4a: Advance unchanged public packages in lockstep with the durable tool-call ledger in `@yolk-sdk/agent` and `@yolk-sdk/codemode`, the at-least-once tool step guidance in `@yolk-sdk/vercel-workflows`, and the README updates in `@yolk-sdk/extractors`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [c248eb0]
  - @yolk-sdk/agent@0.1.0-canary.99

## 0.1.0-canary.98

### Patch Changes

- def9f9c: Advance unchanged public packages in lockstep with the new `@yolk-sdk/extractors` package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [def9f9c]
  - @yolk-sdk/agent@0.1.0-canary.98

## 0.1.0-canary.97

### Minor Changes

- b5c2b69: Upgrade the coordinated Effect runtime and platform dependencies to the stable Effect 4.0.0 release. Hosts must use the matching Effect version.

  Effect 4.0.0 removes the `effect/unstable/*` entrypoints: import from `effect/http`, `effect/socket`, `effect/sql`, `effect/process` and the other `effect/<area>` paths, and take `Arbitrary` from `effect`. The former `effect/Encoding` module is split into `effect/encoding/*` (for example `Base64.encode` from `effect/encoding/Base64`).

  Effect 4.0.0 exports `Schema.isPattern` to JSON Schema only when the regex flags are `u` (optionally with `d`, `g` or `y`; not `v`, and not `u` with `i`, `m` or `s`). Yolk's connector, emulator and conformance patterns now use `u`, so connector tool parameters keep their model-visible `pattern` hints with unchanged runtime validation; the Fortnox identifier pattern is advertised as its equivalent BMP-only character class. Add `u` to `Schema.isPattern` regexes in host tool parameter schemas to keep their patterns. String `Schema.isMinLength(n)` and the `Schema.isBetweenLength` minimum (n ≥ 2) are now advertised as `minLength: ceil(n / 2)`. See the migration guide.

- bdb29d0: `makeKnowledgeLookupTool` and `makeKnowledgeManageTool` declare output schemas (`KnowledgeLookupOutput`, `KnowledgeManageOutput`, exported from `@yolk-sdk/knowledge/agent`) and return their JSON encoding as `structuredContent`, so code mode scripts get structured values: `{ operation: 'search', results: Array<{ document, score?, context? }> }`, `{ operation: 'get', document }` (document dates as ISO strings), and `{ operation, document: { id, slug, title } }`. The text content is unchanged. A handler value that does not encode fails the call with an `execution` `ToolError`.
- 4f24fe8: Accept tool arguments exactly as advertised: `null` for optional fields is accepted, and unknown keys are rejected. `ToolDef.parameters` describes the schema's canonical JSON codec, which advertises every `Schema.optional(X)` field as `X | null` and every object as closed (`additionalProperties: false`), but `makeTool` decoded calls with the type-side schema: it rejected the advertised `null`, so models (especially strict-mode providers) failed validation on unused optional fields, and it silently stripped unknown keys.

  `makeTool` (`validate` and `execute`, so background calls too), `makeInputTool`/`makeInteractionTool` call parameters, and the loop-owned `question` decode now use `Schema.toCodecJson(parameters)`. `null` on `Schema.optional(X)` decodes as omitted and `Schema.withDecodingDefault` still applies; `Schema.optional(Schema.NullOr(X))` keeps `null`; required non-nullable fields still reject it with a model-visible validation error. Non-finite numbers, which the JSON codec decodes from `"NaN"`/`"Infinity"`/`"-Infinity"`, remain validation errors. `undefined`-valued keys from in-process callers count as absent. Advertised schemas are unchanged.

  Breaking (0.x minor): unknown keys at any depth are now model-visible validation errors (`onExcessProperty: 'error'`) instead of being silently stripped, so a model never believes it set a field (a filter, a start time) that was ignored. This also selects the union member that declares every sent key and keeps closed-input declarations closed through the JSON codec. Callers or fixtures that sent extra keys now get a validation error. Argument errors (the default `makeTool` message, interaction/input/`question` errors, and Yolk's own tool overrides) report every issue at once and name each unknown key with the allowed keys at that path; the new `withToolArgumentsErrorHint` export lets custom `invalidParamsMessage` callbacks do the same.

  `resolveTools` also drops `null` where the advertised schema marks a property optional without admitting `null` (`Schema.optionalKey(X)`, the subagent `model`/`reasoning_effort`, raw MCP schemas) before any registration validates, executes, or forwards the call. The new `omitNullOptionalToolArguments` export on `@yolk-sdk/agent/tools` exposes that step for hosts that dispatch registrations themselves. User-submitted input/interaction responses keep strict decoding.

  Connector agent tools (`makeConnectorToolModule`) follow the same policy: unknown keys are rejected instead of stripped. For example, `outlook.list_messages` rejects the search-only `query`, and Fortnox invoice update tools reject provider-managed fields such as `Booked` or `Sent`. `execute` and `executeTyped` are unchanged.

  The knowledge (`knowledge_lookup`, `knowledge_manage`) and sandbox agent tools follow the same policy: unknown keys are rejected with a hint instead of being stripped.

### Patch Changes

- Updated dependencies [b5c2b69]
- Updated dependencies [4f24fe8]
  - @yolk-sdk/agent@0.1.0-canary.97

## 0.1.0-canary.96

### Patch Changes

- 23c322c: Advance unchanged public packages in lockstep with the new `@yolk-sdk/codemode` package, the new experimental `@yolk-sdk/conformance` and `@yolk-sdk/emulators` packages, classifier models and the code mode tool contract in `@yolk-sdk/agent`, and the new conformance subpaths in `@yolk-sdk/agent`, `@yolk-sdk/connectors`, and `@yolk-sdk/mcp`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
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

## 0.1.0-canary.95

### Patch Changes

- 8d919b4: Advance unchanged public packages in lockstep with Gmail multipart sending and host-only Outlook draft attachment uploads in the connectors package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [8d919b4]
  - @yolk-sdk/agent@0.1.0-canary.95

## 0.1.0-canary.94

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.94

## 0.1.0-canary.93

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.93

## 0.1.0-canary.92

### Patch Changes

- 7bc4f70: Advance unchanged public packages in lockstep with the new GitHub connector at `@yolk-sdk/connectors/github`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [7bc4f70]
  - @yolk-sdk/agent@0.1.0-canary.92

## 0.1.0-canary.91

### Patch Changes

- bd61ed3: Advance unchanged public packages in lockstep with OpenAI-compatible tool-result attachment lowering and connector email Sent-copy plus OneDrive move and copy actions. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [b9c5610]
  - @yolk-sdk/agent@0.1.0-canary.91

## 0.1.0-canary.90

### Patch Changes

- 76d6c5c: Advance unchanged public packages in lockstep with native PDF attachment lowering in the agent package and Fortnox customer and invoice writes in the connectors package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [6c7efcb]
  - @yolk-sdk/agent@0.1.0-canary.90

## 0.1.0-canary.89

### Patch Changes

- 7eab996: Advance unchanged public packages in lockstep with the host-neutral background subagent guidance in the agent package and the Dropbox create-folder response fix in the connectors package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [4188847]
  - @yolk-sdk/agent@0.1.0-canary.89

## 0.1.0-canary.88

### Patch Changes

- 879f27b: Advance unchanged public packages in lockstep with the portable email batch, filter, and permanent-deletion primitives in the connectors package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [879f27b]
  - @yolk-sdk/agent@0.1.0-canary.88

## 0.1.0-canary.87

### Patch Changes

- 30f73f0: Advance unchanged public packages in lockstep with the reviewed-email submission primitives in the connectors package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [30f73f0]
  - @yolk-sdk/agent@0.1.0-canary.87

## 0.1.0-canary.86

### Patch Changes

- c8d74d8: Advance unchanged public packages in lockstep with action-backed interactions in the agent and harness packages. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [275d402]
  - @yolk-sdk/agent@0.1.0-canary.86

## 0.1.0-canary.85

### Patch Changes

- 979db9e: Advance unchanged public packages in lockstep with the generic-email label, flag, move, and header additions. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
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

- 0fae398: Advance the unchanged public packages in lockstep with the agent chat-stream diagnostics and Microsoft Outlook connector fixes. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
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

- 5ff44d6: Export canonical tagged constructors on existing subpaths: `PlainHitlResponse` and `RuntimeRequest` values, React chat ADTs, harness inbox/outcome/`StopDecision` companions, knowledge source/scope `.make`, and workflow `WorkflowStepResult` / `VercelAgentWorkflowRunResult`.

  `Data.taggedEnum` values are plain objects with `_tag` last, not Equal/Hash classes. Prefer constructors over handwritten `{ _tag }` objects and omit absent optionals.

- 5ff44d6: Upgrade the coordinated Effect runtime and platform dependencies to 4.0.0-rc.115. Hosts must use the matching Effect version.

  Adopt rc.115 schema-order construction, including `_tag` first: JSON field values and optional presence remain unchanged, but serialized property order can change. Schema errors now use the rc.115 native Error/SchemaIssue representation. Preserve strict Calendar boundary validation, closed empty tool schemas, portable custom JSON Schema output, and explicit WebSocket close semantics.

  Contributor property tests use native Effect arbitraries and Vitest 5. See the migration guide for API replacements and JSON Schema definition-name changes.

### Patch Changes

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

### Patch Changes

- 73e7a9b: Refresh public guidance for durable user-message events, voice WebSocket wiring, Calendar event boundaries, and Workflow testing.
- Updated dependencies [73e7a9b]
  - @yolk-sdk/agent@0.1.0-canary.68

## 0.1.0-canary.67

### Patch Changes

- 57795cf: Refresh public package descriptions, connector access guidance, and documented package subpaths.
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

- Updated dependencies [8ac2ad9]
  - @yolk-sdk/agent@0.1.0-canary.60

## 0.1.0-canary.59

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

- @yolk-sdk/agent@0.1.0-canary.51

## 0.1.0-canary.50

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.50

## 0.1.0-canary.49

### Patch Changes

- 9b50918: Reject empty multi-scope searches and invalid lookup limit/context counts at schema boundaries.
  - @yolk-sdk/agent@0.1.0-canary.49

## 0.1.0-canary.48

### Patch Changes

- Updated dependencies [6cfc7fb]
  - @yolk-sdk/agent@0.1.0-canary.48

## 0.1.0-canary.47

### Patch Changes

- Updated dependencies [b0576d3]
  - @yolk-sdk/agent@0.1.0-canary.47

## 0.1.0-canary.46

### Patch Changes

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

- Rename the archived knowledge policy.
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
