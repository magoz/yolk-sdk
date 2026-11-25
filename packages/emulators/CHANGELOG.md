# @yolk-sdk/emulators

## 0.1.0-canary.162

### Patch Changes

- aab270f: Advance in lockstep with `@yolk-sdk/codemode`, which upgrades its script engine to `@earendil-works/pi-codemode` 1.6.0 (frozen built-ins, output limits, constraint tags in tool declarations). These packages have no direct changes in this release.

## 0.1.0-canary.161

### Patch Changes

- 34b7f96: Advance in lockstep with `@yolk-sdk/codemode`: `readOnlyNestedCallGate` can admit model-invoking reads such as `classify` through `admitModelCall`. These packages have no direct changes in this release.

## 0.1.0-canary.160

### Patch Changes

- d55175d: Advance in lockstep with `@yolk-sdk/agent` and `@yolk-sdk/codemode`: hosts can run code mode scripts outside a model turn (`runCodeModeScript` over `ResolvedToolSet.nestedExecutor`), gate them to reads (`readOnlyNestedCallGate`), mark tools that call a model (`invokesModel`), and render annotated host messages from chat items. These packages have no direct changes in this release.

## 0.1.0-canary.159

### Patch Changes

- 0e5d1ac: Advance in lockstep with `@yolk-sdk/agent`, `@yolk-sdk/codemode`, `@yolk-sdk/harness` and `@yolk-sdk/vercel-workflows`: tool results can mark their nested usage incomplete (`ToolResult.usageIncomplete`), and durable model events name their execution's turn (`executionTurn`) so a client rebuilt from a snapshot mid-turn starts that turn. These packages have no direct changes in this release.

## 0.1.0-canary.158

### Patch Changes

- 86636a3: Fortnox bookkeeping conformance and emulation. `@yolk-sdk/connectors/fortnox/conformance` adds four seedless `read` cases (25 cases in all): `fortnox.bookkeeping.financial-year-id-and-date`, `fortnox.bookkeeping.account-balances-list-get` (a populated account page and its balances), `fortnox.bookkeeping.voucher-list-get-balanced` (a populated voucher page, its series, a voucher whose rows balance, and its file connections), and `fortnox.bookkeeping.sie-file-ibm437` (a type 1 SIE file as PC8 bytes), with synthetic, unverified fixtures. The Fortnox emulator serves the ten bookkeeping reads (`/3/financialyears`, `/3/accounts`, `/3/voucherseries`, `/3/vouchers` and its sublist, `/3/voucherfileconnections`, `/3/sie/{Type}`; 54 routes in all) from new seed keys (`financialYears`, `accounts`, `voucherSeries`, `vouchers`, `voucherFileConnections`, `sieFiles`); voucher and voucher file connection creates stay unemulated.
- d4141e3: Advance in lockstep with `@yolk-sdk/connectors`, which adds Fortnox bookkeeping actions (financial years, accounts, voucher series, vouchers, voucher file connections, and SIE files). These packages have no direct changes in this release.

## 0.1.0-canary.157

### Patch Changes

- 7892f30: Advance in lockstep with `@yolk-sdk/connectors`, whose Fortnox supplier invoice reads now accept the JSON forms Fortnox sends beyond its OpenAPI types, and whose Fortnox reads fail an amount past the double range as `validation_failed`. These packages have no direct changes in this release.

## 0.1.0-canary.156

## 0.1.0-canary.155

### Patch Changes

- d4d8714: Upgrade the coordinated Effect runtime and platform dependencies to Effect 4.1.5 (patch releases of Effect 4.1). Hosts must move `effect` and the coordinated `@effect/*` runtime packages to 4.1.5 together with Yolk. Yolk APIs are unchanged.

## 0.1.0-canary.154

## 0.1.0-canary.153

## 0.1.0-canary.152

## 0.1.0-canary.151

### Minor Changes

- 2055d60: The local stdio MCP client (`listLocalMcpServerTools`, `callLocalMcpServerTool`) no longer treats a server's own messages as a broken session (#386). Each stdout line is read as one JSON-RPC message (MCP `2025-11-25` basic/transports, stdio): a server `ping` is answered `{"jsonrpc":"2.0","id":<id>,"result":{}}` on stdin (basic/utilities/ping), any other server request gets JSON-RPC error `-32601` (the client declares no client capability), and notifications such as `notifications/message` are ignored. A line that is not a JSON-RPC message, including a request or notification whose `params` is not an object, still fails the operation. Listings now run in the same session as calls, so the client keeps the server's stdin open until it has its answers. Behaviour change: a server that only answers after stdin closes now fails listings (it already failed calls).

  The remote client ends a legacy-era session when it closes (#381): after each operation on a `2025-11-25` connection that holds an `MCP-Session-Id`, it sends `DELETE` with it (basic/transports, "Session Management" item 5) through the SDK's `terminateSession()`. The `DELETE` is awaited, so every legacy operation that holds a session takes one more round trip before it returns (at most 2 s, or the operation's `timeoutMs` if shorter). It is best effort: a 405 (the server does not let clients end sessions) or 404 (the session is already gone) is accepted silently, any other failure (or the timeout) is only logged at debug level, and the operation's result never changes. Modern (`2026-07-28`) connections, legacy servers that issue no session id, and operations interrupted before closing (the session is left to expire) send no `DELETE`; an interrupt that arrives during the `DELETE` waits at most 2 s. `mcp.legacy.session` now also checks the session end (exactly one `DELETE` after the last POST, carrying the session id, answered 2xx, 404 or 405; none without a session), and every legacy conformance fixture with a session ends with the `DELETE` (answered 200, as the official server SDK answers it); the synthetic builders gain `legacySessionEndExchange`.

  `@yolk-sdk/emulators/mcp` answers that `DELETE` on the synthetic legacy and Figma profiles: two new manifest rows (`DELETE <origin><path>#session-end`, twenty-one rows), the recorded 200 on a ready session, whose commit ends the session (later requests on it are refused), an `accept` of `*/*` tolerated (the fetch default), and the drill knob `sessionEndRejected` (the `DELETE` answered 500, failing only `mcp.legacy.session`). The fixture copies (`mcpEmulatorFixtures`, `mcpEmulatorServerPingFixtures`, `mcpEmulatorFigmaFixtures`) carry the new exchanges, and the conformance cross-checks now end exactly at the seed. `@yolk-sdk/connectors/figma/conformance` fixtures end each operation with the same `DELETE`.

## 0.1.0-canary.150

### Minor Changes

- bd19297: Add six `read` conformance cases that send exactly the requests of the read-only leftover lookups, each with a synthetic `unverified` fixture shaped from the provider's API reference: `todoist.projects.list-cursor-paging` (the `limit=200` project listing, then one project per page through `next_cursor`), `github.issues.open-listing` (the open-issue listing and the work issue's first comment page, `per_page=100`, `page=1`), and `google.gmail.label-listing`, `google.gmail.draft-search`, `google.calendar.free-text-query` (it claims only that each answered event mentions `yolk` or `conformance` somewhere Google searches, organizer, creator, and working location included, observed at the port), and `google.drive.list-includes-trashed` (with a new `driveTrashedFileId` seed, a file in Trash inside `driveFolderId`, which the listing must answer; a seed Drive has purged from Trash after 30 days is a `precondition:` failure). The Google draft and event lifecycle cases also check, live only, that the lookup's search finds their own item before they delete it: the new `GoogleConformanceLookupRecall` reference (default off) turns that on, and the repository's live runner sets it; the search is retried up to three times over about 6 seconds, since indexing can lag.

  The Todoist, GitHub, and Google emulators now serve those requests, citing the new cases, so `findTodoistConformanceLeftovers`, `findGithubConformanceLeftovers`, and `findGoogleConformanceLeftovers` run against them and report what the state holds. This supersedes the earlier changesets `emulators-todoist-telegram`, `emulators-github`, and `emulators-google`, which say these lookups fail closed against the emulators. The routes: `GET /api/v1/projects` with cursor paging on `/todoist` (its task and project cursor counters now never reset, so no cursor value crosses a `reset` or `seed`); `GET /repos/{owner}/{repo}/issues` (`state=open`, `page=1`) and a `page=1` comment listing on `/github`, whose seed gains `impliedIssues` (`closed` only on the default seed as the listing fixture records it; a seed that replaces `repository` or `issues` or sets `nextIssueNumber` gets `unknown`, which refuses the listing while implied numbers exist, unless it names `closed` itself); and `GET .../labels`, `GET .../drafts`, the `q` event query, and the Drive listing with trashed items on `/google`, whose seed gains `listedLabels` (the system and paging labels as the listing fixture records them) and whose default practice folder now holds the seeded trashed file. The Google draft search and event query are recorded only empty and stay fixture-only: the draft search answers only while the state holds no draft and no message labelled `DRAFT`, and the event query only while no event of the calendar, cancelled ones included, holds `yolk` or `conformance` in its summary or description, nor, while the calendar holds events, its id or summary (the organizer) or the practice address (the creator), since Gmail's search syntax and Calendar's free-text matching cannot be emulated honestly; otherwise they fail closed (for example after the event cases, whose cancelled run events stay in the state). New test-only drill knobs: `projectCursorRestarts` (Todoist), `issueListingLinksNext` (GitHub), and `labelListingOmitsUserLabels`, `draftSearchDraftsNull`, `eventQueryIgnored`, `trashedListingOmitsTrashed` (Google); `listIncludesTrashed` now adds only trashed folders created here to a listing without trashed items.

- 8a1475a: `@yolk-sdk/mcp/conformance` adds the opt-in `mcpServerPingCase` (`mcp.legacy.server-ping`, read, legacy era only; not in `mcpConformanceCases`) and its synthetic fixture `mcpConformanceServerPingFixtures` (`evidence: 'unverified'`; its note cites MCP `2025-11-25` basic/utilities/ping, basic/transports and basic/lifecycle), with the builder `legacyServerPingListingExchanges` and the constant `mcpConformanceServerPingRequestId`. Run it for a legacy target that pings its clients: the listing must hold a server `ping` request (else the precondition fails), and the real client must answer each ping exactly once with an empty JSON-RPC result on a POST carrying the issued session, which the server accepts with 202 and no body. `2026-07-28` removed `ping` and server-to-client requests, so it never applies to modern targets. `mcp.transport.response-encoding` no longer reads a client-sent response (such as the answer to a server ping) as a request, so it passes against a pinging server. Methods the client never sends (`DELETE`, its own `ping`, `resources/*`, `prompts/*`, `completion/*`, `logging/setLevel`, `tasks/*`, batches) stay uncovered, with the reasons in the package notes.

  `@yolk-sdk/emulators/mcp` answers it on the synthetic legacy profile: the seed gains `legacyInitialize` (`plain`, the default, or `server-ping`; new export `McpEmulatorLegacyInitialize`), the state gains `legacyInitialize`, and a session may carry `awaitingPingAnswer`. Under `server-ping`, `initialize` answers the fixture's pinging SSE answer, and the new manifest row `RPC https://mcp.example.test/legacy/mcp#response:ping` (nineteen rows) accepts the client's answer once, exactly as recorded, in either session phase, with the recorded 202. New exports `mcpEmulatorServerPingFixtures` (the data copy) and the drill knob `pingAnswerRejected`. The Figma profile records no ping and ignores the seed. Both packages take a minor bump: hosts that read the emulator state or seed summary see the new `legacyInitialize` field, and the conformance subpath gains public exports.

### Patch Changes

- 29ad461: Add eight SharePoint site and Teams conformance cases to the experimental `@yolk-sdk/connectors/microsoft/conformance` subpath (nineteen cases in all), each with a synthetic `unverified` fixture shaped from the Microsoft Graph v1.0 docs examples (each fixture's note names its pages). Reads: `microsoft.sharepoint.search-finds-site` (a keyword search lists the seeded site by its comma-separated id), `microsoft.sharepoint.site-drives-libraries` (the site's drives include a document library; a `null` description decodes), `microsoft.teams.chats-list-members` (listed chats carry their members; a listed id reads back), `microsoft.teams.chat-messages-paging` (a `nextLink` naming the chat id unencoded is accepted and leads to new messages), `microsoft.teams.team-channels` (the joined team and its channel read back by id as listed), `microsoft.teams.channel-message-replies` (channel listings hold top-level posts; replies name their post), and `microsoft.teams.meeting-transcripts` (a join link finds its meeting, whose transcripts name it). Write: `microsoft.teams.send-chat-message` is write-irreversible (the connector cannot remove a sent message), runs live only by its exact id, posts plain text naming the per-invocation `runId` and claims the escaped HTML body reads back by the returned id; an ambiguous send fails `MicrosoftConformanceActionFailed` with `sendOutcome: 'unknown'` naming the run id. `MicrosoftConformanceSeeds` gains `siteSearchQuery`, `siteId`, `chatId`, `sendChatId` (a dedicated practice chat the send posts to, kept apart from the paging `chatId`), `teamId`, `channelId`, `channelMessageId`, `meetingJoinWebUrl`, and `runId`. `@yolk-sdk/emulators/microsoft` adds sixteen fixture-only SharePoint site and Teams routes (35 in all) that answer only the recorded exchanges byte for byte, citing their cases; the chat send (a pending write route) answers the recorded send under a minted message id and keeps it in the new `chatMessagesSent` state, with one drill knob per new case. No case is observed live yet. The already released `teams.send_chat_message`, `teams.send_channel_message`, and `teams.reply_to_channel_message` now send with `redirect: 'manual'` and `credentials: 'omit'`, so a 307 or 308 never posts the message twice; host adapters must honor both (a 3xx answer is a send failure). The Microsoft emulator's `empty` profile now refuses every Teams and SharePoint site route with the 400 not emulated (no fixture records an empty listing): the state gains the required `recordedTeamsSites` flag (`true` only under `default`) and `chatMessagesSent`, so a state snapshot taken before this change (from `/_emulate/state` or `snapshot()`) no longer decodes as `MicrosoftEmulatorStateSchema` and is refused.

## 0.1.0-canary.149

### Minor Changes

- 6935d1e: Add the experimental `@yolk-sdk/connectors/kie/conformance` subpath: six Kie conformance cases (`kieConformanceCases`) with `KieConformanceConfig` seeds and minimal synthetic replay fixtures (`kieConformanceFixtures`, `evidence: 'unverified'`; an allowlist test checks every body). Four reads run the real `kie.get_task`: a finished task reads back `success` with https result URLs parsed from `resultJson`, a failed task is a successful read with a failure detail, an unknown task id answers Kie code 404 or 422 (Kie answers most failures with HTTP 200 and a non-200 envelope `code`), never a success or another code such as a 429 or 455, and a synthetic invalid key answers `kie_unauthorized`. Two `write-irreversible` cases run the real `kie.create_image_task` (GPT Image 2, square at `1K`) and `kie.create_video_task` (Wan 2.7, `720p` for 5 seconds): every task spends credits and the connector cannot cancel one, so each runs only by its exact id, uninterruptibly with its classification (a definitive HTTP or envelope 4xx other than 408 and 455 created nothing; anything else that is not HTTP 2xx with envelope `code` 200 and a non-empty task id is an unknown task outcome naming the run id; a created task must then answer exactly HTTP 200). Add the experimental `@yolk-sdk/connectors/figma/conformance` subpath, following the Afloat pattern: no case code and no `@yolk-sdk/mcp` import; `makeFigmaMcpConformanceTarget()` runs the real `figma.mcp_auth` and answers the target value (`https://mcp.figma.com/mcp`, the access token as `Authorization: Bearer`, never the refresh token or client credentials, the legacy era with protocol `2025-11-25`, unverified), seeds naming six known Figma tool names with synthetic schemas, and eight synthetic placeholder fixtures (every case but `mcp.modern.stateless`). Add the experimental, Node-only `@yolk-sdk/emulators/kie` subpath: `makeKieEmulator`, a stateful, fixture-only emulator of the Kie task read and create routes on the shared wrapper's fail-closed mode with the bearer digest (the recorded records, the not-found envelope, and the 401 for a rejected key kept only as its digest; creates answer a minted task id and are recorded in state, never readable), with status faults, a control plane, one drill knob per case, and a route evidence manifest (`kieEmulatorRoutes`; `POST /api/v1/jobs/createTask` is a connector write pending an owner-approved live run). `@yolk-sdk/emulators/mcp` gains a fourth profile, `figma`, on `https://mcp.figma.com/mcp` (the legacy era, answering the Figma fixtures copied as data in `mcpEmulatorFigmaFixtures`; new exports `mcpEmulatorFigmaOrigin` and `mcpEmulatorFigmaPath`): every legacy session is now bound to the profile that minted it (Figma sessions carry `profile: 'figma'` in the state), and the shared stateful wrapper's route matcher allows one method and template on two recorded origins, picking the route recorded on the arrival origin (tables without such a pair match as before; a `GET` on the Afloat profile's `/mcp` is now refused as recorded on the Figma origin only). No case is observed live yet.
- 22f42c0: The `@yolk-sdk/emulators/openai` emulator now emulates OpenAI reasoning models as the three new synthetic reasoning fixtures record them. `reasoningModels` (new option, default `openAiEmulatorDefaultReasoningModels`: `gpt-6-luna`, also added to `openAiEmulatorDefaultModels`) take `reasoning_effort` and `max_completion_tokens`, send no reasoning text, and report `usage.completion_tokens_details.reasoning_tokens`, counted in `completion_tokens` (synthetic, not fixture-backed: 0 for `reasoning_effort: 'none'`); `/_emulate/state` lists them. A reasoning model answers a non-null `max_tokens` with the fixture's 400 `{ error: { message, type: 'invalid_request_error', param: 'max_tokens', code: 'unsupported_parameter' } }` (after model validation, never for a scripted turn, using up no fault; recorded as the ledger's new `unsupportedParameter`). Sampling parameter rules, `reasoning_effort` on a model that does not reason (still recorded and ignored), and per-model effort values are not emulated until a fixture backs them. Models that do not reason keep their wire unchanged, and the Gateway emulator is unchanged. Scripted turns still reject reasoning text fields; script reasoning as `usage.reasoningTokens`.

  `@yolk-sdk/agent/providers/openai/conformance` adds three `read` cases for a reasoning model, with synthetic fixtures whose notes cite the OpenAI docs: `openAiChatReasoningEffortCase` (`openai.chat.stream.reasoning-effort`) and `openAiChatJsonReasoningUsageCase` (`openai.chat.json.reasoning-usage`) send `reasoning_effort` and require no reasoning text and a usage report counting reasoning tokens, and `openAiChatUnsupportedParameterCase` (`openai.chat.stream.unsupported-parameter`) sends `max_tokens` and requires a non-retryable 400 with provider code `unsupported_parameter`. `OpenAiConformanceModels` gains a required `reasoning` model id (default `gpt-6-luna`) and `OpenAiConformanceSettings` the required `reasoningMaxCompletionTokens` and `reasoningEffort`. `pnpm conformance:openai` takes `--reasoning-model`, `--reasoning-max-tokens` (default 1024), and `--reasoning-effort` (default `medium`; `low` to `xhigh`).

  Both packages take a minor bump because hosts see behaviour or type changes they must act on: `@yolk-sdk/agent` because hosts that build `OpenAiConformanceModels` or `OpenAiConformanceSettings` must add the new required fields; `@yolk-sdk/emulators` because the default `/openai` emulator now answers `gpt-6-luna` (a 404 unknown model before) and rejects `max_tokens` on it with a 400.

### Patch Changes

- 88e6c48: Add fourteen `read` Fortnox conformance cases to `@yolk-sdk/connectors/fortnox/conformance` (company information, the customer list, and the article, price, cost center, invoice and supplier invoice payment, offer and offer preview, print template, inbox and inbox file, company settings and locked period, predefined account and label, settings register, and profile reads), each with a synthetic `unverified` fixture shaped from the Fortnox API reference and its archived examples (the fixtures are the source of the emulator's read answers). They take no seed: each reads back the first row a list answers through the real connector actions and claims only decoding and read-back. Every `@yolk-sdk/emulators/fortnox` route now cites a conformance case in `fortnoxEmulatorRoutes`: `GET /3/companyinformation`, `GET /3/customers`, and the 34 read-only routes no longer cite none, and the default emulator answers every read fixture request with the fixture's body byte for byte. The default supplier invoice payment now carries a voucher (`VoucherNumber` 2, `VoucherSeries` `D`, `VoucherYear` 3).

## 0.1.0-canary.148

## 0.1.0-canary.147

## 0.1.0-canary.146

## 0.1.0-canary.145

## 0.1.0-canary.144

### Patch Changes

- 6afa1c5: Advance in lockstep with `@yolk-sdk/sandbox`, which adds a Cloudflare Containers backend (`@yolk-sdk/sandbox/cloudflare`). These packages have no direct changes in this release.

## 0.1.0-canary.143

## 0.1.0-canary.142

### Patch Changes

- 8a3c032: Advance in lockstep with `@yolk-sdk/vercel-workflows` and `@yolk-sdk/codemode`, which add Cloudflare Workers runtimes (`@yolk-sdk/vercel-workflows/cloudflare*` and `@yolk-sdk/codemode/cloudflare`). These packages have no direct changes in this release.

## 0.1.0-canary.141

## 0.1.0-canary.140

## 0.1.0-canary.139

### Patch Changes

- 7c3a30d: Upgrade the coordinated Effect runtime and platform dependencies to Effect 4.1.4 (patch releases of Effect 4.1). Hosts must move `effect` and the coordinated `@effect/*` runtime packages to 4.1.4 together with Yolk. Yolk APIs are unchanged.

## 0.1.0-canary.138

## 0.1.0-canary.137

## 0.1.0-canary.136

## 0.1.0-canary.135

## 0.1.0-canary.134

### Patch Changes

- dc74275: Advance in lockstep with `@yolk-sdk/agent`, whose tool argument validation errors now name a number or boolean the model sent as a JSON string, with the literal to send instead. The tools of `@yolk-sdk/connectors`, `@yolk-sdk/knowledge`, `@yolk-sdk/sandbox` and `@yolk-sdk/files` already append that hint, so their errors gain the line. These packages have no direct changes in this release.

## 0.1.0-canary.133

## 0.1.0-canary.132

## 0.1.0-canary.131

### Patch Changes

- 6e9bd7d: Advance in lockstep with `@yolk-sdk/agent`, whose providers now fail a returned tool call with an empty or padded id or name as a typed `invalid_response` instead of a defect, and `@yolk-sdk/vercel-workflows`, whose `TestWorkflowWorld` now stores step errors through the platform's serializer and records unstorable ones in `inspect(runId).unstorableStepErrors`. These packages have no direct changes in this release.

## 0.1.0-canary.130

## 0.1.0-canary.129

## 0.1.0-canary.128

### Patch Changes

- cae5998: Advance in lockstep with `@yolk-sdk/connectors`, which adds Microsoft Teams chats, channels, meeting lookup and transcripts to `@yolk-sdk/connectors/microsoft`. These packages have no direct changes in this release.

## 0.1.0-canary.127

### Patch Changes

- 5a12835: Advance in lockstep with `@yolk-sdk/connectors`, which adds SharePoint site search, site drive listing and sharing-link resolution to `@yolk-sdk/connectors/microsoft`. These packages have no direct changes in this release.

## 0.1.0-canary.126

### Patch Changes

- 74c1fe5: Advance in lockstep with `@yolk-sdk/agent`, `@yolk-sdk/codemode`, `@yolk-sdk/mcp` and `@yolk-sdk/connectors`, which adopt typed tool results (ADR 0013); `@yolk-sdk/connectors` also adds the Kie connector. These packages have no direct changes in this release.

## 0.1.0-canary.125

### Patch Changes

- 3040e5a: Fortnox customer invoices expose `Remarks`, the invoice text (Fakturatext) printed on the invoice. `fortnox.create_invoice` and `fortnox.update_invoice` accept it (at most 1024 characters, like `Comments` now), `FortnoxInvoice` returns it, and the action descriptions tell agents that `Remarks` is printed while `Comments` is an internal note. The Fortnox emulator stores and returns invoice `Remarks` on create, update, and read.

  Invoice write rows now use the new `FortnoxInvoiceRowInput`, the writable fields of Fortnox's row payload, instead of the read schema `FortnoxInvoiceRow`. Read-only `PriceExcludingVAT`, `Total`, and `TotalExcludingVAT` are no longer advertised as inputs (Fortnox rejected a written `PriceExcludingVAT` with code 2000321), rows are closed (an unknown row key fails `execute`, agent tool calls, and the invoice input classes' `make` instead of being dropped, which would send a row without its price), `VAT` is an integer, `DiscountType` is `AMOUNT` or `PERCENT`, `Description` and `Unit` follow Fortnox's 255 and 20 character limits, and row fields no longer accept `null`. `FortnoxInvoiceRowInput` is a closed schema with a matching type, not a class: code that built write rows with `FortnoxInvoiceRow.make` must build plain `FortnoxInvoiceRowInput` objects.

## 0.1.0-canary.124

### Patch Changes

- 6a1c1d4: Upgrade the coordinated Effect runtime and platform dependencies to Effect 4.1.2. Hosts must use the matching Effect version, and adopt Effect 4.1's own breaking changes where their code uses the affected APIs (`effect/Crypto`, `HttpClientRequest.method` as `string`, `KeyValueStore`, `FileSystem.make`, `ChildProcess` templates, `McpServer` registrations). `@effect/platform-node` 4.1 requires `ws` ^8.22.1; dedupe `ws` if a Workflow build reports duplicate step ids.

  Tool JSON Schemas generated from Effect schemas are flatter: Effect 4.1 merges a nested `anyOf` into its parent and no longer duplicates a named definition used by both a required and an optional property. What a schema admits is unchanged, and the `yolk:null-means-omitted` marker still tells the codec-added `null` from a `Schema.NullOr` `null`. Hosts that list tools over MCP serve changed tool schemas once, so grants keyed on a tool snapshot digest return to their default for the affected tools.

## 0.1.0-canary.123

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

- 995762e: Report subscription quota exhaustion and model-scoped usage windows (ADR 0011).

  - `ProviderErrorInfo.quotaResetsAtMs` (epoch milliseconds): when an exhausted subscription quota resets. The Claude subscription provider reads it from the unified rate-limit headers of a `429` (the latest reset among the rejected five-hour and weekly windows, else the unified reset when the account is rejected; model-scoped weekly and overage-only rejections carry none, so a model limit never reads as account exhaustion). The Responses providers read it from a `429` whose error type is `usage_limit_reached` (`resets_at`, else `resets_in_seconds`), which ChatGPT Codex sends. Resets in the past or more than a year ahead are dropped. Transient rate limits never carry it; the failure kind stays `rate_limit` and retry behavior is unchanged. `classifyProviderFailure` accepts a parsed `quotaResetsAtMs` and keeps it only on `rate_limit`.
  - `ProviderSubscriptionUsageWindow.models`: lowercase model id substrings a model-scoped window limits; absent means every model of the account.
  - Claude subscription usage now sets `windowDurationMinutes` (300 for `five-hour`, 10080 for `seven-day`) and parses the model-scoped weekly limits in `limits[]` (`kind: "weekly_scoped"`) as `seven-day-<model>` windows with `models: [<model>]`, keyed by the lowercase model id or else the display name slugged; a non-string model id or a numeric `resets_at` (epoch seconds) is accepted. Window JSON gains these keys after `resetsAt`.
  - OpenCode Go usage sets `windowDurationMinutes` on its fixed rolling windows (300 for `five-hour`, 10080 for `seven-day`); `monthly` follows the billing month and stays without a length.
  - The Claude usage conformance case accepts and checks those scoped windows (`scopedWindowIdPrefix` on the shared usage case builder), and its synthetic fixture reports one.
  - The `/anthropic` usage route's recorded body matches the updated fixture.

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

### Patch Changes

- c3da661: Default OpenCode Go to its documented base, `https://opencode.ai/inference/go/v1`.

  `openCodeGoBaseUrl` and `openCodeGoSubscriptionUsageUrl` moved from `/zen/go/v1` to `/inference/go/v1`, the base OpenCode's Go docs list for every endpoint. The earlier base still answers; hosts pinning it through `baseUrl` or `url` are unaffected. The OpenCode Go conformance fixtures and `makeOpenCodeGoEmulator` routes follow the new paths.

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

### Minor Changes

- d0ed3bc: The Fortnox emulator (`@yolk-sdk/emulators/fortnox`) now serves every read endpoint of the connector's newer Fortnox actions, `GET` only (34 routes, 44 in `fortnoxEmulatorRoutes`): articles, price lists and prices, cost centers, customer and supplier invoice payments, offers and the offer preview PDF, print templates, the inbox (folder JSON, file bytes), company settings, the locked period, predefined accounts, labels, the modes/terms of payment, terms/ways of delivery, and units registers, and `/3/me`. No fixture records them: they cite no conformance case, are `unverified`, and use minimal synthetic shapes named after the fields the connector reads. Their writes and side-effecting reads (such as `/3/offers/{DocumentNumber}/email`) are not emulated and still fail closed with a 404. The state and `FortnoxEmulatorSeed` gain one key per resource (each replacing the profile's part, checked for duplicates and dangling references; a seed replacing `customers` or `invoices` without seeding `offers` or `invoicePayments` starts those empty); the default profile holds small consistent synthetic data, `empty-company` empties the business data, and `no-booked-invoices` has no invoice payments. A missing key answers 404 `ErrorInformation` code `2999011` (`resourceNotFound`). Customer and invoice writes that reference an article, cost center, or project still answer 400, now saying such references are not emulated.

### Patch Changes

- 8972e3c: Enable provider prompt caching (ADR 0008). `LLMRequest` gains `cacheKey` (also on `RunConfig` and
  `RuntimeConfig`), `turnContext` and `toolChoice`. Anthropic requests always carry `cache_control`
  breakpoints (last tool, conversation end, previous request's end; native Messages also the system
  prompt) with a configurable `promptCacheTtl` on the Claude provider, and the Claude session header
  is derived from `cacheKey`. Codex and Grok send `prompt_cache_key` plus their session headers,
  Vercel AI Gateway sends `caching: 'auto'` and `x-session-affinity`, and OpenCode Go sends
  `x-opencode-session`. `turnContext` is appended after the conversation (after every Anthropic breakpoint); `toolChoice: 'none'` keeps
  tool definitions while forbidding calls (on Anthropic it invalidates cached messages). The generic OpenAI-compatible chat provider sends nothing unless its new
  optional `cacheKeyHeaders` config is set. The `@yolk-sdk/emulators` OpenCode Go Messages recording
  now expects the cache markers.

## 0.1.0-canary.106

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

- fc0c93c: Stop Gmail web from hard-wrapping drafts at about 70 columns when a person opens one and clicks Send. `gmail.draft_compose`, `gmail.draft_update`, and `gmail.draft_reply` used to write a single unencoded `text/plain` part, which Gmail web opens in its plain-text composer. A plain-text body is now sent as 7-bit `multipart/alternative` with `MIME-Version: 1.0`: a text/plain part with the body (line breaks as CRLF) and a text/html part derived from it (HTML-escaped, `<br>` per line break, runs of spaces kept, `http(s)` URLs linked to themselves, inside one `<div dir="ltr">`), both `charset=UTF-8` quoted-printable with lines of at most 76 characters, under the constant boundary `=_yolk-draft-alternative`. Recipients see the HTML with paragraphs unwrapped; on send, Gmail web still regenerates the text/plain alternative and wraps it at about 76 columns. The three actions take an optional `contentType: 'text' | 'html'` (`text` when omitted, as on the Outlook draft actions; new export `GmailDraftContentType`); `html` sends the body as one quoted-printable text/html part. Their descriptions now tell the model to write each paragraph as one line. `gmail.get_thread` no longer applies a part's `Content-Transfer-Encoding` to `body.data` again (Gmail answers it already transfer-decoded), which corrupted quoted-printable text holding `=XX` (such as `?date=2026`) and dropped base64-encoded bodies. `gmail.send_message` is unchanged. The synthetic draft conformance fixture and `@yolk-sdk/emulators/google` follow the new draft MIME (the draft payload is `multipart/alternative`, its metadata `body.size` 0); the emulator answers only the recorded text drafts, so `contentType: 'html'` drafts are not emulated.

## 0.1.0-canary.101

### Patch Changes

- 0a0067e: Add `gmail.list_threads` (`gmailListThreadsAction`): `GET /users/me/threads` with the `gmail.list` filters (`GmailListThreadsInput`: `query`, `labelId`, `maxResults`, `pageToken`, `isRead`, `isFlagged`), returning decoded `GmailListThreadsOutput` `{ threads?: [{ id, snippet?, historyId? }], nextPageToken?, resultSizeEstimate? }` through the `gmail.readonly` slot; failures map like the other Gmail reads (`gmail_list_threads_failed`). `gmail.get_message` and `gmail.get_thread` accept optional `metadataHeaders` (`GmailMetadataHeaders`: 1 to 50 `GmailMetadataHeaderName` values), sent as repeated `metadataHeaders` query parameters and valid only with `format: 'metadata'` (other combinations fail decoding, and `make` throws); with a selection `gmail.get_thread` keeps exactly the selected headers instead of its default allowlist. Omitted, requests and outputs are unchanged. New Google conformance cases `google.gmail.list-threads-page-token` and `google.gmail.metadata-headers` with synthetic fixtures; the Google emulator serves the thread listing (`impliedThreads` seed entities, `gmailThreadPageRepeats` drill) and `metadataHeaders` selections on message and metadata thread reads (`metadataHeadersIgnored` drill), and the attachment message gains a `From` header and a recorded metadata rendering.

## 0.1.0-canary.100

### Patch Changes

- 36620a8: Advance unchanged public packages in lockstep with the Google Calendar `sendUpdates` support in `@yolk-sdk/connectors`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.99

### Patch Changes

- ee80a4a: Advance unchanged public packages in lockstep with the durable tool-call ledger in `@yolk-sdk/agent` and `@yolk-sdk/codemode`, the at-least-once tool step guidance in `@yolk-sdk/vercel-workflows`, and the README updates in `@yolk-sdk/extractors`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.98

### Patch Changes

- def9f9c: Advance unchanged public packages in lockstep with the new `@yolk-sdk/extractors` package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.

## 0.1.0-canary.97

### Minor Changes

- 6567cc9: Add the experimental `@yolk-sdk/connectors/afloat/conformance` subpath: the Afloat target, seeds, and fixtures for the generic `@yolk-sdk/mcp/conformance` cases. It holds no case code and never imports `@yolk-sdk/mcp` (a devDependency for its tests only). `makeAfloatMcpConformanceTarget()` runs the real `afloat.mcp_auth` action over the host's `CredentialResolver` and answers the target value: `https://useafloat.com/mcp`, the modern `2026-07-28` era, `Authorization: Bearer <afloat_ key>`, and the public reserved invalid key `afloat_yolkconformanceinvalid0000` for the auth case. `afloatMcpConformanceLiveSeeds` name a published nine-tool subset of the provider's catalog (`afloatMcpConformanceTools`, in the provider's listing order: two invoice reads (`list-invoices`, `get-invoice`), five download-grant tools, and two receipt-upload tools, with the source's names, titles, schemas, and annotations; the descriptions and server instructions are rewritten generically) and the two tools that write, and no read tool; `afloatMcpConformanceFixtureSeeds` add a synthetic `list-invoices` call and invalid arguments. The eight fixtures (`afloatMcpConformanceFixtures`; every case but `mcp.legacy.session`, which does not apply to a modern server) are derived from the provider's source, not a live recording: the pinned official MCP server SDK run in-process with the provider's handler options over synthetic data, `evidence: 'unverified'`. The shared fixture credential scan and the runner's report sanitizer now also flag Afloat-shaped keys (`afloat_` followed by 16 or more letters and digits), as does the R2 emulator's copied token list. `@yolk-sdk/emulators/mcp` gains a third profile, `afloat`, on `https://useafloat.com/mcp`, answering the Afloat fixtures (copied as data in `mcpEmulatorAfloatFixtures`, with a drift test, including its two derived `tools/call` answers) with every existing guarantee (fail-closed constant refusals, the output guard, canonical recordings, three more unverified read rows); its credential rule recognises a bearer there only as `afloat_<remainder>` whose remainder is a recognisable bearer, and guards the remainder. New exports: `mcpEmulatorAfloatOrigin`, `mcpEmulatorAfloatPath`, `mcpEmulatorAfloatKeyPrefix`, `mcpEmulatorAfloatReservedInvalidCredential`, and `mcpEmulatorAfloatFixtures`. No case is observed live yet.
- b5c2b69: Upgrade the coordinated Effect runtime and platform dependencies to the stable Effect 4.0.0 release. Hosts must use the matching Effect version.

  Effect 4.0.0 removes the `effect/unstable/*` entrypoints: import from `effect/http`, `effect/socket`, `effect/sql`, `effect/process` and the other `effect/<area>` paths, and take `Arbitrary` from `effect`. The former `effect/Encoding` module is split into `effect/encoding/*` (for example `Base64.encode` from `effect/encoding/Base64`).

  Effect 4.0.0 exports `Schema.isPattern` to JSON Schema only when the regex flags are `u` (optionally with `d`, `g` or `y`; not `v`, and not `u` with `i`, `m` or `s`). Yolk's connector, emulator and conformance patterns now use `u`, so connector tool parameters keep their model-visible `pattern` hints with unchanged runtime validation; the Fortnox identifier pattern is advertised as its equivalent BMP-only character class. Add `u` to `Schema.isPattern` regexes in host tool parameter schemas to keep their patterns. String `Schema.isMinLength(n)` and the `Schema.isBetweenLength` minimum (n ≥ 2) are now advertised as `minLength: ceil(n / 2)`. See the migration guide.

## 0.1.0-canary.96

### Minor Changes

- c40cc6f: Add the experimental, Node-only `@yolk-sdk/emulators/github` subpath: `makeGithubEmulator`, a stateful emulator on the pinned `@emulators/core` custom runtime (loaded lazily) that follows the fixture-only rule. It serves exactly the GitHub REST routes the seven GitHub conformance cases send, on the recorded origin `https://api.github.com`: the label listing with the paging fixture's `Link` header (minted in its exact form; a listing that fits one page carries none), issue read (the recorded 404 for a number the repository has not reached), the issue search the validation fixture refuses (the recorded 422), file contents (base64 folded every 60 characters), comment create, listing `since`, and delete (then the recorded 404), issue label add and remove (the recorded 404 for a label not on the issue), and issue create, rename, and close as completed. It is seeded by default with the synthetic fixture entities, so the cases run unmodified; error bodies are the fixtures' byte for byte (`githubEmulatorErrorBodies`); created issue numbers and comment ids come from counters that only advance and start at the fixtures' created values. Anything the fixtures do not record answers a ledgered 400 not-emulated before anything is written or any fault is chosen, including the leftover lookup's open-issue listing (so `findGithubConformanceLeftovers` fails closed against it). It fails closed: a request is recognised only when its raw path is exactly an emulated route shape and any `Authorization` header is one recognisable bearer; every other request is ledgered and answered with constant text only. The bearer value is never stored, forwarded, ledgered, or echoed, and a path, query, or body that repeats it is refused. It adds status faults (400-599), clock-free error recovery, an `/_emulate/*` control plane, test-only drill knobs, and a route evidence manifest (`githubEmulatorRoutes`, all routes unverified; the six write routes are pending evidence until an owner-approved live run). The shared stateful wrapper gains an opt-in fail-closed mode (a bearer must match the RFC 6750 `b64token` syntax, start with a character that completes no escape, and hold a character outside the JSON-number alphabet `[0-9.eE+-]`, and a request that repeats it in its path, query, recorded headers, or body, found through the fixpoint closure of total, lexical percent-decoding and JSON-unescaping (a closure that hits its work cap counts as a repeat), is ledgered with constant text only), raw path-parameter patterns matched in full, multi-segment `{name+}` parameters, and constant-reason shape checks (`exactBodyKeys`, `exactQuery`); Dropbox and Notion are unchanged.

  Fix: consistent synthetic GitHub fixtures. The `github.labels.add-remove` fixture's repository label listing (`per_page=100`) now answers the same five labels as the `github.labels.list-link-paging` fixture, so one repository state answers every GitHub fixture.

- 4032176: Add the experimental, Node-only `@yolk-sdk/emulators/google` subpath: `makeGoogleEmulator`, a stateful emulator on the pinned `@emulators/core` custom runtime (loaded lazily) that follows the fixture-only rule. It serves exactly the Gmail, Calendar, and Drive routes the thirteen Google conformance cases and their cleanup use, each on its recorded origin (`https://gmail.googleapis.com` for Gmail and the multipart send upload, `https://www.googleapis.com` for Calendar and Drive): label listings with page tokens, message reads in the recorded `format` renderings, attachments, the label lifecycle, label changes, trash and untrash, the draft lifecycle and its thread, the practice send, Calendar range listings and the run event lifecycle (a deleted event stays readable as `cancelled`; a repeated delete answers the recorded 410), and Drive folder listings, file reads, and the run folder lifecycle. The practice send is only recorded in the state, never delivered, and only the recorded 7-bit message whose sole recipient is the seeded practice address (the recorded `practice@example.test`) is accepted; draft and send subjects take only a run id of the fixtures' 13-character length, since the recorded `sizeEstimate` covers the subject. Anything the fixtures do not record answers a ledgered 400 not-emulated before anything is written and before any fault is chosen, including an empty listing and every read of the leftover lookup, which therefore fails closed. The emulator uses the shared wrapper's existing opt-in fail-closed mode: an unrecognisable `Authorization` header or a request on no route shape is ledgered with constant text only, and the bearer value is never stored or ledgered, scrubbed from every refusal, and refused when the path, query, recorded `content-type` header, or body repeats it. The shared internal wrapper gains one backward-compatible, opt-in hook for this, `decodedViews`: a route may name decoded views of its raw body (the Google draft compose and update routes give the base64url-decoded MIME of `message.raw`, which Gmail's own wire format wraps), and in fail-closed mode each view is checked for the bearer like the raw body before anything is recorded, a fault is decided, or anything is committed. A view may throw to refuse a body it cannot check completely; the request is then ledgered as a constant entry: a credential repeat when the thrown `DecodedViewRefusal` carries cleanly decoded text holding the bearer, else the refusal's reason when the route declares it in `viewRefusalReasons` (constants the route owns, never derived from a request), else `the request body cannot be checked for the credential`. The Google draft routes refuse any `message.raw` that is not canonical unpadded base64url of exactly the recorded draft MIME with their own declared reasons (the 13-character run-id reason among them), so a refused `message.raw` never reaches the ledger. Routes without it, including every GitHub, Dropbox, and Notion route, are checked exactly as before. Includes status faults (400-599), clock-free error recovery, an `/_emulate/*` control plane, test-only drill knobs, and a route evidence manifest (`googleEmulatorRoutes`, all unverified; the fifteen write routes are pending until an owner-approved live run).
- 2df9ab3: Add the experimental, Node-only `@yolk-sdk/emulators/linkedin-search` subpath: `makeLinkedInSearchEmulator`, a stateful emulator on the pinned `@emulators/core` custom runtime (loaded lazily) that follows the fixture-only rule. It serves exactly the three reads the seven LinkedIn search conformance cases send, each on its recorded origin: the Exa people search (`POST /search` on `https://api.exa.ai`) and the Enrich Layer profile and email lookups (`GET /api/v2/profile` and `GET /api/v2/profile/email` on `https://enrichlayer.com`). Every answer is a fixture's, byte for byte, through the seed, and nothing is written, minted, or read from a clock: a search answers only the results the state holds for exactly its query and `numResults` (the default seed holds the fixtures' answers for `numResults` 10, 3, and 2), a profile lookup a held profile or, for the seeded absent profile, the recorded 404, an email lookup a held profile's recorded email, and a key the seed marks as rejected on an origin that origin's recorded 401 (by default the synthetic invalid keys the two unauthorized cases send). Anything else answers a ledgered 400 not-emulated before any fault is chosen. The emulator uses the shared wrapper's opt-in fail-closed mode exactly as `/github` and `/google` do (the recognisable-bearer rule, constant-text entries for unrecognised requests, unrecognisable `Authorization` headers, and credential repeats through the fixpoint closure, and the constant-reason `exactQuery` and `exactBodyKeys`). The shared internal wrapper gains one backward-compatible, opt-in, general option for it, `bearerDigest` (fail-closed mode only, refused at build otherwise): routes then see a one-way digest of the recognised bearer for the origin the request arrived on (`EmulatedRequest.bearerDigest`), never the bearer, and a digest that throws or repeats the bearer answers the 500 emulator error with no fault used. The LinkedIn search state holds only SHA-256 digests of the rejected keys per origin, so a key a request carries as its bearer, accepted or rejected, never reaches the state, the ledger, a response, or `/_emulate/*`, and seed errors are constant text (a category and a field path, such as `duplicate search at searches[1]`) that never quote a key or any other seed value. The wrapper's constant-reason `exactQuery` also gains a backward-compatible opt-in, `rawNames`: every raw query parameter name (before `URLSearchParams` decodes it) must be the plain name the route takes, so the LinkedIn search lookups refuse a percent-encoded name such as `%6cinkedin_profile_url`. Emulators without either option are unchanged. Includes status faults (400-599), an `/_emulate/*` control plane, test-only drill knobs (one per case), and a route evidence manifest (`linkedInSearchEmulatorRoutes`, all unverified reads, so no pending evidence entry).
- 6e1a00f: Add the experimental, Node-only `@yolk-sdk/emulators/mcp` subpath: `makeMcpEmulator`, a stateful emulator on the pinned `@emulators/core` custom runtime (loaded lazily) that follows the fixture-only rule for the two synthetic MCP servers of `@yolk-sdk/mcp/conformance`: profile `synthetic-modern` on `https://mcp.example.test/modern/mcp` (stateless `2026-07-28`, JSON answers) and profile `synthetic-legacy` on `https://mcp.example.test/legacy/mcp` (an `initialize` handshake with sessions, SSE answers). The sixteen synthetic fixtures are copied as data (`mcpEmulatorFixtures`; the emulator never imports `@yolk-sdk/*`). A JSON-RPC request is answered only when it equals a recorded request (only recorded methods per profile; `mcp-method` and `mcp-protocol-version` as recorded; params as recorded except JSON key order and the `_meta` client info's name and version), with the recorded bytes and the request id (an integer from 0 to 2^53 - 1, or 1 to 64 printable ASCII characters) substituted at exactly the recorded place. `initialize` mints `yolk-emu-session-<n>` from a counter that never resets (at most 256 sessions; `reset` and `seed` clear them), the standing `GET` answers the recorded 405 on a ready session, and the seed's `modernListing` selects the recorded one-page or two-page modern listing (its cursor issued per generation). The bearer is never stored, ledgered, or echoed: routes see only its digest, compared only with the public reserved invalid credential `yolk-conformance-invalid-credential-0000`, whose recorded 401 is answered byte for byte. Scope: the bearer is never copied from the request into a response, the state, or `/_emulate/*`; the output guard also refuses a prepared fixture answer, minted session id, or cursor that happens to contain it, but the emulator's other constants (state values such as `initializing`, wrapper headers such as `x-emulator-evidence`) and host-configured control-plane data (a fault body) may coincidentally equal a bearer and are not checked. Everything else (`DELETE`, `ping`, resources, prompts, batches, a JSON body repeating a key, `mcp-*` headers no recording carries, cursors not issued, other tools or arguments, a bearer repeated in any header, and a bearer an answer or minted session id or cursor would repeat) answers a 400 not-emulated, ledgered with constant text only, that writes nothing and uses up no fault. The manifest (`mcpEmulatorRoutes`) has one `RPC <origin><path>#<method>` row per recorded JSON-RPC method plus the `GET` row, all unverified reads, so no pending evidence entry. The shared internal wrapper gains backward-compatible opt-ins for it: route variants (one HTTP route answering several manifest rows); streamed commits whose answer the plan prepares, with `truncate-after-chunks` faults (`makeChunkedStatefulEmulator`) that send the prepared answer cut short and never run the commit, so a truncated request writes nothing (one that cannot apply answers 500 and is not used up); `constantRefusals`, `guardAllHeaders` (every request header name and value checked for a credential repeat), and `guardOutput` (a prepared answer or persisted value repeating the bearer is refused before any fault or write), all fail-closed mode only; `uniqueJsonKeys` (a JSON body repeating a key is refused); and `EmulatedRequest.headerNames`. One change reaches every stateful-wrapper emulator: the fault match schema shared by `DropboxFaultMatch`, `NotionFaultMatch`, `GithubFaultMatch`, `GoogleFaultMatch`, and `LinkedInSearchFaultMatch` gains an optional `route` (a manifest route template; a value naming no manifest row is rejected when the fault is added), and `match.method` is documented as the HTTP method. Emulators that take none of the opt-ins otherwise behave as before. Includes status and truncation faults, an `/_emulate/*` control plane, and test-only drill knobs (one per MCP case).
- 1b3021c: Add the experimental `@yolk-sdk/emulators/r2` subpath: `makeR2Emulator`, a fixture-driven in-memory fake backend for the host R2 ports `R2Presigner` and `R2ObjectClient` (no SigV4 signer, S3 client, or Node builtin), exposed as a plain-JSON `call(port, method, request)` that `r2PortsLayerFromBackend` from `@yolk-sdk/connectors/r2-storage/conformance` turns into both port layers. Answers come only from the R2 conformance fixtures (copied as data); a bucket seed decides which fixture answers and records the objects the absent-only and `If-Match` puts create or replace under the etags the fixtures name. It has a ledger, faults (applied only to calls a state-consistent fixture would answer), reset, coverage, and an unverified route manifest whose one write route is `PORT R2ObjectClient.put`. Anything the fixtures do not cover fails closed, and every refusal is ledgered with constant text only (no request text); the only request-shape latitude is ignoring credential fields and JSON key order. Credential fields are dropped before anything is compared or recorded. A put body must be canonical base64 of UTF-8 text (else `uncheckable-body`); it is checked as decoded text and ledgered only as its byte length. A request that repeats any value found under a credential field (of any length, keys and numbers included, raw or through percent, JSON, `\x`, or HTML-reference escapes), or carries a SigV4 credential parameter, another credential query parameter, a bearer token, or an API-key-shaped token anywhere else (the decoded body included), is refused as `credential-in-request`; an own `__proto__` key is `invalid-request`, and a request the checks cannot walk is `uncheckable-request`, so `call` never throws.

### Patch Changes

- 367aceb: Add classifier models (ADR 0003). The new `@yolk-sdk/agent/classification` subpath is a provider-neutral contract for models that answer typed questions about one `state` (a string, JSON object, or JSON array) with probabilities: Effect Schemas for `boolean`, `choice` (2-255 options), and `score` (2-10 levels) questions and their answers, `ClassificationRequest`, `ClassificationResult` with token usage and optional `costUsd`, the `ClassifierModel` service, a typed `classify` helper whose choice answers infer the union of their option keys, and typed errors (`ClassificationRequestInvalid`, `ClassificationProviderError`, `ClassificationResponseInvalid`, which keeps the billed usage). Every answer is checked against its question; probabilities are never renormalized.

  Add `@yolk-sdk/agent/providers/vercel/ai-gateway-classifier`: a `ClassifierModel` layer over AI Gateway `POST /v1/evaluate` (Gateway calls this evaluation) with `typesafe-ai/jev` by default and the same Gateway credential as the chat provider (`AI_GATEWAY_API_KEY`, falling back to `VERCEL_OIDC_TOKEN`). It passes `providerOptions` through, maps `providerMetadata.gateway.cost` to `usage.costUsd`, keeps `x-ai-gateway-evaluation-fallback-*` headers in `providerMetadata.evaluationFallbackHeaders`, reads confidence from the answer or `providerMetadata.typesafe.confidence`, and maps Gateway error envelopes to sanitized typed errors. It retries 408, 429, 5xx, and transport failures up to `maxRetries` times (default 2, configurable on the layer config; `0` disables) with exponential backoff and full jitter (base 250 ms, cap 4 s), or after `Retry-After` (delta-seconds or HTTP-date, capped at 10 s); other 4xx statuses and undecodable responses are never retried. Delays run on the Effect `Clock` (so `TestClock` drives them), interruption stops retrying, and the error after the last attempt keeps its typed shape and `retryable` flag. Code mode scripts reach a classifier through `makeClassifierTool` in `@yolk-sdk/codemode` (a `classify` function or `ClassifierModel` value, capped per script and per process); nested-call records carry its token usage only, and `costUsd` stays in the result's `structuredContent`.

  `@yolk-sdk/agent/providers/vercel/conformance` also exports four classifier `read` cases (boolean, choice, score, error envelope) with synthetic, unverified fixtures (`vercelAiGatewayClassifierConformanceCases`, `vercelAiGatewayClassifierConformanceFixtures`, `VercelAiGatewayClassifierConformanceConfig`), apart from the unchanged chat cases.

  `@yolk-sdk/emulators/gateway` answers the classifier route `POST /v1/evaluate` fixture-only from those recordings, with its own unverified manifest (`gatewayEvaluateEmulatorRoutes`), ledger, faults (for example a one-shot 429 with `retry-after`), scripted errors, and control plane (`emulator.evaluate`, `/_emulate/evaluate/*`). The chat route, its manifest, and its top-level APIs are unchanged; `GatewayEmulator` gains `evaluate`.

- a4ba6db: Add `PortFixture` to the experimental `@yolk-sdk/conformance/fixture` subpath: one recorded call through a host port that is not HTTP (`id`, `port`, `method`, a credential-free JSON `request`, exactly one of `response` or `failure`, optional `observed`), with `decodePortFixture`, `redactPortPayload`, `scanPortFixtureForSecrets`, and `conformanceFixtureEvidence`. The runner's `fixtures` option accepts port fixtures next to `WireFixture`s; `WireFixture` and HTTP replay are unchanged. Add the experimental `@yolk-sdk/connectors/email/conformance` subpath: ten port-level cases for the generic `EmailClient` (required headers without marking read, filtered listing without fallback, `\Drafts` discovery, `set_read`/`set_flag`, trash and untrash to INBOX, destination ids after a move with the stale source id answering the documented `message_not_found` failure code, POP3 rejections of every mutation action, Sent-copy statuses including the legacy synthesis, and SMTP acceptance that is not delivery), `EmailConformanceConfig` seeds, synthetic port fixtures, `makeEmailReplayBackend`, and `emailClientLayerFromBackend`, a testing-only bridge from a plain-JSON backend to `EmailClient`. Add the experimental `@yolk-sdk/emulators/email` subpath: `makeEmailEmulator`, a fixture-driven in-memory fake `EmailClient` backend (no socket, TLS, MIME, or mail library) with a mailbox seed, ledger, faults (applied only to calls a state-consistent fixture would answer), reset, coverage, and an unverified route manifest; anything the fixtures do not cover fails closed, and the only request-shape latitude is ignoring credentials and `connection.host`. Yolk still never speaks IMAP or SMTP; live verification needs a host `EmailClient` implementation.
- 00904fd: Add `@yolk-sdk/emulators/anthropic`: `makeAnthropicEmulator`, an experimental fetch-handler emulator of Anthropic Messages (`POST /v1/messages` on `https://api.anthropic.com`) with Messages SSE in the API's event order (`message_start`, `content_block_start` / deltas / `content_block_stop`, `ping`, `message_delta`, `message_stop`), `text`, `thinking`, and `tool_use` blocks (`text_delta`, `thinking_delta` + `signature_delta`, `input_json_delta`), `end_turn` / `tool_use` / `max_tokens` stops, the `message` JSON body, scripted turns, and the `{ type: 'error', error: { type, message } }` envelope (404 `not_found_error` for unknown models, 401 `authentication_error` without an `x-api-key` or bearer credential, neither of which is checked or stored). Requests without `anthropic-version: 2023-06-01`, or with `thinking` plus a forced `tool_choice`, get a 400 `invalid_request_error`. Faults include 429 with `retry-after`, 529 `overloaded_error`, a mid-stream `error` event (`error-event-after-chunks`), and truncation before `message_stop`. `anthropicEmulatorRoutes` is its unverified route evidence manifest linked to the new Anthropic Messages conformance cases. The Gateway and OpenAI emulators now share an internal emulator kernel with it; their API and wire behaviour are unchanged.

  Add `@yolk-sdk/agent/providers/anthropic/conformance`: five synthetic, unverified Anthropic Messages wire fixtures and five read-only conformance cases (streamed plain text, forced `tool_use` input-fragment assembly, thinking before text, the unknown-model error envelope, and `stop_reason: max_tokens` as a non-retryable invalid response) for native Messages, runnable against replay, an emulator, or a host-provided live `HttpClient` via `AnthropicConformanceConfig`.

- a816b34: Add the experimental, Node-only `@yolk-sdk/emulators/dropbox` and `@yolk-sdk/emulators/notion` subpaths: `makeDropboxEmulator` and `makeNotionEmulator`, stateful emulators on the pinned `@emulators/core` custom runtime (loaded lazily) that follow the fixture-only rule without exceptions. The Dropbox emulator serves the `/2/files` RPC routes the Dropbox conformance cases use (`list_folder` and `continue`, `get_metadata` with `include_deleted`, `search_v2` and `continue_v2`, `create_folder_v2`, `delete_v2`, `copy_v2`, `move_v2`) on `api.dropboxapi.com` and the `upload` route on `content.dropboxapi.com`, each only on its recorded origin (`fetchOn(origin)` serves one origin behind a loopback rewrite), with the fixtures' HTTP 409 `error_summary` envelopes byte for byte, case-insensitive paths, and strict upload rev preconditions. The Notion emulator serves the `/v1` routes the Notion conformance cases use at `Notion-Version: 2025-09-03` (search, the bot user, page read, the recorded create, archive, block children, paginated property items, and the database / data source split) with cursor paging and the fixtures' error envelopes, only on its recorded origin. Both are seeded by default with the synthetic fixture entities (entities a fixture only names are held as implied and never rendered) so the conformance cases run unmodified. Every answer value comes from a fixture or is a minted value (ids, revs, hashes, cursors, request ids, clock timestamps); cursors are accepted only when issued by the emulator for the same unchanged list since the last reset or seed, and no cursor value crosses a reset or seed. Everything else answers one ledgered 400 not-emulated, writes nothing, and uses up no fault: each route checks the request shape and then, reading the state without writing, its eligibility before a fault is decided. That includes an empty folder listing and a search without matches (no fixture records either), so the read-only leftover lookups fail against the default seeds and the runners print their lookup-failed WARN. Both add status faults (400-599), a credential-free ledger (credential-named keys in bodies, queries, and the `Dropbox-API-Arg` header are redacted), an `/_emulate/*` control plane, test-only drill knobs (one per case), and `dropboxEmulatorRoutes` / `notionEmulatorRoutes`, route evidence manifests linked to the conformance case ids (all routes unverified).
- 627f07a: Fault-status validation on the fixture-only emulators (Dropbox, Notion, GitHub, Google, LinkedIn search, MCP, and the fixture-only routes of OpenCode Go and subscription usage) now uses one 400-599 range check, as Todoist and Telegram always have. A rejected status names the range actually accepted (`Expected a value between 400 and 599`), where it previously named 200-599, said "400 or above", or (for a 204, 205, or 3xx status) gave that status's specific reason. The accepted statuses do not change.
- d8be3b8: Add the experimental, Node-only `@yolk-sdk/emulators/fortnox` subpath: `makeFortnoxEmulator`, a stateful Fortnox `/3` API emulator built on the upstream `@emulators/core` custom runtime (a new dependency pinned to exactly `0.12.0`, loaded lazily). It serves company information, customers, and invoices with rows (list, read, update, create, a synthetic PDF preview, and an email send that only records an outbox entry), seeded by default with the synthetic Fortnox fixture entities so the Fortnox conformance cases run unmodified, plus `default`, `empty-company`, and `no-booked-invoices` profiles. It reproduces the observed quirks the cases claim (sticky row discounts on positional row updates, empty customer strings that keep stored values, payment filters that skip unbooked invoices, lowercase `ErrorInformation` rejections, read-only customer `Country`), fails closed on unknown routes and unsupported inputs, and adds status faults, a credential-free ledger, an `/_emulate/*` control plane, and `fortnoxEmulatorRoutes`, its route evidence manifest linked to the Fortnox conformance case ids (all routes unverified). A `quirks` option flips each quirk for disagreement drills in tests.
- 1d50f98: Add the experimental, Node-only `@yolk-sdk/emulators/microsoft` subpath: `makeMicrosoftEmulator`, a stateful Microsoft Graph emulator on the pinned `@emulators/core` custom runtime (loaded lazily). It serves only the Graph v1.0 routes the Microsoft conformance cases use (calendar view with overlap filtering, event create/get/update/delete/cancel, folder message paging with an opaque `@odata.nextLink`, draft create/update/move with immutable ids, attachment listing and retrieval, `$batch` permanent delete, and OneDrive item read, children listing, folder create, delete, and file copy) plus the OneDrive copy monitor URL on a SharePoint origin, seeded by default with the synthetic Microsoft fixture entities so the Microsoft conformance cases run unmodified. Its behaviour comes only from the conformance fixtures, including their `@odata.context` envelopes; anything they do not show fails closed with the Graph error envelope, and the few extrapolations the cases need (plus one opt-in) are documented. For concurrent writes, the first write to reach the handler holds the message for `conflictWindowMs`; an overlapping write gets 409 `ErrorIrresolvableConflict`; non-overlapping writes both apply (an emulator extrapolation). It adds status faults, a credential-free ledger (credential-named body and query keys are redacted), an `/_emulate/*` control plane, test-only drill knobs, and `microsoftEmulatorRoutes`, its route evidence manifest linked to the Microsoft conformance case ids (all routes unverified). A Fortnox route handler that throws now answers an evidence-tagged 500 `ErrorInformation` recorded in the ledger, like the Microsoft emulator.
- 3ea5c06: Internal refactor: the Todoist and Telegram emulators now run on the same internal stateful wrapper
  as the Dropbox, Notion, GitHub, Google, LinkedIn search, and MCP emulators, through new opt-ins
  (a resolved mode, `json-or-empty` bodies, header-free ledger entries, recovery texts). The second
  wrapper is removed, and the emulators share one `@emulators/core` adapter. The other emulators do
  not change. Todoist and Telegram keep their answers, ledger entries, and control plane, with these
  exceptions:

  - A fault whose `match.route` names no manifest route is now rejected, both by `faults.add`
    (`TodoistEmulatorInputInvalid` / `TelegramEmulatorInputInvalid`) and by `POST /_emulate/faults`
    (400). Before, it was accepted and never matched anything.
  - Each request's eligibility check, fault decision, and commit now run atomically, so concurrent
    requests never interleave.

- 425c172: Add `@yolk-sdk/emulators/openai`: `makeOpenAiEmulator`, an experimental fetch-handler emulator of OpenAI Chat Completions (`POST /v1/chat/completions` on `https://api.openai.com`) with the OpenAI error envelope `{ error: { message, type, param, code } }` (404 `model_not_found` for unknown models, 401 `invalid_api_key` without a bearer credential), plus `openAiEmulatorRoutes`, its unverified route evidence manifest linked to the new OpenAI chat conformance cases. Reasoning models are not emulated for `/openai` yet. It shares an internal Chat Completions core with the Gateway emulator, whose API and wire behaviour are unchanged except that both ledgers now also record the output-token limit (`max_tokens` for the Gateway, `max_completion_tokens` for OpenAI) as `maxCompletionTokens`, without validating it.

  Add `@yolk-sdk/agent/providers/openai/conformance`: four synthetic, unverified OpenAI Chat Completions wire fixtures and four read-only conformance cases for the generic OpenAI-compatible chat provider (streamed plain text, tool-call argument assembly, the error envelope, and non-streamed JSON plain text) that run against replay, an emulator, or a host-provided live `HttpClient` via `OpenAiConformanceConfig`.

- 9f7aba3: Add `@yolk-sdk/emulators/opencode` (`makeOpenCodeGoEmulator`): one experimental, fixture-only fetch handler for `https://opencode.ai` answering the OpenCode Go routes under `/zen/go/v1` (`/chat/completions`, `/messages`, `/responses`, and `GET /usage`) with the recorded responses of the synthetic Go conformance fixtures. Requests that match a recorded request shape (within documented request-shape latitude) get the recorded response; anything else answers a ledgered 400 not-emulated. Each route keeps its own ledger, faults, scripted error turns, and control plane (`emulator.chat`, `.messages`, `.responses`, `.usage`; `/_emulate/<part>/*`), with combined coverage and reset and an unverified manifest (`openCodeGoEmulatorRoutes`).

  The Anthropic, Codex, and Grok emulators also answer their subscription-usage endpoints (`GET /api/oauth/usage`, `GET /backend-api/wham/usage`, `GET /v1/billing?format=credits`) with the recorded synthetic snapshot bodies, under the same fixture-only rule, through `emulator.usage` with separate unverified manifests. Model-route manifests and coverage are unchanged; the emulator types gain `usage` and a `subscriptionUsage` option (a replacement body with the recorded shape), and their `fetch` now answers those usage paths and `/_emulate/usage/*`.

  Add conformance cases: the new `@yolk-sdk/agent/providers/opencode/conformance` exports five synthetic, unverified fixtures and five read-only cases (streamed plain text on each Go protocol, the Responses commentary-phase replay, and the Go usage snapshot) with `OpenCodeGoConformanceConfig`; the Anthropic, OpenAI, and xAI conformance subpaths also export Claude, Codex, and Grok subscription-usage snapshot cases and fixtures (`anthropicClaudeUsageSnapshotCase`, `openAiCodexUsageSnapshotCase`, `xAiGrokUsageSnapshotCase` and their config services), which assert the normalized windows against the raw body so no window is fabricated or dropped. Existing case arrays and provider behaviour are unchanged.

- a3d642d: Add the experimental `@yolk-sdk/emulators` package (explicit subpaths only, no root export; runtime dependencies are `effect` and, for the stateful subpaths added in this release, the pinned `@emulators/core`; it never imports other `@yolk-sdk/*` packages). `./router` routes an Effect `HttpClient` to emulators by swapping layers: `EmulatedHttpClient.layer` rewrites routed origins to loopback emulator processes over the host's own client, and `InProcessHttpClient.layer` calls emulator fetch handlers directly. Both keep path and query, fail closed on unknown origins with an error naming only the origin, validate routes when built (loopback-only base URLs for the emulated client), and refuse to build when `NODE_ENV` is `production` or unreadable; the emulated client routes at the send step (so redirect follow-ups and host `mapRequest` changes are routed or fail closed) and sends with `redirect: 'manual'` over `FetchHttpClient`. `./gateway` adds `makeGatewayEmulator`, a plain fetch-handler emulator of the Vercel AI Gateway OpenAI-compatible `POST /v1/chat/completions` endpoint (streamed and JSON completions, DeepSeek-style reasoning, schema-synthesized tool calls, the error envelope, scripted turns, status / mid-stream / truncation faults that never redirect or send bodyless statuses, a credential-free request ledger, and an `/_emulate/*` control plane), plus `gatewayEmulatorRoutes`, its route evidence manifest linked to the Gateway conformance case ids; responses from unverified routes carry `x-emulator-evidence: unverified`. `./node` serves a fetch handler on `127.0.0.1` only (`serveFetchHandler` as a scoped Effect resource, `startFetchHandlerServer` as a Promise) and flushes streamed bodies chunk by chunk.
- ccc64a3: Add `@yolk-sdk/emulators/codex` (`makeCodexEmulator`, `POST /backend-api/codex/responses` on `https://chatgpt.com`) and `@yolk-sdk/emulators/xai` (`makeXAiGrokEmulator`, `POST /v1/responses` on `https://cli-chat-proxy.grok.com`): experimental fetch-handler emulators of the OpenAI Responses wire the Codex and Grok subscription providers use, on one shared Responses core and the emulator kernel. They stream typed `event:` server-sent events in the API's order (`response.created`, `response.in_progress`, per output item `response.output_item.added` / deltas / `response.output_item.done`, and `response.completed` with usage) with `reasoning` summary, `message` text, and `function_call` argument-delta items, answer `stream: false` with a completed `response` JSON body, and use the `{ error: { message, type, param, code } }` envelope (400 `model_not_found` for unknown models, 401 without a bearer credential, which is never checked or stored). `/codex` rejects `max_output_tokens`; `/xai` requires `X-XAI-Token-Auth` (401), `x-grok-client-version` (426), and `x-grok-model-override` (400). Scripted turns (including a JSON body for the providers' JSON fallback), faults (429 with `retry-after`, a mid-stream `error` or `response.failed` event, truncation before `response.completed`, dropped connections), the ledger, the control plane, and unverified route evidence manifests (`codexEmulatorRoutes`, `xAiGrokEmulatorRoutes`) work as for the other emulators.

  Add Responses conformance cases for the subscription providers: `@yolk-sdk/agent/providers/openai/conformance` now also exports four synthetic, unverified Codex fixtures and four read-only cases (`openAiCodexConformanceCases`, `OpenAiCodexConformanceConfig`), and the new `@yolk-sdk/agent/providers/xai/conformance` exports the same for Grok (`xAiGrokConformanceCases`, `XAiGrokConformanceConfig`): streamed plain text, `function_call` argument assembly, the unknown-model error envelope, and the terminal `response.completed` event, runnable against replay, an emulator, or a host-provided live `HttpClient`. Provider behaviour is unchanged.

- abaa7fd: Add the experimental, Node-only `@yolk-sdk/emulators/todoist` and `@yolk-sdk/emulators/telegram` subpaths: `makeTodoistEmulator` and `makeTelegramEmulator`, stateful emulators on the pinned `@emulators/core` custom runtime (loaded lazily) that follow the fixture-only rule. Todoist serves the API v1 routes the Todoist conformance cases and their cleanup use (task listing with REST v1 cursor paging, task create/read/update/close, label listing, project create/read/delete with run-scoped `yolk-conformance-run-*` case projects; the leftover lookup's project listing has no fixture, so it answers 400 not-emulated and the lookup fails closed); Telegram serves `getChat`, `getFile`, the hosted file download, and `sendMessage` (recorded in its state, never delivered). Both are seeded by default with the synthetic fixture entities so the conformance cases run unmodified; anything the fixtures do not record answers a ledgered 400 not-emulated (nothing is synthesised: seeded Todoist projects are never answered, and only items created through the recorded create flow are written), the request and state are checked before any fault is chosen (a refused request never uses a fault), and the documented request-shape latitude is the only accepted deviation. Created Todoist ids use a reserved `6XEmu` prefix that seeds may not use. Both fail closed: a request is recognised only when its raw path is exactly an emulated route shape (and, for Todoist, any `Authorization` header is one recognisable bearer), and every other request is ledgered and answered with constant text only (`/<unrecognised>`, no query or body, a constant reason). The Telegram bot token travels in the URL path: it is required but never stored, forwarded, ledgered, or echoed (for a recognised request it is taken from its exact path segment, the token and its secret part are scrubbed from the ledger and every refusal, and a query, path, or body that repeats them, JSON-escaped strings and normalised numbers included, is refused); the Todoist bearer value is guarded the same way. Both add status faults (400-599), a credential-free ledger, clock-free error recovery, an `/_emulate/*` control plane, test-only drill knobs, and route evidence manifests (`todoistEmulatorRoutes`, `telegramEmulatorRoutes`) linked to the conformance case ids (all routes unverified).

  Fix: consistent synthetic Todoist fixtures. The `todoist.labels.task-labels-are-names` fixture now answers the labeled task in the work project (`6XSyntheticWork0`), since the paging fixture's listing of the paging project never includes it.

- 0efc3fc: Fortnox and Microsoft Graph emulators now check eligibility before using up a fault (plan → fault →
  commit), like the later stateful emulators. Before, a request the route refused could use up a
  matching fault. That covered a provider-envelope 404 for an unknown id, a 400 for an invalid state
  or a value the route does not emulate, and a Microsoft 409 conflict. Each refusal is still answered
  and ledgered as before, but now leaves the fault for the next request the route would answer
  successfully. A faulted request still writes nothing. On Microsoft Graph it also creates no copy
  monitor and holds no message for the conflict window. A route handler that throws partway now
  writes nothing too.
- 6d3b497: The `@yolk-sdk/emulators/gateway` emulator now follows the verified live Vercel AI Gateway recordings, and `gatewayEmulatorRoutes` is `verified` (`observedAt: '2026-09-30'`), so Gateway responses no longer carry `x-emulator-evidence: unverified`. Streamed completions send a `{ role: 'assistant' }` opening delta, `logprobs: null` on every choice, `system_fingerprint` on every chunk, and one finish event whose delta carries a synthetic `provider_metadata` (the recorded upstream entry, `openai` for `openai/*` models or `baseten` for `deepseek/*` models, then `gateway`) and which carries the Gateway-shaped `usage` (when `stream_options.include_usage` is set), `service_tier` (for `openai/*` models), and `generationId`, followed only by `data: [DONE]`; there is no separate usage chunk any more. Several SSE events are packed into each network chunk: the new `eventsPerChunk` option (default `gatewayEmulatorDefaultEventsPerChunk`, 2; 1 restores one event per chunk) packs from the end so the finish event and `data: [DONE]` share the last chunk, and chunk faults count these network chunks. Reasoning streams as `delta.reasoning` with `delta.reasoning_details` (scripted `reasoningField` now defaults to `reasoning`; `reasoning_content` is still accepted). The non-streamed `chat.completion` body (not covered by a recording) now carries the same Gateway-shaped `usage` with its cost fields, and reasoning as `message.reasoning` instead of `message.reasoning_content`. Unknown models get the recorded 404 `{ error: { message: "Model '<id>' not found", type: 'model_not_found', param: { modelId } } }` without `code` (was 400 `invalid_request_error` / `model_not_found`). `deepseek/deepseek-v4.1-flash` joins the default known and reasoning models. `GatewayEmulatorInputInvalid` now also reports an invalid `eventsPerChunk` (`input: 'options'`). The `/openai` emulator's wire is unchanged.

  `vercelAiGatewayConformanceDefaultModels.reasoning` is now `deepseek/deepseek-v4.1-flash`, the model the verified DeepSeek fixture was recorded with, so the default model ids now match every committed Gateway fixture.
