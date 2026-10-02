# @yolk-sdk/connectors

## 0.1.0-canary.96

### Patch Changes

- 367aceb: Add the code mode tool contract (ADR 0002, step 1) without adding code mode itself.

  - Output schemas: `makeTool({ output })` lowers an Effect Schema into declaration-only
    `ToolDef.outputSchema` the same way as `parameters`. Connector tool registrations pass the action
    `outputSchema` through, and `mcpToolToToolDef` passes a plain-object MCP `outputSchema` through.
    Output schemas are never sent to providers and never validate results.
  - Exposure: `ToolDef.callableBy` (`all` default, `model`, `codemode`) and, for `codemode` only,
    `discovery` (`listed` default, `search`), typed on `makeTool` options as the `ToolExposure`
    union. Protocol helpers `isCodeModeCallable`, `isCodeModeFailClosed`, `providerToolDefs`,
    `isProviderToolDef`, and `toolDiscovery` implement the rules. Approval, input, interaction,
    activated background, `question`, and `subagent` tools never run from code mode; `resolveTools`
    fails `codemode_unsupported_tool` when they are marked `codemode` and `invalid_tool_exposure` for
    `discovery` without `codemode`, and warns when codemode-only tools have no nested-access tool.
  - Exposure for generated tools: `makeConnectorToolRegistration` and `makeConnectorToolModule`
    accept `exposure`, a `ToolExposure` value or a resolver `(actionId, action) => ToolExposure`
    (`ConnectorToolExposureResolver`; `action` is the declared `id`/`description`/`access`, or
    `undefined` for an undeclared action id). `mcpToolToToolDef` and the MCP listing functions
    (`McpClientOptions.exposure`) accept the same option as `McpToolExposureResolver`, a value or
    `(tool, serverName) => ToolExposure`. Without it neither adapter sets `callableBy`/`discovery`;
    the fail-closed rules above still apply at resolution.
  - Codemode-only tools never reach providers: `run`, `runModelTurn`, capability checks, and the
    OpenAI Realtime session builders omit them. Provider-issued calls to them fail closed as unknown
    tools (`prepareToolBatch` synthetic error result, `ResolvedToolSet.execute` `not_found`, voice
    denial) without dispatch.
  - Nested tool access: registrations with `nestedToolAccess: true` receive a `nested`
    `NestedToolExecutor` scoped to the same resolution and host context. Its `tools` list the
    code-mode-callable tools (excluding nested-access registrations) with their module ids; its
    `execute` runs through the resolved execute path and returns model-visible error results for
    unknown, disabled, or non-callable tools and tool failures. Nested call ids follow
    `<parentToolCallId>/<seq>`. Decorators outside `ResolvedToolSet.execute` (for example a wrapped
    `ToolExecutor`) do not see nested calls.
  - Module descriptions: `ToolModule` accepts an optional `description`, carried on `NestedTool` as
    `moduleDescription` for code mode listing and search.
  - Nested-call record: optional `ToolResult.nestedCalls` (`NestedToolCalls`) and summed
    `ToolResult.usage`, built with `recordNestedToolCall` / `nestedToolCallResultFields` within
    exported bounds (256 calls, 8 KiB arguments per call, 32 KiB in total, 500-character errors).
    They round-trip as plain JSON and are dropped by `toolResultMessageFromResult`, so transcripts
    and providers never see them.

- 9ae886c: The Microsoft and Notion conformance cases now classify a failed create of their own item with the shared write classification: an HTTP 408 is ambiguous (the item may exist, so the failure carries the manual-recovery advice), like a transport or decoding failure, no status, or a 5xx; any other 4xx stays a definitive rejection.
- d68d42d: Add the experimental `@yolk-sdk/connectors/dropbox/conformance` and `@yolk-sdk/connectors/notion/conformance` subpaths. Dropbox: eight cases (list folder and search cursor paging, case-insensitive path lookups with `path_lower`, the HTTP 409 `path/not_found` error envelope, folder create conflicts, delete then not-found, single-item copy/move metadata, and the upload rev precondition) with `DropboxConformanceConfig` seeds. Write cases work only inside an invocation-unique `yolk-conformance-<runId>-*` folder (the live runner generates a fresh run id each time): a definitive create rejection deletes nothing, an ambiguous create is reported with the exact path to check by hand, successful creates are cleaned up by id and verified, and a create answering a path outside the case folder is never deleted. Run ids must start with `run-` so leftover detection covers every run. Add `ConformanceCleanupReporter` to `@yolk-sdk/connectors/conformance`: write cases hand it a cleanup failure or unknown-outcome create raised while being interrupted, which the interruption could otherwise hide. The live runners turn the first SIGINT/SIGTERM into an interruption that attempts the cleanup (ignoring duplicate signals from one keypress), print such problems as WARN lines, and warn read-only about leftovers before the run and after an interruption (`findDropboxConformanceLeftovers`, `findNotionConformanceLeftovers`). Notion: eight cases (search, block children, and page property cursor paging including the second percent-encoding of property ids, the pinned `Notion-Version`, the error envelope, title rich text, the 2025-09-03 database/data source split, and archiving a page) with `NotionConformanceConfig` seed ids and a self-cleaning write case. Both ship synthetic replay fixtures; no case is observed live yet.
- a4ba6db: Add `PortFixture` to the experimental `@yolk-sdk/conformance/fixture` subpath: one recorded call through a host port that is not HTTP (`id`, `port`, `method`, a credential-free JSON `request`, exactly one of `response` or `failure`, optional `observed`), with `decodePortFixture`, `redactPortPayload`, `scanPortFixtureForSecrets`, and `conformanceFixtureEvidence`. The runner's `fixtures` option accepts port fixtures next to `WireFixture`s; `WireFixture` and HTTP replay are unchanged. Add the experimental `@yolk-sdk/connectors/email/conformance` subpath: ten port-level cases for the generic `EmailClient` (required headers without marking read, filtered listing without fallback, `\Drafts` discovery, `set_read`/`set_flag`, trash and untrash to INBOX, destination ids after a move with the stale source id answering the documented `message_not_found` failure code, POP3 rejections of every mutation action, Sent-copy statuses including the legacy synthesis, and SMTP acceptance that is not delivery), `EmailConformanceConfig` seeds, synthetic port fixtures, `makeEmailReplayBackend`, and `emailClientLayerFromBackend`, a testing-only bridge from a plain-JSON backend to `EmailClient`. Add the experimental `@yolk-sdk/emulators/email` subpath: `makeEmailEmulator`, a fixture-driven in-memory fake `EmailClient` backend (no socket, TLS, MIME, or mail library) with a mailbox seed, ledger, faults (applied only to calls a state-consistent fixture would answer), reset, coverage, and an unverified route manifest; anything the fixtures do not cover fails closed, and the only request-shape latitude is ignoring credentials and `connection.host`. Yolk still never speaks IMAP or SMTP; live verification needs a host `EmailClient` implementation.
- c40cc6f: Add the experimental, Node-only `@yolk-sdk/emulators/github` subpath: `makeGithubEmulator`, a stateful emulator on the pinned `@emulators/core` custom runtime (loaded lazily) that follows the fixture-only rule. It serves exactly the GitHub REST routes the seven GitHub conformance cases send, on the recorded origin `https://api.github.com`: the label listing with the paging fixture's `Link` header (minted in its exact form; a listing that fits one page carries none), issue read (the recorded 404 for a number the repository has not reached), the issue search the validation fixture refuses (the recorded 422), file contents (base64 folded every 60 characters), comment create, listing `since`, and delete (then the recorded 404), issue label add and remove (the recorded 404 for a label not on the issue), and issue create, rename, and close as completed. It is seeded by default with the synthetic fixture entities, so the cases run unmodified; error bodies are the fixtures' byte for byte (`githubEmulatorErrorBodies`); created issue numbers and comment ids come from counters that only advance and start at the fixtures' created values. Anything the fixtures do not record answers a ledgered 400 not-emulated before anything is written or any fault is chosen, including the leftover lookup's open-issue listing (so `findGithubConformanceLeftovers` fails closed against it). It fails closed: a request is recognised only when its raw path is exactly an emulated route shape and any `Authorization` header is one recognisable bearer; every other request is ledgered and answered with constant text only. The bearer value is never stored, forwarded, ledgered, or echoed, and a path, query, or body that repeats it is refused. It adds status faults (400-599), clock-free error recovery, an `/_emulate/*` control plane, test-only drill knobs, and a route evidence manifest (`githubEmulatorRoutes`, all routes unverified; the six write routes are pending evidence until an owner-approved live run). The shared stateful wrapper gains an opt-in fail-closed mode (a bearer must match the RFC 6750 `b64token` syntax, start with a character that completes no escape, and hold a character outside the JSON-number alphabet `[0-9.eE+-]`, and a request that repeats it in its path, query, recorded headers, or body, found through the fixpoint closure of total, lexical percent-decoding and JSON-unescaping (a closure that hits its work cap counts as a repeat), is ledgered with constant text only), raw path-parameter patterns matched in full, multi-segment `{name+}` parameters, and constant-reason shape checks (`exactBodyKeys`, `exactQuery`); Dropbox and Notion are unchanged.

  Fix: consistent synthetic GitHub fixtures. The `github.labels.add-remove` fixture's repository label listing (`per_page=100`) now answers the same five labels as the `github.labels.list-link-paging` fixture, so one repository state answers every GitHub fixture.

- abaa7fd: Add the experimental, Node-only `@yolk-sdk/emulators/todoist` and `@yolk-sdk/emulators/telegram` subpaths: `makeTodoistEmulator` and `makeTelegramEmulator`, stateful emulators on the pinned `@emulators/core` custom runtime (loaded lazily) that follow the fixture-only rule. Todoist serves the API v1 routes the Todoist conformance cases and their cleanup use (task listing with REST v1 cursor paging, task create/read/update/close, label listing, project create/read/delete with run-scoped `yolk-conformance-run-*` case projects; the leftover lookup's project listing has no fixture, so it answers 400 not-emulated and the lookup fails closed); Telegram serves `getChat`, `getFile`, the hosted file download, and `sendMessage` (recorded in its state, never delivered). Both are seeded by default with the synthetic fixture entities so the conformance cases run unmodified; anything the fixtures do not record answers a ledgered 400 not-emulated (nothing is synthesised: seeded Todoist projects are never answered, and only items created through the recorded create flow are written), the request and state are checked before any fault is chosen (a refused request never uses a fault), and the documented request-shape latitude is the only accepted deviation. Created Todoist ids use a reserved `6XEmu` prefix that seeds may not use. Both fail closed: a request is recognised only when its raw path is exactly an emulated route shape (and, for Todoist, any `Authorization` header is one recognisable bearer), and every other request is ledgered and answered with constant text only (`/<unrecognised>`, no query or body, a constant reason). The Telegram bot token travels in the URL path: it is required but never stored, forwarded, ledgered, or echoed (for a recognised request it is taken from its exact path segment, the token and its secret part are scrubbed from the ledger and every refusal, and a query, path, or body that repeats them, JSON-escaped strings and normalised numbers included, is refused); the Todoist bearer value is guarded the same way. Both add status faults (400-599), a credential-free ledger, clock-free error recovery, an `/_emulate/*` control plane, test-only drill knobs, and route evidence manifests (`todoistEmulatorRoutes`, `telegramEmulatorRoutes`) linked to the conformance case ids (all routes unverified).

  Fix: consistent synthetic Todoist fixtures. The `todoist.labels.task-labels-are-names` fixture now answers the labeled task in the work project (`6XSyntheticWork0`), since the paging fixture's listing of the paging project never includes it.

- 9ca449c: Add experimental connector conformance subpaths. `@yolk-sdk/connectors/conformance` bridges an Effect `HttpClient` to `ConnectorHttpClient` and `ConnectorBinaryHttpClient` and adds `staticCredentialResolverLayer`, for conformance and tests only (no streamed byte limits, redirect, or DNS policy; not a production adapter). `@yolk-sdk/connectors/fortnox/conformance` adds seven Fortnox conformance cases (invoice list decoding, preview PDF, payment filters excluding unbooked invoices, sticky row discounts, empty strings not clearing customer fields, rejected-write `ErrorInformation`, and a manual-only invoice email send) with `FortnoxConformanceConfig` seed identities, exact restore-and-verify for the row and customer mutation cases, an absence check before the rejection case writes, a recipient check before the email case sends, and synthetic replay fixtures. `@yolk-sdk/connectors` now depends on `@yolk-sdk/conformance`, which only its conformance subpaths import.
- f3660d5: Report Fortnox and Microsoft conformance cleanup problems raised during an interruption through `ConformanceCleanupReporter`, as the Dropbox, Notion, Todoist, and Telegram cases already do. Failed restores in the Fortnox row/customer mutation cases, and failed removals, id-less creates, and ambiguous (`createOutcome: 'unknown'`) creates in the Microsoft write cases, now hand their message to the reporter when the case fiber is interrupted or an interruption is pending, then fail exactly as before; a Microsoft ambiguous create is reported with its case id in front. Uninterrupted failures, definitive create rejections, the Fortnox rejection case, and the Fortnox email send are not reported.
- 575a282: Add the experimental `@yolk-sdk/connectors/github/conformance` and `@yolk-sdk/connectors/r2-storage/conformance` subpaths. GitHub: seven cases (label list paging through `Link` `rel="next"`, the not-found and validation error envelopes the connector maps, base64 file contents decoding to exactly `size` UTF-8 bytes, a comment created and deleted by id, a label added to and removed from a seeded work issue (both write-reversible; their notification and timeline residue is documented, and the work issue must be a practice issue nobody else watches), and the issue create/get/update/close lifecycle) with `GithubConformanceConfig` seeds. Every write names an invocation-unique run id or touches only the seeded work issue and label; the create, its decoding, and its registration are masked together; a definitive rejection undoes nothing; an ambiguous write is reported with the exact item to check by hand; an answer outside the run namespace is never adopted; cleanups undo by id and verify. The issue lifecycle case is write-irreversible (GitHub issues cannot be deleted through the REST API, so the closed issue stays) and runs only when requested by its exact id. `findGithubConformanceLeftovers` lists leftovers read-only. R2: six port-level cases over the host `R2Presigner` and `R2ObjectClient` (the presigned PUT URL for the bucket and key with SigV4 parameters, a credential for the access key id the connector passed, an expiry within the SigV4 limit, and the signed content type; `maxBytes` and `expectedEtag` on get; a missing key; an absent-only create; an `If-Match` update) with `R2ConformanceConfig` seeds, synthetic `PortFixture`s, and a plain-JSON bridge (`r2PortsLayerFromBackend`, `makeR2ReplayBackend`) that never hands the credentials to a backend. Both R2 write cases are write-irreversible (the connector cannot delete R2 objects). Presigned URLs in fixtures carry only synthetic credential placeholders: next to the shared `scanPortFixtureForSecrets`, the fail-closed `findR2PortFixtureSecrets` blanks out only the canonical placeholder occurrences (a raw `X-Amz-Signature` or `X-Amz-Credential` name with exactly the written placeholder value) and refuses any `X-Amz-Signature`, `X-Amz-Credential`, or `X-Amz-Security-Token` name left in the text or in any variant reachable with up to three percent-decoding and three escape-decoding rounds (JSON, `\x`, and numeric HTML escapes) in any order, encoded or escaped names and prose included, and `scrubR2PortFixture` rewrites them (not escaped URLs). No case is observed live yet.
- 8a54702: Fix `gmail.draft_delete`: Gmail answers a draft delete with HTTP 204 and an empty body, which the action used to JSON-decode, so every successful delete failed with `validation_failed` ("Invalid JSON response"). It now treats any 2xx as success without reading the body and returns `{ id, deleted: true }`, like `gmail.delete_label`; non-2xx answers still map to provider failures. The other Google actions whose endpoints answer an empty body (`gmail.delete_label`, `gmail.delete_permanently`, `calendar.delete_event`, `drive.delete_file`) already never decode it.
- 8a54702: Add the experimental `@yolk-sdk/connectors/google/conformance` subpath: thirteen Gmail, Calendar, and Drive conformance cases (`googleConformanceCases`) with `GoogleConformanceConfig` seeds and synthetic replay fixtures. Gmail: `gmail.list` paging through `nextPageToken` to the same messages as one large page, base64url attachment data of exactly `size` bytes, the 404 error envelope, a run label created, applied to a seeded work message, and deleted, a draft without recipients (proven the run's own before it is adopted) composed, updated, read back through `get_thread`, and deleted, and the work message trashed and untrashed with its labels restored by the cleanup (all write-reversible). Calendar: range listing and paging, an event without attendees (no invitation is ever sent) created, read, renamed, and deleted, and a deleted event reading gone (write-reversible). Drive: folder listing and paging, the `get_file` field selection, and a run folder trashed and then deleted permanently (write-reversible; nothing stays in Trash unless the cleanup fails). Every write names an invocation-unique run id or touches only the seeded work message; the create, its decoding, and its registration are masked together; a definitive rejection undoes nothing; an ambiguous write is reported with the exact item to check by hand (with the case id in front when reported during an interruption); an answer outside the run namespace is never adopted; cleanups undo by id and verify. The Gmail send is write-irreversible (Gmail cannot unsend), sends one message whose only recipient is the seeded practice address, and runs only when requested by its exact id; `practiceAddress` and `runId` are branded seed types (`GooglePracticeAddress`, `GoogleConformanceRunId`), and the cases decode every seed again before any request, so a list, display name, header injection, or control character is refused with a precondition and no request. `findGoogleConformanceLeftovers` lists leftovers read-only. No case is observed live yet.
- fdcdd49: Add the experimental `@yolk-sdk/connectors/linkedin-search/conformance` subpath: seven read cases for the LinkedIn search connector (Exa people results with every decoded field a string and never `null`, the `numResults` limit honoured after a control search with `numResults: 3` shows more than two matches, the Enrich Layer profile answered as a non-empty object, the email lookup answering an `email` or a queued `email_queue_count` with the connector never reporting `status: "unknown"`, an unknown Exa key and an unknown Enrich Layer key each answering a 4xx status, and a profile URL that names no profile answering a 4xx status rather than an empty 2xx profile) with `LinkedInSearchConformanceConfig` seeds, `linkedInSearchConformanceCredentials` for the two API key slots, and minimal synthetic replay fixtures (a word-level allowlist test checks their 2xx bodies, request queries, and seeds). Rate limiting is not a case (the connector maps a 429 like any other non-2xx answer and reads no `Retry-After`). No case is observed live yet.
- 9f5f80a: Add `connectorBinaryWriteHttpClientFromEffectHttpClientLayer` to the experimental `@yolk-sdk/connectors/conformance` bridges (POST/PUT bytes plus `uploadSession` ranges and cancellation to pre-authenticated session URLs, refusing credential headers there; conformance and tests only, no byte, redirect, or DNS policy) and include it in `connectorHttpClientsFromEffectHttpClientLayer`. The conformance bridges create no client span for upload-session requests or requests without an `authorization` header, since the span would record a URL that may carry the credential; a host `HttpClient.TracerDisabledWhen` still applies. Add the experimental `@yolk-sdk/connectors/microsoft/conformance` subpath: eleven Microsoft Graph conformance cases (calendar range listing, seven-digit timestamps, event create and cancel semantics, attachment ids and `contentId`, `nextLink` paging, immutable ids across moves, concurrent draft writes, OneDrive folder round trip, and copy monitors) with `MicrosoftConformanceConfig` seeds, self-cleaning write cases, and synthetic replay fixtures. The connector has no calendar actions; the calendar cases send raw Graph requests through the connector ports.
- 685efdb: Add the experimental `@yolk-sdk/connectors/todoist/conformance` and `@yolk-sdk/connectors/telegram/conformance` subpaths. Todoist: seven cases (filtered task list cursor paging, the HTTP 404 error body, task labels as label names, the create/get/update/close task lifecycle, `due_date` / `due_datetime` as the connector sends them answering a due on the requested day, project `parent_id`, and project delete then not-found) with `TodoistConformanceConfig` seed ids. Write cases work only inside an invocation-unique `yolk-conformance-<runId>-<case>` project under `workProjectId` (the live runner generates a fresh run id each time): a definitive create rejection deletes nothing, an ambiguous create is reported with the exact project or task to check by hand, successful creates are deleted by id and verified, and a project without the requested name or with a seeded project's id, or a task outside the case project, is never deleted. `findTodoistConformanceLeftovers` lists leftover `yolk-conformance-run-*` projects read-only. Telegram: four cases (`telegram.validate` as one `getChat`, errors as a 4xx status with `ok: false` rather than `200`, `getFile` for `downloadTelegramFile` (the seeded file must report a size), and `telegram.send_message`) with `TelegramConformanceConfig` seeds; the Telegram actions read only HTTP statuses (the host-only `downloadTelegramFile` decodes the `getFile` result), so claims about the `ok` field are observed at the ports. The send case is write-irreversible (a sent message cannot be deleted through the connector) and runs only when requested by its exact id; an ambiguous send, including a 2xx without `ok: true`, is reported with the text to look for in the chat. Both ship synthetic replay fixtures (Telegram URLs carry the synthetic `telegramConformanceReplayBotToken`); no case is observed live yet. The Dropbox, Todoist, and Telegram write cases share one create/send classifier, which now treats an HTTP 408 answer like a 5xx: an outcome to check by hand, never a definitive rejection.
- 92f016f: Add the experimental `@yolk-sdk/conformance` package: Effect-only wire fixtures (`./fixture`) with schema decode, staleness helpers, and a secret scan; an offline, fail-closed replay `HttpClient` with a request ledger and wire faults for status-on-attempt, mid-stream failure, truncation, and held chunks (`./replay`); and a recorder that wraps a host-provided `HttpClient` to capture exchanges losslessly (text or base64 bodies and per-chunk stream bytes with original boundaries) with allowlisted headers (`./record`). The package performs no network I/O itself.

  `@yolk-sdk/agent` subscription-usage fetchers for Claude, Codex, Grok, and OpenCode Go accept an optional `url` endpoint override (default unchanged); only point it at a trusted proxy or local emulator because the credential is sent there. The new `@yolk-sdk/agent/providers/vercel/conformance` subpath exports synthetic Vercel AI Gateway wire fixtures (plain text, DeepSeek-style reasoning, split tool-call deltas, and an error envelope) for replay tests. `@yolk-sdk/agent` now depends on `@yolk-sdk/conformance`, which only its conformance subpaths import.

  `@yolk-sdk/connectors` Fortnox archive and invoice-preview downloads now build their URL from the shared `fortnoxApiBaseUrl` instead of a duplicated literal; requests are unchanged.

- Updated dependencies [367aceb]
- Updated dependencies [367aceb]
- Updated dependencies [367aceb]
- Updated dependencies [0ce9c3e]
- Updated dependencies [575a282]
- Updated dependencies [a4ba6db]
- Updated dependencies [00904fd]
- Updated dependencies [425c172]
- Updated dependencies [9f7aba3]
- Updated dependencies [ccc64a3]
- Updated dependencies [6d3b497]
- Updated dependencies [9ff96b8]
- Updated dependencies [0c58a89]
- Updated dependencies [92f016f]
  - @yolk-sdk/agent@0.1.0-canary.96
  - @yolk-sdk/conformance@0.1.0-canary.96

## 0.1.0-canary.95

### Minor Changes

- 8d919b4: Send 7-bit `gmail.send_message` MIME as one simple multipart media upload to `upload/gmail/v1/users/me/messages/send?uploadType=multipart` (`multipart/related` JSON metadata with `threadId` only when provided, then the decoded `message/rfc822` MIME) so messages with attachments up to Gmail's 35 MiB cap are accepted. MIME containing bytes `>= 0x80` keeps the previous JSON `raw` request. Host HTTP adapters must preserve the `multipart/related` content type and forward the string body exactly (CRLF, no re-encoding); prefer quoted-printable or base64 transfer encodings for large messages. Every send is exactly one request, never resumable or retried; input/output schemas and rejected/unknown status classification are unchanged. Decoded MIME over 35 MiB (`gmailSendMessageMaxBytes`) now fails before credentials or network with `validation_failed` and `underlying: { outcome: 'rejected', retryable: false, reason: 'too_large' }`. `GmailRawMessage` now validates in linear time (same accepted strings and published JSON Schema pattern): the previous regex overflowed the stack on multi-megabyte messages.
- 8d919b4: Add host-only `addOutlookAttachment` on `@yolk-sdk/connectors/microsoft` (not a connector action) to attach one file to an existing Outlook draft with the Outlook write slot and mailbox guards; it returns `{ attachmentId?, name, size }` and never sends. Files under 3 MiB (`outlookAttachmentSingleRequestMaxBytes`) use one Graph `fileAttachment` POST; 3 MiB to 150 MiB (`outlookAttachmentUploadSessionMaxBytes`) use `createUploadSession` and sequential pre-authenticated `PUT` ranges of `outlookAttachmentUploadChunkBytes` with validated `nextExpectedRanges` and a final 201 `Location` attachment ID. Once a valid, allowlisted session URL is obtained, any later failure or interruption triggers best-effort, time-bounded session cancellation; unusable session URLs are never contacted. Larger files or budgets fail with `response_too_large`. Input and result types are exported as `OutlookAddAttachmentInput` and `OutlookAddAttachmentResult`. The helper requires `CredentialResolver | ConnectorHttpClient`: both authenticated Graph JSON POSTs go through the regular `ConnectorHttpClient`, so hosts without any binary write port can attach files under 3 MiB. That string HTTP adapter must allow success bodies of `maxMetadataBytes` plus the echoed base64 content and must not log, trace or persist these request/response bodies (file content and the token-bearing `uploadUrl`). Add the optional `ConnectorBinaryWriteHttpClient.uploadSession` method and `ConnectorBinaryUploadSessionRequest` type, used only for session ranges and cancellation; existing adapters still compile, and hosts without the method or the port fail session-sized uploads with `upload_session_required` before any request. Session URLs are allowlisted to `https://outlook.office.com/api/{v1.0,v2.0,gv1.0,beta}/.../AttachmentSessions(...)` and never appear in results or errors.

### Patch Changes

- Updated dependencies [8d919b4]
  - @yolk-sdk/agent@0.1.0-canary.95

## 0.1.0-canary.94

### Minor Changes

- 32b90b3: Align Fortnox customer writes with the Fortnox Customer resource. `FortnoxCreateCustomerInput` and `FortnoxUpdateCustomerInput` no longer accept `Country` (read-only, derived from `CountryCode`) or `Phone` (customers use `Phone1`/`Phone2`), and `fortnox.create_customer` / `fortnox.update_customer` reject unknown keys instead of stripping them, including through `executeTyped`. Those actions' `inputSchema` is now a closed wrapper rather than the Class; construct inputs with the exported `FortnoxCreateCustomerInput` / `FortnoxUpdateCustomerInput` classes. `FortnoxCustomer` and `FortnoxSupplier` responses still include both fields. Fortnox action descriptions now document partial customer updates, invoice row replacement and RowId matching, required pre-existing referenced records, and the observed exclusion of unbooked invoices from payment-status filters.

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.94

## 0.1.0-canary.93

### Patch Changes

- e744353: Accept Fortnox invoice amounts sent as numeric strings at the wire boundary. Invoice list rows send fields like `CurrencyRate` as strings while single-invoice reads send numbers, so `FortnoxInvoiceApi` now decodes numbers, trimmed numeric strings, null, or absence for `Total`, `Balance`, `TotalVAT`, `TotalToPay`, `Net`, `Gross`, and `CurrencyRate` (`""` means unset; other non-numeric strings still fail). `FortnoxSupplierInvoiceApi` additionally accepts finite JSON numbers for `Total`, `Balance`, and `CurrencyRate` and records their string form. Public invoice types are unchanged. Also harden the invoice preview download: it sends no `Accept` header and verifies `%PDF-` magic bytes instead of requiring an `application/pdf` content type. `ConnectorFileTransferError` gains an optional HTTP `status` number set for every non-success status branch.
  - @yolk-sdk/agent@0.1.0-canary.93

## 0.1.0-canary.92

### Minor Changes

- 824206e: Add a GitHub connector at `@yolk-sdk/connectors/github`, scoped to one integration-configured `owner`/`repo` (the model never supplies either). It covers issues (search, list, get, create, update, lock/unlock, assignees, timeline), comments, labels, milestones, reactions, sub-issues, issue dependencies, org issue types and issue fields, pull requests (list, get, files, commits, checks, reviews, review comments, create, update, request reviewers, review, inline comment, merge with a required `expectedHeadSha`), and repository context (compare, releases, text file contents, code search). Every action declares `read`/`write`/`destructive` access, returns normalized outputs with truncation flags and `hasNextPage` pagination, and maps provider errors to stable `github_*` failure codes with rate-limit `retryAfterMs`. It sends GitHub REST API version `2026-03-10`. Host-only helpers: `createGithubAppInstallationToken` mints down-scopable installation tokens from an RS256 App JWT signed with WebCrypto (accepts PKCS#1 and PKCS#8 keys), and `uploadGithubAttachment` uploads images and videos through GitHub's undocumented user-attachments endpoint. That endpoint requires a user token and pushes bytes through the binary write port.

### Patch Changes

- Updated dependencies [7bc4f70]
  - @yolk-sdk/agent@0.1.0-canary.92

## 0.1.0-canary.91

### Patch Changes

- b9c5610: Add IMAP Sent-copy configuration to generic email submission. Sent saving is requested by default; `saveToSentItems: false` skips it. Legacy hosts receive synthesized `unsupported` or `skipped` status instead of an implied save. Confirmed SMTP acceptance is preserved when ancillary metadata is invalid. Hosts still own MIME rendering and Sent storage; storage failures must not trigger resubmission.

  Support tool-result images, readable text documents, and PDFs when `supportsPdfAttachments` is enabled in OpenAI-compatible Chat Completions. Those parts are lowered to origin-labeled supplementary user content after the complete tool-result block. Other native document formats and audio remain unsupported. Validate all content before resolving URL-backed PDFs, preserve canonical history, and continue rejecting unresolved references.

- 1478827: Accept JSON null on optional Fortnox response fields. Fortnox uses null for unset values, so strict optional schemas rejected successful company, customer, invoice, and supplier responses.
- 6a96606: Add Microsoft OneDrive same-drive move, asynchronous copy acceptance, and copy-status polling. Polling sends no credential to the monitor URL and requires host adapters to honor `redirect: 'manual'` and `credentials: 'omit'`. Monitor URLs are secrets. Microsoft failures now match `Retry-After` case-insensitively and ignore ambiguous, non-integer, or unsafe delay values.
- Updated dependencies [b9c5610]
  - @yolk-sdk/agent@0.1.0-canary.91

## 0.1.0-canary.90

### Patch Changes

- 76d6c5c: Add Fortnox customer and invoice write capabilities alongside the ten read actions. The new `fortnox.create_customer`, `fortnox.update_customer`, `fortnox.create_invoice`, and `fortnox.update_invoice` actions use `write` access metadata, typed schemas, JSON request envelopes, and resource-scoped OAuth hints. Sending, booking, cancellation, and payment actions remain absent so hosts can keep outbound invoice approval policy separate. Hosts retain HTTP execution, OAuth lifecycle, credentials, and policy; Fortnox OAuth scopes themselves still grant read and write access.
- Updated dependencies [6c7efcb]
  - @yolk-sdk/agent@0.1.0-canary.90

## 0.1.0-canary.89

### Patch Changes

- 2af6ed0: Accept the official untagged Dropbox `create_folder_v2` metadata response while retaining compatibility with tagged folder responses and strict tagged metadata validation for other Dropbox actions.
- Updated dependencies [4188847]
  - @yolk-sdk/agent@0.1.0-canary.89

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
