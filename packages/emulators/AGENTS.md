# Emulators Package

`@yolk-sdk/emulators` is an **experimental** package of emulators for outside services and the
Effect `HttpClient` routing that points code at them.

## Subpaths

| Subpath                               | Source                                   | Role                                                                                                                                                                                                                                                                          |
| ------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@yolk-sdk/emulators/router`          | `src/router.ts`                          | `EmulatorRoute`, `EmulatedHttpClient.layer`, `InProcessHttpClient.layer`                                                                                                                                                                                                      |
| `@yolk-sdk/emulators/gateway`         | `src/gateway.ts`                         | Vercel AI Gateway fetch-handler emulator and its route evidence manifest                                                                                                                                                                                                      |
| `@yolk-sdk/emulators/openai`          | `src/openai.ts`                          | OpenAI Chat Completions fetch-handler emulator and its manifest                                                                                                                                                                                                               |
| `@yolk-sdk/emulators/anthropic`       | `src/anthropic.ts`                       | Anthropic Messages fetch-handler emulator and its manifest                                                                                                                                                                                                                    |
| `@yolk-sdk/emulators/codex`           | `src/codex.ts`                           | ChatGPT Codex Responses fetch-handler emulator and its manifest                                                                                                                                                                                                               |
| `@yolk-sdk/emulators/xai`             | `src/xai.ts`                             | xAI Grok CLI proxy Responses fetch-handler emulator and its manifest                                                                                                                                                                                                          |
| `@yolk-sdk/emulators/opencode`        | `src/opencode.ts`                        | OpenCode Go emulator (chat, Messages, Responses, usage under `/zen/go/v1`) and its manifest                                                                                                                                                                                   |
| `@yolk-sdk/emulators/email`           | `src/email.ts`                           | Fixture-driven fake `EmailClient` backend (plain JSON `call`), its seed, faults, ledger, and manifest                                                                                                                                                                         |
| `@yolk-sdk/emulators/r2`              | `src/r2.ts`                              | Fixture-driven fake `R2Presigner` and `R2ObjectClient` backend (plain JSON `call`), its seed, faults, ledger, and manifest                                                                                                                                                    |
| `@yolk-sdk/emulators/node`            | `src/node.ts`                            | `serveFetchHandler` / `startFetchHandlerServer` on `127.0.0.1`                                                                                                                                                                                                                |
| `@yolk-sdk/emulators/fortnox`         | `src/fortnox.ts`                         | Stateful Fortnox emulator on `@emulators/core`: ledger, faults, control plane                                                                                                                                                                                                 |
| `@yolk-sdk/emulators/microsoft`       | `src/microsoft.ts`                       | Stateful Microsoft Graph emulator on `@emulators/core` (Graph + copy monitor)                                                                                                                                                                                                 |
| `@yolk-sdk/emulators/dropbox`         | `src/dropbox.ts`                         | Stateful, fixture-only Dropbox emulator on `@emulators/core` (RPC + upload)                                                                                                                                                                                                   |
| `@yolk-sdk/emulators/notion`          | `src/notion.ts`                          | Stateful, fixture-only Notion emulator on `@emulators/core` (`/v1`, `Notion-Version: 2025-09-03`)                                                                                                                                                                             |
| `@yolk-sdk/emulators/todoist`         | `src/todoist.ts`                         | Stateful, fixture-only Todoist API v1 emulator on `@emulators/core` (tasks, labels, projects; cursor paging)                                                                                                                                                                  |
| `@yolk-sdk/emulators/telegram`        | `src/telegram.ts`                        | Stateful, fixture-only Telegram Bot API emulator on `@emulators/core` (token in the path, never kept; sends recorded in state)                                                                                                                                                |
| `@yolk-sdk/emulators/github`          | `src/github.ts`                          | Stateful, fixture-only GitHub REST emulator on `@emulators/core` (issues, comments, labels, contents; fail closed; minted `Link`)                                                                                                                                             |
| `@yolk-sdk/emulators/google`          | `src/google.ts`                          | Stateful, fixture-only Gmail, Calendar, and Drive emulator on `@emulators/core` (two origins; fail closed; the practice send recorded in state)                                                                                                                               |
| `@yolk-sdk/emulators/linkedin-search` | `src/linkedin-search.ts`                 | Stateful, fixture-only Exa and Enrich Layer emulator on `@emulators/core` (two origins; fail closed; reads only; rejected keys kept as per-origin digests)                                                                                                                    |
| `@yolk-sdk/emulators/mcp`             | `src/mcp.ts`                             | Stateful, fixture-only synthetic MCP servers on `@emulators/core` (modern and legacy profiles; JSON-RPC rows; fail closed, constant refusals; minted sessions)                                                                                                                |
| (internal)                            | `src/emulator-kernel.ts`                 | Shared kernel: faults, scripted turns, ledger, pull-driven bodies, control plane, evidence tagging, route binding (`makeEmulatorKernel`)                                                                                                                                      |
| (internal)                            | `src/chat-completions.ts`                | Shared OpenAI-compatible Chat Completions core (`makeChatCompletionsEmulator`)                                                                                                                                                                                                |
| (internal)                            | `src/messages.ts`                        | Anthropic Messages core (`makeMessagesEmulator`)                                                                                                                                                                                                                              |
| (internal)                            | `src/responses.ts`                       | OpenAI Responses core (`makeResponsesEmulator`) shared by `/codex` and `/xai` (not `/opencode`, which is fixture-only)                                                                                                                                                        |
| (internal)                            | `src/fixture-route.ts`                   | Fixture-only route core (`makeFixtureRouteEmulator`): recorded answers, 400 not-emulated otherwise; used by every Go and usage route                                                                                                                                          |
| (internal)                            | `src/subscription-usage.ts`              | Subscription-usage `GET` routes on the fixture-only core (`makeSubscriptionUsageEmulator`) for Claude, Codex, Grok, and Go                                                                                                                                                    |
| (internal)                            | `src/*-recordings.ts`                    | Go and usage fixture exchanges copied as data (`opencode-recordings.ts`, `subscription-usage-recordings.ts`)                                                                                                                                                                  |
| (internal)                            | `src/emulator-compose.ts`                | Path dispatch of several kernel-built parts behind one origin (`composeFetch`, `withSubscriptionUsage`)                                                                                                                                                                       |
| (internal)                            | `src/emulator-http.ts`                   | Shared fault/scripted-error status and header validators (all emulators)                                                                                                                                                                                                      |
| (internal)                            | `src/route-evidence.ts`                  | `EmulatorRouteEvidence`, the evidence header, `bindRouteHandlers`                                                                                                                                                                                                             |
| (internal)                            | `src/email-fixtures.ts`                  | Verbatim data copy of the email conformance `PortFixture`s (re-exported as `emailEmulatorFixtures`)                                                                                                                                                                           |
| (internal)                            | `src/r2-fixtures.ts`                     | Verbatim data copy of the R2 conformance `PortFixture`s (re-exported as `r2EmulatorFixtures`)                                                                                                                                                                                 |
| (internal)                            | `src/r2-guard.ts`                        | R2 credential guard: copied credential key, parameter, and token lists (one test sample each), R2 decodings, repeat checks                                                                                                                                                    |
| (internal)                            | `src/fortnox/state.ts`                   | Fortnox state/seed schemas, default seed (fixture entities), profiles, totals                                                                                                                                                                                                 |
| (internal)                            | `src/fortnox/api.ts`                     | Fortnox route table (evidence + handlers), quirks, `ErrorInformation` codes                                                                                                                                                                                                   |
| (internal)                            | `src/microsoft/state.ts`                 | Microsoft state/seed schemas, default seed (fixture entities), profiles, instants                                                                                                                                                                                             |
| (internal)                            | `src/microsoft/api.ts`                   | Microsoft route table (evidence, query allowlist, auth flag), matching, registration                                                                                                                                                                                          |
| (internal)                            | `src/microsoft/graph.ts`                 | Graph error envelope and codes, `$select`, paging/nextLink, `Prefer`, handler types                                                                                                                                                                                           |
| (internal)                            | `src/microsoft/{calendar,mail,drive}.ts` | Calendar, Outlook (with `$batch`), and OneDrive (with copy monitor) handlers                                                                                                                                                                                                  |
| (internal)                            | `src/stateful-emulator.ts`               | Shared wrapper of `/dropbox`, `/notion`, `/todoist`, `/telegram`, `/github`, `/google`, `/linkedin-search`, `/mcp`: routes, shape checks, 400 not-emulated, faults, ledger, control plane; opt-ins (fail-closed, resolved mode, digest, variants, truncation; no core import) |
| (internal)                            | `src/stateful-core.ts`                   | The `@emulators/core` adapter every subpath on the stateful wrapper passes as `createCore` (`statefulCoreRuntime`; Node-only, loads the core lazily)                                                                                                                          |
| (internal)                            | `src/dropbox/{state,api}.ts`             | Dropbox state/seed schemas and default seed; route table, fixture error envelopes, metadata, cursors                                                                                                                                                                          |
| (internal)                            | `src/notion/{state,api}.ts`              | Notion state/seed schemas and default seed; route table, error envelopes, object rendering, cursor paging                                                                                                                                                                     |
| (internal)                            | `src/stateful-secrets.ts`                | Credential guarding (`repeatsSecret`, `jsonRepeatsSecret`, `textRepeatsSecret`, `textClosureOutcome`, `scrubSecrets`) and unrecognised-ledger constants; used by the stateful wrapper and `src/r2-guard.ts`                                                                   |
| (internal)                            | `src/todoist/{state,api}.ts`             | Todoist state/seed schemas and default seed (fixture entities); route table, matching, handlers, drills                                                                                                                                                                       |
| (internal)                            | `src/telegram/{state,api}.ts`            | Telegram state/seed schemas and default seed (fixture entities); route table, token-aware resolution, handlers, drills                                                                                                                                                        |
| (internal)                            | `src/github/{state,api}.ts`              | GitHub state/seed schemas and default seed (fixture entities); route table with raw parameter patterns, error bodies, `Link` paging, drills                                                                                                                                   |
| (internal)                            | `src/google/state.ts`                    | Google state/seed schemas, default seed (fixture entities, implied entities), minted id forms                                                                                                                                                                                 |
| (internal)                            | `src/google/shared.ts`                   | Google origins, env, drills, response and error-envelope helpers, run-scoped text, page tokens                                                                                                                                                                                |
| (internal)                            | `src/google/{gmail,calendar,drive}.ts`   | Gmail, Calendar, and Drive route tables with raw parameter patterns (evidence, request shapes, plans, commits)                                                                                                                                                                |
| (internal)                            | `src/linkedin-search/{state,api}.ts`     | LinkedIn search state/seed schemas, default seed (fixture entities), per-origin key digests; Exa and Enrich Layer route table, error bodies, drills                                                                                                                           |
| (internal)                            | `src/mcp/{state,api,recordings}.ts`      | MCP state/seed schemas, profiles, minted forms, digest; JSON-RPC route table (rows, matching, id/session/cursor substitution, drills); the 16 fixtures as data                                                                                                                |

There is no root export or barrel.

## Boundaries

- Dependencies: `effect`, and `@emulators/core` pinned EXACT (`0.12.0`, no caret) for stateful
  connector and MCP emulators only. `src` never imports `@yolk-sdk/*`, React, or Next
  (`scripts/check-package-boundaries.ts` enforces this). Tests may import `@yolk-sdk/agent`,
  `@yolk-sdk/conformance`, `@yolk-sdk/connectors`, and `@yolk-sdk/mcp` (workspace
  devDependencies); connectors never import emulators.
- `node:` builtins and `@emulators/core` (Node-only: it imports Node builtins and reads files at
  import time) are allowed only in `src/node.ts`, `src/fortnox.ts`, `src/fortnox/**`,
  `src/microsoft.ts`, `src/microsoft/**`, `src/dropbox.ts`, `src/dropbox/**`, `src/notion.ts`,
  `src/notion/**`, `src/todoist.ts`, `src/todoist/**`, `src/telegram.ts`, `src/telegram/**`,
  `src/github.ts`, `src/github/**`, `src/google.ts`, `src/google/**`, `src/linkedin-search.ts`,
  `src/linkedin-search/**`, `src/mcp.ts`, `src/mcp/**`, and `src/stateful-core.ts` (also
  enforced). `src/fortnox.ts` and `src/microsoft.ts` import the core lazily (`await import`) inside
  their `make*Emulator`; `src/dropbox.ts`, `src/notion.ts`, `src/todoist.ts`, `src/telegram.ts`,
  `src/github.ts`, `src/google.ts`, `src/linkedin-search.ts`, and `src/mcp.ts` do it through the
  shared adapter `statefulCoreRuntime` (`src/stateful-core.ts`), which imports it lazily when their
  `make*Emulator` (`makeDropboxEmulator`, `makeNotionEmulator`, `makeTodoistEmulator`,
  `makeTelegramEmulator`, `makeGithubEmulator`, `makeGoogleEmulator`, `makeLinkedInSearchEmulator`,
  `makeMcpEmulator`) builds the runtime. So importing a subpath (for example the manifest, from the
  evidence check) has no side effects. The one shared stateful wrapper, `src/stateful-emulator.ts`,
  never imports the core: each subpath hands it the runtime (issue #139 merged the second wrapper,
  `src/stateful-fixture.ts`, into it). Its credential guarding and unrecognised-ledger constants
  live in `src/stateful-secrets.ts`, which imports no wrapper; the `/r2` port emulator also imports
  it (`textClosureOutcome`, through `src/r2-guard.ts`). Build every new fixture-only stateful
  emulator on `src/stateful-emulator.ts` (as `/github`, `/google`, `/linkedin-search`, and `/mcp`
  are, in its opt-in fail-closed mode); a guarantee it lacks is added as an opt-in that leaves the
  other emulators unchanged (shared helpers go to `src/stateful-secrets.ts`), with tests
  (`test/stateful-emulator.test.ts`), never as a second wrapper.
- `router` is Effect code; `gateway`, `openai`, `anthropic`, `codex`, `xai`, and `opencode` are
  plain Web fetch handlers (no Effect runtime needed, no Node builtins); `email` and `r2` are plain
  structural objects (no HTTP, socket, TLS, MIME, mail library, SigV4 signer, or S3 client); `node`,
  `fortnox`, `microsoft`, `dropbox`, `notion`, `todoist`, `telegram`, `github`, `google`,
  `linkedin-search`, and `mcp` are the Node subpaths.
- No top-level side effects, env reads, or network calls. `NODE_ENV` is read with `Config` inside
  `Effect.gen` when a router layer builds.
- `@emulators/core` is Apache-2.0 and a dependency (not vendored or bundled; `tsdown` never bundles
  `@emulators/*`); the README carries the attribution. Upgrading it is a deliberate, reviewed bump
  of the exact pin.

## Design rules

- Routing is Effect DI: interchangeable `HttpClient` layers. Emulated (loopback rewrite over the
  host client) and InProcess (direct handler call) live here; Replay lives in
  `@yolk-sdk/conformance/replay`; Live is the host's own client.
- Both router layers fail closed on unknown origins with an `HttpClientError` whose attached
  request and message carry only the method and origin, never path, query, headers, or body.
  Both refuse to build when `NODE_ENV` is `production` (missing is allowed; unreadable fails).
- `EmulatedHttpClient` validates at build time that every base URL is http(s) on loopback
  (`127.0.0.0/8`, `::1`, `localhost`; IPv4-mapped IPv6 such as `[::ffff:127.0.0.1]` is rejected)
  without credentials, query, or hash.
- `EmulatedHttpClient` routes in the client's postprocess (the send step), never in preprocess, so
  redirect follow-ups and a host's `mapRequest` go through the route table. Over `FetchHttpClient`
  it sends with `redirect: 'manual'`, merging `RequestInit` defaults visible at build and request
  time; `followRedirects` belongs on top, never underneath; any other underlying client must not
  follow redirects by itself (documented for hosts). `test/router-redirects.test.ts` guards this.
- Wire shapes come from the conformance fixtures (the Gateway ones are verified live recordings and
  the Gateway route is `verified`, with `test/gateway-recordings.test.ts` comparing the emulator's
  response shapes with them; the OpenAI, Anthropic, Codex, Grok, OpenCode Go, and subscription-usage
  ones are synthetic placeholders), copied as data, never imported. Each emulated route lists the
  conformance case ids it follows in its manifest (`gatewayEmulatorRoutes`, `openAiEmulatorRoutes`,
  `anthropicEmulatorRoutes`, `codexEmulatorRoutes`, `xAiGrokEmulatorRoutes`,
  `openCodeGoEmulatorRoutes`, `anthropicSubscriptionUsageEmulatorRoutes`,
  `codexSubscriptionUsageEmulatorRoutes`, `xAiGrokSubscriptionUsageEmulatorRoutes`,
  `fortnoxEmulatorRoutes`, `microsoftEmulatorRoutes`, `dropboxEmulatorRoutes`,
  `notionEmulatorRoutes`, `todoistEmulatorRoutes`, `telegramEmulatorRoutes`, `githubEmulatorRoutes`,
  `googleEmulatorRoutes`, `linkedInSearchEmulatorRoutes`, `mcpEmulatorRoutes`). Each manifest route
  needs its own handler: the fetch-handler emulators use `bindRouteHandlers`
  (`src/route-evidence.ts`), which pairs them at construction and throws `EmulatorRouteUnmapped` for
  a manifest route without a handler or a handler without a manifest route; Fortnox, Microsoft,
  Dropbox, Notion, Todoist, Telegram, GitHub, Google, LinkedIn search, and MCP derive both from one
  table (`src/fortnox/api.ts`, `src/microsoft/api.ts`, `src/dropbox/api.ts`, `src/notion/api.ts`,
  `src/todoist/api.ts`, `src/telegram/api.ts`, `src/github/api.ts`, `src/google.ts` over
  `src/google/{gmail,calendar,drive}.ts`, `src/linkedin-search/api.ts`, and `src/mcp/api.ts`, whose
  routes list their JSON-RPC rows as variants). Fortnox routes without a fixture
  (`GET /3/companyinformation`, `GET /3/customers`) cite no case ids and use minimal shapes named
  after the connector's read fields; the check warns about them. The fixture-only `/todoist`,
  `/telegram`, `/github`, `/google`, `/linkedin-search`, and `/mcp` emulators never add a route
  without a fixture: every route cites a case (the Todoist leftover lookup's `GET /api/v1/projects`,
  the GitHub one's `GET /repos/{owner}/{repo}/issues`, and the Google one's Gmail label listing,
  draft search, free-text event query, and trashed-included Drive listing have no fixture, so they
  are not emulated and the lookups fail closed until a fixture records them).
- Fixture-only rule (lasting; every new emulator and route follows it, without exceptions):
  response behaviour comes only from the committed fixtures. A request matching a recorded request's shape, within the
  documented request-shape latitude, gets that fixture's response, copied as data (default content
  equals the fixture byte for byte); everything else (unknown routes and methods, missing or
  invalid credentials, missing or other headers and query parameters, unknown models, non-streamed
  modes, tools, reasoning, extra fields, anything no fixture records) answers one ledgered 400
  not-emulated (`{ error: { type: 'not_emulated', message } }`, `notEmulated` in the ledger) and
  uses up no fault or turn. No guessed provider status, envelope, or error code. Test controls stay
  within the shared kernel faults and scripted error turns; a scripted or default replacement body
  must keep the recorded JSON shape. A recordings-parity test per fixture
  (`test/fixture-recordings.test.ts`) compares status, event kinds and order, field names, and
  content. Scope: the four `/opencode` routes and the three subscription-usage routes (Claude,
  Codex, Grok) today, on `src/fixture-route.ts`, the `/email` port emulator (its own
  latitude, not-emulated answer, faults, and parity test, below; it does not use the kernel), and
  the stateful `/dropbox`, `/notion`, `/github`, `/google`, `/linkedin-search`, and `/mcp` emulators
  and `/todoist` and `/telegram` emulators (all on `src/stateful-emulator.ts`; each with its own
  latitude and drift tests, below). The earlier model routes (`/gateway`, `/openai`,
  `/anthropic`, `/codex`, `/xai` Messages and Responses) predate the rule and keep their synthetic
  behaviour and 404 fallback unchanged; do not copy that behaviour into new routes. The stateful
  `/fortnox` and `/microsoft` emulators predate the rule and are not fixture-only: they keep entity state on
  `@emulators/core`, answer unknown routes with a ledgered 404 in the provider's error envelope, and
  fail closed on anything not emulated (below).
- Request-shape latitude (fixture-only HTTP routes, the only accepted deviations): any credential
  value (never checked or stored); extra request headers; JSON key order; any string value except the
  discriminators `model`, `role`, `type`, and `phase`; any positive integer where the recording has
  a number (the output-token limit); for `anthropic-beta` (Claude usage), a comma-separated list
  that includes `oauth-2025-04-20`; any non-empty `x-userid` and `x-grok-client-version` (Grok
  usage); for `content-type`, media-type parameters. Everything else must
  equal the recording: object keys, array lengths, booleans (`stream`, `store`, `include_usage`,
  `parallel_tool_calls`, `additionalProperties`), the `accept` value, the query string (a bare `?` counts as no query;
  otherwise byte for byte), the method,
  and the headers the SDK sends (Go chat, Responses, usage: Bearer; Go Messages: `x-api-key` and
  `anthropic-version: 2023-06-01`; Claude usage: Bearer and `anthropic-beta`; Codex usage: Bearer
  and `ChatGPT-Account-Id`; Grok usage: Bearer, `X-XAI-Token-Auth: xai-grok-cli`, `x-userid`,
  `x-grok-client-version`, and `x-grok-client-mode: headless`). Fault and scripted-error statuses on
  fixture-only routes are 400-599 only.
- Evidence policy: unknown emulated API routes fail closed and are written to the ledger (404 JSON
  on the earlier model-route emulators, `/fortnox`, and `/microsoft`, 400 not-emulated on
  fixture-only routes, `/dropbox`, `/notion`, `/todoist`, `/telegram`, `/github`, `/google`,
  `/linkedin-search`, and `/mcp`; control-plane requests are never recorded); unverified routes
  answer but carry `x-emulator-evidence: unverified` (the `/email` port emulator has no headers: its
  ledger entries carry `evidence`), are tagged in the ledger, and are listed by the evidence check;
  evidence older than 30 days warns; connector write routes need `verified` evidence with a
  readable, not-future `observedAt` and at least one cited case, and a verified route fails when
  none of its cited cases has a `verified` fixture (the check fails otherwise, except for pending
  entries below).
- Pending evidence: `scripts/emulator-evidence-pending.json` is the only way to keep an unverified
  connector write route from failing the check, and only until its `expires` date (a PENDING
  warning, reported first). Never weaken the rule, extend an expiry silently, or add an entry
  without a reason; verify the route with an owner-approved live run and delete the entry (the
  check warns about stale entries). An expiry more than 60 days away fails. The eight `/email`
  write routes are pending (tracking #115), and so are the four Fortnox write routes, the eleven
  Microsoft write routes, the five Dropbox write routes, the two Notion write routes, the five
  Todoist write routes, the Telegram `sendMessage` route, the six GitHub write routes, and the
  fifteen Google write routes (the three `/linkedin-search` routes and the nine `/mcp` rows are
  reads and need none); expiry dates live only in that file.
  A new entry expires at most 60 days out and its reason cites tracking #115 and names the
  owner-approved live run (`live run of <case ids>`).
  204, 205, and 3xx; header names/values are validated and `location` is rejected when a fault or
  turn is added. Route statuses follow the fixtures instead (for example a bodiless 204, or a 202
  with a monitor `Location`). All emulators share these validators (`src/emulator-http.ts`,
  internal, no Node builtins). Build a response before consuming its fault; a response that cannot
  be built, or a stateful route handler that throws, answers an evidence-tagged 500 in the
  service's error envelope, recorded in the ledger (`responseError`); that recovery never depends
  on the injectable clock (a clock that throws falls back to a fixed synthetic date). The
  fixture-only `/dropbox`, `/notion`, `/todoist`, `/telegram`, `/github`, `/google`,
  `/linkedin-search`, and `/mcp` answer `{ error: { type: 'emulator_error' } }` instead and their
  recovery reads no clock at all (see below).
- Every model and fixture-route fetch-handler emulator is built on `src/emulator-kernel.ts` (the
  `/email` port emulator is not; the stateful `/fortnox` and `/microsoft` keep their own wrappers,
  `/dropbox`, `/notion`, `/todoist`, `/telegram`, `/github`, `/google`, `/linkedin-search`, and
  `/mcp` share `src/stateful-emulator.ts`; see below): fault and scripted-turn state (strict
  decoding), the ledger, pull-driven bodies with
  `error-after-chunks` / `truncate-after-chunks`, status-fault and scripted-error responses, the
  `/_emulate/*` control plane, coverage, evidence tagging, and route binding (`serve` throws
  `EmulatorRouteUnmapped`). Wire cores add only request parsing, framing, their ledger fields, and
  wire-specific faults; do not re-implement kernel pieces in a core.
- OpenAI-compatible Chat Completions emulators share `src/chat-completions.ts`: request parsing,
  SSE framing, JSON mode, and scripted completions on top of the kernel. Each subpath supplies only its path and manifest, model lists, error envelope
  and unknown-model status and error (or whole body), 401 error, completion-token field (recorded in the ledger as
  `maxCompletionTokens`, never validated), whether reasoning is emulated, its turn schema, its
  input-invalid error, and its wire profile (`ChatWireProfile`; omitted is the plain OpenAI wire).
  The Gateway profile must match its verified recordings structurally (keys and value types; values synthetic);
  the wire fields it sends are listed once in `README.md` (Gateway emulator). Any core
  change is a profile or config parameter: keep the OpenAI wire unchanged (`test/openai.test.ts`
  and `test/openai-conformance.test.ts` are the guards) and the Gateway matching its recordings
  (`test/gateway.test.ts`, `test/gateway-recordings.test.ts`). `/openai` does not emulate reasoning yet: its turn
  schema rejects reasoning fields and `/_emulate/state` omits `reasoningModels`.
- `/anthropic` uses `src/messages.ts`: Messages request parsing (`model`, a positive integer
  `max_tokens` or 400, `system`, `messages`, `tools`, `tool_choice`, `thinking`, `stream`), SSE in
  the real event order (`message_start`; per block `content_block_start`, deltas,
  `content_block_stop`; a `ping` after the first block start; `message_delta` with `stop_reason`
  and usage; `message_stop`), `thinking` / `text` / `tool_use` blocks (`thinking_delta` +
  `signature_delta`, `text_delta`, `input_json_delta`), `end_turn` / `tool_use` / `max_tokens`
  stops (default answers are cut to fit `max_tokens`), the `message` JSON body, and the
  `{ type: 'error', error: { type, message } }` envelope. Auth accepts a non-empty `x-api-key` or
  `Authorization: Bearer`; the ledger records only which header carried it, plus
  `anthropic-version` / `anthropic-beta`. A missing or unsupported `anthropic-version` (only
  `2023-06-01`, the value the SDK providers send) answers 400 `invalid_request_error`, as does
  `thinking` with a forced `tool_choice` (`tool` / `any`); both keep evidence tagging and the
  ledger status. `message_delta.usage` carries input and cache counts next to `output_tokens`,
  matching the committed (unverified) fixtures. Known leniency: the emulator does not require the
  OAuth `anthropic-beta` header for bearer credentials and does not enforce other thinking,
  `tool_choice`, or `budget_tokens` constraints (`budget_tokens >= 1024`,
  `budget_tokens < max_tokens`), so a provider that stopped sending or honouring them would still
  pass here. Its extra fault `error-event-after-chunks` (a mid-stream
  `event: error`) applies only to streamed responses and before `message_stop`; otherwise it
  answers 500 and is kept (never a silent no-op).
- `/codex` and `/xai` (not `/opencode`) use `src/responses.ts`: Responses request parsing (`model`, an `input` string
  or array or 400, `instructions`, `tools`, `tool_choice`, `reasoning`, `stream`, `store`,
  `max_output_tokens`), SSE with typed `event:` names and `sequence_number`s in the real order
  (`response.created`, `response.in_progress`; per output item `response.output_item.added`, its
  parts and deltas, `response.output_item.done`; `response.completed` with the whole `response` and
  `usage`), `reasoning` (summary part events, only when the request asks for a `summary`),
  `message` (`output_text` deltas), and `function_call` (`function_call_arguments` deltas) items,
  the completed `response` JSON body, scripted turns (including `format: 'json'` for the providers'
  JSON fallback), and the extra fault `error-event-after-chunks` (a mid-stream `error` or
  `response.failed` event; streamed responses only and before `response.completed`, otherwise 500
  and kept). Each subpath supplies only its path and manifest, model list, error envelope and
  unknown-model status, the 401 error for a missing bearer, header rules (required headers with
  their status and error; which non-credential header values the ledger records), the
  `max_output_tokens` policy (`rejected` for Codex, `optional` for Grok), and its input-invalid
  error. `/xai` requires, in order, `X-XAI-Token-Auth` (401), `x-grok-client-version` (426), and
  `x-grok-model-override` (400); it records the version and override, never the token-auth value.
  `/codex` records `originator` and never records `ChatGPT-Account-Id`. Known leniency (unverified):
  `store`, `stream`, `instructions`, the model override matching `model`, the client version value,
  and output limits are not enforced. The Codex and Grok error envelopes and unknown-model status
  (400 `model_not_found`) are synthetic until a live recording.
- One origin, one fetch handler: the router takes one route per origin, so routes of different cores
  on one origin are composed by `src/emulator-compose.ts`, each part keeping its own manifest,
  ledger, faults, turns, coverage, and control plane (`/_emulate/<part>/*`); `POST /_emulate/reset`
  resets every part. Do not merge parts into one kernel, and never add a usage route to a model
  route's manifest (its manifest and coverage stay unchanged).
- `/opencode` composes four fixture-only parts under `/zen/go/v1` (`emulator.chat` / `.messages` /
  `.responses` / `.usage`; combined `coverage()` and `GET /_emulate/coverage`; requests on no
  route are ledgered as not-emulated by the chat part). It does not use the chat, Messages, or
  Responses cores: their synthetic output cannot equal the fixtures. Chat answers the streamed
  plain-text recording, Messages the streamed plain-text recording, Responses the plain-text or the
  commentary-replay recording (a text answer) by request shape, and usage the snapshot. There is
  no `knownModels` option; `openCodeGoEmulatorDefaultModels` lists the recorded models.
- Subscription-usage routes use `src/subscription-usage.ts` on the fixture-only core (credential,
  header rules in order, recorded `accept` and query, then status fault, scripted `{ usage }` /
  `{ error }` turn, recorded body; chunk faults shape the one-chunk body). `/anthropic`, `/codex`,
  and `/xai` serve their usage route through `withSubscriptionUsage` (`emulator.usage`, own
  manifest `*SubscriptionUsageEmulatorRoutes`); `/opencode` includes it as a part. All four take a
  `subscriptionUsage` option (a replacement body with the recorded shape). Credential and account
  headers (`ChatGPT-Account-Id`, `x-userid`, `X-XAI-Token-Auth`) are required but never recorded.
- `/email` is a port emulator, not a fetch handler, and does not use the kernel:
  `call(method, request)` answers one `EmailClient` call as plain JSON (`{ response }`, `{ failure }`, or
  `{ notEmulated }`), and `emailClientLayerFromBackend` in `@yolk-sdk/connectors/email/conformance`
  bridges it to the port. Response behaviour comes ONLY from the fixtures in
  `src/email-fixtures.ts`, a verbatim copy of the connector `emailConformanceFixtures`
  (`test/email-conformance.test.ts` fails on drift; update both together). The in-memory mailbox
  (seeded with `emailEmulatorDefaultSeed`, or `seed`) only selects the first matching fixture that
  is consistent with it (preferring fixtures unused since reset) and records what that fixture says
  happened; it never invents ids, flags, or responses. Its manifest routes are
  `PORT EmailClient.<method>`; write methods are unverified connector writes that need a pending
  entry (`{ manifest: 'email', method: 'PORT', path: 'EmailClient.<method>' }`) in
  `scripts/emulator-evidence-pending.json` until an owner-approved live run against a practice
  mailbox verifies them. Keep ledger, faults (`failure` with an optional deep-subset
  `match`), `reset`, `state`, and `coverage`.
- Request-shape latitude (`/email`, the only one): credential fields are never compared or
  recorded, and `connection.host` is not compared (the practice host comes from seeds); every other
  connection field (`protocol`, `port`, `security`) is. Everything else fails closed with a
  ledgered `notEmulated` answer (`unknown-method`, `invalid-request`, `no-matching-fixture`,
  `state-conflict`), the port analogue of 400. Faults apply only after a matching, state-consistent
  fixture is chosen. The bullet has four copies that change together with `test/email.test.ts`:
  this one, the `src/email.ts` header, `README.md` (Email emulator), and
  `apps/docs/content/docs/api-reference/emulators.mdx` (Email emulator).
- `/r2` is a port emulator like `/email` (no kernel, no core): `call(port, method, request)` answers
  one `R2Presigner` or `R2ObjectClient` call as plain JSON (`{ response }`, `{ failure }`, or
  `{ notEmulated }`), and `r2PortsLayerFromBackend` in `@yolk-sdk/connectors/r2-storage/conformance`
  bridges it to both ports. Response behaviour comes ONLY from the fixtures in `src/r2-fixtures.ts`,
  a verbatim copy of the connector `r2ConformanceFixtures` (`test/r2-conformance.test.ts` fails on
  drift and replays every fixture byte for byte; update both together). The in-memory bucket (seeded
  with `r2EmulatorDefaultSeed`, the object the get fixtures read, or `seed`) only selects the first
  matching fixture consistent with it (preferring fixtures unused since reset) and records what that
  fixture says happened (an object created or replaced under the etag the fixture names); it never
  invents an etag, a byte, or a failure. Presigning writes nothing. The connector cannot delete R2
  objects, so a write case leaves its object (`create-if-absent.txt`, `update-if-match.txt`) and a
  second run on the same emulator fails both write cases without writing, as a reused run id does
  live. Credentials: every credential field (the shared port scan's `isPortCredentialKey` names,
  copied in `src/r2-guard.ts`) is dropped at any depth before anything is compared or recorded.
  Every refusal (`unknown-method`, `invalid-request`, `uncheckable-body`, `credential-in-request`,
  `uncheckable-request`, `no-matching-fixture`, `state-conflict`) is ledgered with constant text
  only (request `<redacted>`; port and method `<unrecognised>` for `unknown-method` and
  `uncheckable-request`), uses no fault, and changes no state. Only a request equal to a fixture
  request (minus credential fields) is recorded, so the ledger holds fixture text, with every
  `bodyBase64` as `<redacted>` plus `bodyBytes` (the decoded length). An own `__proto__` key at any
  depth is `invalid-request`. Every `bodyBase64` must be canonical standard base64 of UTF-8 text
  (else `uncheckable-body`); its decoded text is checked with the request's own texts. A request is
  `credential-in-request` when any key, string value, number (as printed and, for an integer, as its
  digit string), or decoded body repeats a guarded value, or holds, once the exact canonical
  placeholders are blanked out, a SigV4 credential name, a credential query parameter, or a token
  the shared scan flags (a bearer token, an API-key prefix, a JSON Web Token, a PEM private key).
  Guarded values are every non-empty key, string, and number under a credential field (a numeric
  string also in its number forms), with no minimum length, unlike the shared helpers. Both checks
  run raw, in R2's own decodings (`decodedVariants`: up to three percent and three escape rounds,
  with `\uXXXX`, `\xXX`, and numeric HTML references), and through the shared fail-closed closure
  (`textClosureOutcome` of `src/stateful-secrets.ts`, imported, never copied; a cap refuses). A
  request the checks cannot walk (cyclic, or nested too deeply) is `uncheckable-request`: `call`
  never throws. The copied credential key, parameter, and token lists live in `src/r2-guard.ts`;
  `test/r2.test.ts` holds one sample per entry of each, asserts each sample count equals its list's
  length, and checks every sample against the shared scan (`isPortCredentialKey`,
  `scanPortFixtureForSecrets`) and the emulator, so an entry added here without a sample fails. A
  name or pattern the shared scan adds later is not enforced until it is copied here with a sample.
  Its manifest routes are `PORT <Port>.<method>`; `PORT R2ObjectClient.put` is the only write and
  needs a pending entry (`{ manifest: 'r2', method: 'PORT', path: 'R2ObjectClient.put' }`) in
  `scripts/emulator-evidence-pending.json` until an owner-approved live run of
  `r2.objects.create-if-absent` and `r2.objects.update-if-match` against a practice bucket verifies
  it. Keep ledger, faults (`failure` on a `port` and `method`, with an optional deep-subset
  `match`), `reset`, `state`, and `coverage`.
- Request-shape latitude (`/r2`, the only one): credential fields are never compared or recorded,
  and JSON key order is not compared. Everything else (the endpoint, bucket, key, content type,
  `maxBytes`, `expectedEtag`, the put `condition`, `bodyBase64`, and `maxUploadBytes`) must equal a
  fixture request exactly, so only the fixtures' `run-synthetic` run id is emulated. A `bodyBase64`
  must be canonical standard base64 of UTF-8 text (else `uncheckable-body`); it is compared as sent
  but recorded only as its decoded length. No object may have an own `__proto__` key (else
  `invalid-request`), and no key or value, the decoded body included, may carry a credential or
  repeat a dropped credential value of any length (else `credential-in-request`). Every refusal is
  ledgered with constant text only (request `<redacted>`). Anything else fails closed with that
  ledgered `notEmulated` answer (`unknown-method`, `invalid-request`, `uncheckable-body`,
  `credential-in-request`, `uncheckable-request`, `no-matching-fixture`, `state-conflict`). Faults
  apply only after a matching, state-consistent fixture is chosen. The bullet has four copies that
  change together with `test/r2.test.ts`: this one, the `src/r2.ts` header, `README.md` (R2
  emulator), and `apps/docs/content/docs/api-reference/emulators.mdx` (R2 emulator).
- Fortnox state lives in the core runtime (JSON state, replaced per `reset`/`seed` generation);
  the ledger, faults, auth, and the `/_emulate/*` control plane live in the wrapper
  (`src/fortnox.ts`), because the core reserves `/_emulate`. The bearer token is never forwarded
  to the core, stored, or ledgered. Faults answer before the route runs, so they never write.
- Fortnox observed quirks live in `src/fortnox/api.ts` and are listed in `fortnoxEmulatorQuirks`
  with their case ids. The `quirks` option (`stickyRowDiscount`, `emptyStringClears`,
  `paymentFiltersIncludeUnbooked`) is a disagreement-drill knob for tests only: defaults follow the
  observed behavior. Fail closed on anything not emulated (unknown query parameters, filters,
  fields, referenced articles/cost centers/projects, non-SEK currency, including a customer's
  inherited currency) instead of ignoring it. Customer categorical values are the emulated subset
  only (document it as such, never as Fortnox's full enum): `VATType` `SEVAT`, `Type`
  `COMPANY`/`PRIVATE`, `TermsOfPayment` whole days `0`-`365`; invoice creation checks the
  inherited `VATType` and `TermsOfPayment` (and the computed due date) before committing, with
  no silent fallback. Query keys are allowlisted per route in the route
  table (`queryKeys`, empty by default) and checked before the handler runs, so a rejected write
  never writes. `lastmodified` is not emulated (the state tracks no modification times).
- Microsoft Graph (`src/microsoft.ts` + `src/microsoft/*`) follows the Fortnox shape; see the
  README for its routes and wire claims. Non-obvious rules: behaviour comes only from the
  conformance fixtures; anything they do not show fails closed (400 `Synthetic*`). Its README's
  "Emulator extrapolations (no fixture)" list predates the fixture-only rule as now stated: it is
  legacy to remove, never a precedent; no new emulator or route may add such an exception. Route
  params are matched on the raw path and decoded once; `@odata.nextLink` reuses the raw path.
  Created ids and change keys come from counters that only advance, so the state-equals-seed
  proof excludes only the counters. The first message write to reach the
  handler holds the message for `conflictWindowMs`; an overlapping write gets 409, while
  non-overlapping writes both apply. Copy monitors are runtime data (not in the state; cleared by
  reset/seed). Ledgered bodies and queries redact credential-named keys (`redactCredentialFields`,
  `redactCredentialQuery`, which also covers the conformance scan's `credential_query_param`
  names such as `x-amz-signature`); `test/emulator-http.test.ts` keeps both name rules in step
  with `@yolk-sdk/conformance`'s.
- Dropbox (`src/dropbox.ts` + `src/dropbox/*`) and Notion (`src/notion.ts` + `src/notion/*`) are
  stateful AND fixture-only, without exceptions: every answer value comes from a committed fixture
  (through the seed or the request) or is a minted value (created ids, revs, and the hashes derived
  from them, cursors, request ids, timestamps from the injectable clock); anything else answers the
  ledgered 400 not-emulated, never a guessed provider envelope, a 404, or synthesized content. An
  entity a fixture only names (a parent folder of a seeded path, a page named only by id) is held
  as `implied`: lookups and references resolve through it, but an answer that would render it is
  not emulated, and Notion search considers only pages whose content the state holds. An empty
  listing or search page is no fixture's answer either, so the read-only leftover lookups fail
  against the default seeds (not-emulated, nothing written) and the runners print their
  lookup-failed `WARN`; never answer an empty page to make them pass. Entity state lives on
  `@emulators/core`; the shared wrapper
  `src/stateful-emulator.ts` holds the ledger, faults, and control plane. Each route is
  `statefulRoute(evidence, body, admit, plan)`: `admit` checks the request shape without reading
  state (origin, bearer, header rules such as `Notion-Version: 2025-09-03`, body kind, exact body
  keys, values); `plan` reads the state without writing and refuses what the state cannot answer
  as a fixture does, or returns the commit; only then is the first status fault decided; then the
  commit writes. Plan, fault, and commit run synchronously in the core, so a not-emulated request
  (by shape or by state) never uses up a fault, and a faulted request writes nothing. Each route
  answers only on its recorded origin (`fetch` reads it from the URL; `fetchOn(origin)` serves one
  origin behind a loopback rewrite; Dropbox's RPC and content routes and every Notion route carry
  their recorded origin). Cursors are accepted only when issued by this emulator, for the same list,
  since the last reset or seed (reset and seed clear the registry), and when the list still renders
  exactly as at issue; never decode a cursor to trust it. No cursor value crosses a reset or seed:
  Dropbox and Notion property cursors come from counters that never reset, and Notion search and
  block cursors are the next result's id (the fixture's value) only in the generation that first
  issued that id for that list, a distinct `<id>.g<generation>` afterwards (every reset and seed
  starts a generation). Minted id and rev counters start above the highest seeded value in the minted form.
  Jobs are handed to the core under a never-reset job id (the ledger sequence resets). Recorded
  headers are never credential headers (refused at build); a JSON header (`Dropbox-API-Arg`) is
  ledgered parsed with credential-named keys redacted at any depth, or as `<redacted>` when
  unparseable, and so is a query value that looks like JSON (starts with `{` or `[`, such as a
  browser-style `arg`). Fault statuses are 400-599 with an `emulator_fault` default body; recovery
  answers (unknown routes 400, handler failure 500, closed 503) read no clock, so a throwing clock
  only fails the commits that read it (Dropbox uploads, Notion page creates) with a ledgered 500
  before any write. Wire shapes and error envelopes come from the fixtures (Dropbox's 409
  `error_summary` bodies byte for byte in `dropboxEmulatorErrorBodies`); `test/dropbox.test.ts` and
  `test/notion.test.ts` replay every fixture and compare each complete response byte for byte (the
  drift test of the data copies), substituting only minted values at exact field paths (Dropbox
  created ids, revs, and hashes from write answers, each learned once; Notion top-level
  `request_id`). Write cases end at the seed except the advancing counters and what the provider
  keeps after a delete that a fixture records (Dropbox: the deleted-entry record of an empty case
  folder; Notion: the case's own trashed page); the cross-check tests prove exactly that. Drill
  knobs (`drills`, booleans) each fail exactly one case.
- Request-shape latitude (`/dropbox`, the only accepted deviations): any bearer value (never
  checked or stored); extra request headers; JSON key order; `content-type` media-type
  parameters; any path and search query (looked up in the state); any `list_folder` `limit` from
  1 to 2000 and any `search_v2` `options.max_results` from 1 to 1000; and any upload body bytes.
  Everything else (other keys, booleans, modes, query parameters, another origin, ids or revs
  where the fixtures send paths, the root folder, and cursors not issued since the last reset or
  whose listing changed) is not emulated. Copies change together: this bullet, the
  `src/dropbox.ts` header, `README.md` (Dropbox emulator), and
  `apps/docs/content/docs/api-reference/emulators.mdx`.
- Request-shape latitude (`/notion`, the only accepted deviations): any bearer value (never
  checked or stored); extra request headers; JSON key order; `content-type` media-type
  parameters; the order of query parameters; Notion ids with or without dashes, in any case; any
  search `query` (looked up in the state); and any `page_size` from 1 to 100 whose page shows
  only recorded results (the data source query: 1). `Notion-Version` must be `2025-09-03`.
  Everything else (other keys, filters, booleans, sorts, query parameters, another origin,
  titles, repeated or missing `page_size`, and cursors not issued for the same list since the
  last reset or whose list changed) is not emulated. Copies change together: this bullet, the `src/notion.ts` header,
  `README.md` (Notion emulator), and `apps/docs/content/docs/api-reference/emulators.mdx`.
- Todoist and Telegram (`src/todoist.ts`, `src/telegram.ts`, on the shared
  `src/stateful-emulator.ts` in its opt-in resolved mode, `resolveRequest`, built with
  `makeHeaderlessStatefulEmulator`, `json-or-empty` route bodies, and their own `errorTexts`) are
  stateful AND fixture-only, with no exceptions: entity state lives
  in the core runtime (like Fortnox), but response content and behaviour come only from their
  conformance fixtures, copied as data into the default seeds and handlers (never imported); the
  state only decides which recorded answer applies, and anything no fixture records is refused,
  never synthesised. Order per request: the emulator's resolution (route, credential, query
  allowlist) and the wrapper's repeat and body checks; then the route handler's plan, an
  eligibility check against the request and the state that writes nothing (handlers answer not
  emulated or the commit); only then the fault decision; then the commit. The plan, the fault
  decision, and the commit run synchronously in one core call, so concurrent requests never
  interleave (before #139 they ran in separate steps, the commit validating again); fault answers
  and refusals are still returned outside the core, so they stay readable after a reset or a close.
  A consumed or locked request body answers the ledgered 400 `the request body is unreadable`, and
  a refusal reason that cannot be percent-encoded (an unpaired surrogate) the handler-failure 500.
  Routes see the ledgered path and no header names. A `match.route` naming no manifest row is
  rejected when the fault is added. So a refused request answers the
  ledgered 400 not-emulated, writes nothing, and never uses a fault; faults are `status` only, 400-599. Only
  items created through the recorded create flow are written or (for projects) read: seeded projects
  answer not-emulated on reads (no fixture records their objects), seeded projects and tasks are
  never updated, closed, or deleted, a case project takes one task and a seeded parent one
  sub-project (`child_order: 1`, as recorded). Created ids use the reserved prefix `6XEmu`
  (`6XEmuProject0001`, `6XEmuTask0000001`), which seeds may not use, so seeded and minted ids never
  collide. Created ids, 404 `event_id`s, and Telegram `message_id`s come from counters that only
  advance (the state-equals-seed proof excludes only the counters, plus Telegram's `sentMessages`: a
  send is irreversible and recorded in state); Todoist cursors are runtime data, valid only as
  issued since the last reset or seed. Recovery never reads the clock (500 `emulator_error` with
  `responseError` for a throwing handler, 400 not-emulated, 503 when closed). The drift tests
  (`test/todoist.test.ts`, `test/telegram.test.ts`) replay every fixture exchange against the
  default seed: Telegram byte for byte, Todoist byte for byte for reads and modulo created ids and
  `event_id`s for writes; a changed fixture fails them until the emulator follows it.
- Fail-closed ledger (`/todoist`, `/telegram`): a request is recognised only when its raw path (as
  parsed, never percent-decoded) is exactly an emulated route shape under that route's HTTP method:
  for Telegram `/bot<token>/<method>` (one of the emulated Bot API methods) or
  `/file/bot<token>/<file_path>` (plain `[A-Za-z0-9_.-]` segments), with the strict token pattern on
  the raw segment and no other path text; for Todoist a route path whose raw id segments are Todoist
  ids. Every other request is `unrecognised` and is ledgered and answered with constant text only:
  the path `/<unrecognised>`, a standard method or `<other>`, no query, no body, and a constant
  reason (`no emulated Bot API route for this method and path`,
  `no emulated Todoist route for this method and path`). A Todoist request whose `Authorization`
  header is present but is not one recognisable bearer is `unrecognised` too, whatever its route
  (`an unrecognisable Authorization header is not emulated`): its credential cannot be extracted
  and scrubbed. So nothing an unrecognised request carries (an unknown route, extra segments, a
  malformed or percent-encoded token, an encoded separator such as `%2F` or `%252F`) can reach the
  ledger, a response, or `/_emulate/*`, and no credential is searched for in it.
- Credentials (the Telegram bot token in a recognised URL path, and the Todoist bearer value) are
  required but never forwarded to the core (which is sent the ledgered path, and whose routes see
  only whether the token names a bot), stored, ledgered, or echoed. For a recognised request the token is taken from its exact path
  segment (its secret part guarded too); the wrapper applies one `scrubSecrets` to the ledgered
  method and path, every query key and value, and every not-emulated reason before anything is
  ledgered or answered, and refuses, with constant text, a query, a remaining path, or a body that
  repeats a guarded value: raw, percent-decoded, or (after parsing) in any JSON key, string value,
  or number (also the value as it would be recorded), so `\u`-escapes and normalised numbers such as
  `1.2345678e7` are caught too. Telegram refusals never interpolate a request key or value.
  `test/telegram.test.ts` covers every refusal path (unrecognised shapes including `%2F`, `%252F`,
  and `%0A` counterexamples, escaped body keys and values, numeric bodies, query keys raw and
  percent-encoded, the secret part as a file path) against the responses, the ledger, the state, and
  every `/_emulate/*` read.
- Request-shape latitude (`/todoist`, `/telegram`, the only accepted deviations): any credential
  value of at least 8 characters that occurs nowhere else in the request (its path, query, or body;
  never checked against anything, stored, or ledgered); extra request headers; `content-type`
  parameters; Todoist: query parameters in any order; any Todoist id (1-64 of `[A-Za-z0-9_-]`) of an
  existing item where a fixture has an id (reads: seeded or created tasks and created projects; task
  listings: the paging project with `limit=2` and case projects created here without `limit`;
  writes: only items created through the recorded create flow; a new project's `parent_id`: a seeded
  project); any `run-` run id (at most 40 characters) in a case project name; any non-empty task
  `content`; a task update sending `content`, `due_datetime`, or both; a label listing `limit` of 1
  to 200 that covers every label; Telegram: a well-formed `<digits>:<secret>` bot token with a
  secret of at least 8 characters (the bot id `0` names no bot); any well-formed `chat_id` string
  (an integer or a public `@username`; one the bot is not in answers the recorded 400 on `getChat`);
  any non-empty message `text`. The bullet has four copies that change together with the unit tests:
  this one, the `src/todoist.ts` / `src/telegram.ts` headers, `README.md` (Todoist and Telegram
  emulators), and `apps/docs/content/docs/api-reference/emulators.mdx`.
- GitHub (`src/github.ts` + `src/github/*`) is stateful AND fixture-only, without exceptions, on
  `src/stateful-emulator.ts` in its opt-in fail-closed mode (`failClosed`): every route path
  parameter has a raw pattern (`params`; owner and repository names, decimal issue numbers and
  comment ids, plain label names, a multi-segment `{path+}` of plain file path segments), so a
  request is recognised only when its raw path is exactly an emulated route shape under that route's
  method (each raw pattern matched in full; a `g` or `y` flag is refused at build) and any
  `Authorization` header is exactly `Bearer <at least 8 non-space characters>` (a recognisable
  bearer, below); everything else is ledgered with constant text only (`/<unrecognised>`, a standard
  method or `<other>`, an empty query, no body, a constant reason). A recognised bearer must match
  the RFC 6750 `b64token` syntax exactly (`^[A-Za-z0-9\-._~+/]+=*$`, at least 8 characters), start
  with a character in `[G-Zg-z\-._~+/]` other than `n`, `r`, `t`, `u`, and hold at least one
  character outside the JSON-number alphabet `[0-9.eE+-]` (every GitHub and Google token form does:
  `ghp_…`, `github_pat_…`, `gho_…`, `ya29.…`). So no number's text can contain it; it holds no
  escape introducer (`%`, `\`, `"`), so no escape starts inside it; and its first character is no
  hex digit and no JSON escape letter, so no stray `%`, `\`, or partial escape to its left can
  complete with it, and its characters always decode in place. An `Authorization` header with any
  other value is unrecognisable. A recognised request that repeats the bearer value in its raw path,
  any path segment, the raw query or any query key or value, any recorded header, or its body is
  refused and ledgered with constant text only: a standard method, the path `/<unrecognised>`, its
  route template, an empty query, no headers or body, and a constant reason
  (`the query repeats the credential`, for example). Each part is checked through the closure of two
  total, lexical transforms that cannot fail: a tolerant percent-decode (every `%XX` below `%80`
  becomes its ASCII character; any other `%` sequence is left as it is) and a tolerant JSON-unescape
  (in any text, whether or not it parses as JSON, `\uXXXX` below `\u0080` and `\"`, `\\`, `\/`,
  `\b`, `\f`, `\n`, `\r`, `\t` become their characters). Starting from each part's raw text, either
  transform is applied to every text of the previous step, deduplicated, until no new text appears
  (a fixpoint), and every text is checked for the bearer as a substring; both transforms never
  lengthen a text and shorten it whenever they change it. So any depth of percent-encoding or JSON
  escaping, in any order, is seen through in every part: the raw path and each raw path segment, the
  raw query and each query key and value (already decoded once by `URLSearchParams`), each recorded
  header, and the raw body. The work is capped at 64 rounds, 1024 distinct texts, or 8 Mi characters
  read by the transforms, whichever comes first; a part whose closure hits a cap before its fixpoint
  counts as repeating the credential and is refused with the same constant entry (uncertainty
  refuses, it never admits; so any part over 4 Mi characters is always refused). Any other
  recognised request has the bearer value scrubbed from its ledgered fields and every not-emulated
  reason (plan-time reasons included); its recorded query is keyed by recorded key; a key recorded
  more than once lists its values in order (as a JSON array); and recorded headers and query keys
  and values that start like JSON (`{`, `[`, `"`) are recorded parsed with credential-named keys
  redacted at any depth, or as `<redacted>` when they do not parse, whatever the header's declared
  format. Empty query components are refused, and GitHub refusals never echo a request's own query
  or body keys (they use the wrapper's constant-reason `exactQuery` and `exactBodyKeys`, which a
  later fail-closed emulator uses too). Every answer value comes from a fixture (through the seed or
  the request) or is minted: created issue numbers and comment ids from counters that only advance
  (the default seed starts them at the fixtures' created values, issue 42 and comment 9000000001,
  and end at the last addressable number and id, after which creates are refused before any fault; a
  seed's counters lie above its seeded numbers, and no seeded node id, of an issue or a label, may
  use a minted `node_id` form at or above its counter), the issue `id`/`node_id` and comment
  `node_id` derived from them in the fixtures' form, and timestamps from the injectable clock (whole
  seconds). Issue numbers below the counter that the state does not hold are implied (never
  rendered); numbers at or above it answer the not-found fixture's 404 byte for byte. Error bodies
  are the fixtures' byte for byte (`githubEmulatorErrorBodies`). `Link` paging is minted only on the
  label listing, in the paging fixture's exact form (relations `prev`, `next`, `last`, `first`; the
  page after the last answers `[]`; a listing that fits one page carries none, as the label fixture
  records); label pages are page numbers the client computes, not cursors, and the label list never
  changes within a seed (no route writes labels), so there is no cursor registry. Writes follow only
  the recorded flows (comment create/delete on an open held issue; one repository label added that
  sorts after the issue's labels, or removed unless it is the issue's last (no fixture records an
  empty answer); issue create; rename and close-as-completed of an issue created here); anything
  else, including the lifecycle restore's close as `not_planned`, a comment listing of more than one
  comment, rendering an issue that holds comments, and the leftover lookup's open-issue listing (so
  `findGithubConformanceLeftovers` fails and runners print their lookup-failed WARN), is not
  emulated. A write case ends at the seed except the counters, the deleted comment's id
  (`deletedComments`, so a second delete answers the recorded 404), and the lifecycle case's closed
  issue (GitHub cannot delete issues); the cross-checks prove exactly that. Drill knobs (`drills`,
  booleans) each fail exactly one case.
- Request-shape latitude (`/github`, the only accepted deviations): any bearer value in the RFC 6750
  `b64token` syntax (`[A-Za-z0-9\-._~+/]+=*`) of at least 8 characters, starting with a character in
  `[G-Zg-z\-._~+/]` other than `n`, `r`, `t`, `u` (so a legacy all-hex token is refused), with at
  least one outside `[0-9.eE+-]`, that occurs nowhere else in the request (never compared against
  anything, stored, or ledgered); extra request headers; JSON key order; `content-type` media-type
  parameters; the order of query parameters; any non-empty issue title and comment body, and any
  issue body text; any comment listing `since` of the form `YYYY-MM-DDTHH:MM:SSZ`; any label listing
  `per_page` from 1 to 100, with no `page` or a `page` from 2 to one past the last page; any issue
  search `q` that starts with the seeded `repo:<owner>/<repo>` qualifier and whose query after it is
  longer than 256 characters (answered the recorded 422); any issue number the repository has not
  reached (answered the recorded 404); and any issue, comment, repository label, or file the state
  holds where a fixture has one, under the per-route state rules. `Authorization` must be exactly
  `Bearer <token>` (that spelling, one space), `Accept` `application/vnd.github+json`, and
  `X-GitHub-Api-Version` `2026-03-10`. Everything else (other keys and values, query parameters,
  empty query components such as a bare `?` or a stray `&`, another origin or repository, a repeated
  query key, an explicit `page=1`, and a comment listing `per_page` other than 100) is not emulated.
  Copies change together with `test/github.test.ts`: this bullet, the `src/github.ts` header,
  `README.md` (GitHub emulator), and `apps/docs/content/docs/api-reference/emulators.mdx` (GitHub
  emulator).
- Google (`src/google.ts` + `src/google/*`) is stateful AND fixture-only, without exceptions, on
  `src/stateful-emulator.ts` in its opt-in fail-closed mode (`failClosed`), and follows the shared
  fail-closed rule stated for GitHub above, unchanged: raw parameter patterns matched in full on
  every route (Gmail ids, a calendar id whose only encoding is `%40`, event ids, Drive ids), the
  recognisable-bearer rule, constant-text entries for unrecognised requests, unrecognisable
  `Authorization` headers, and credential repeats (the recorded `content-type` header and the raw
  body, the multipart send body included, are checked like every other part, and the draft compose
  and update routes add the base64url-decoded MIME of `message.raw` as a `decodedViews` view of
  their body, checked the same way before anything is recorded; the view throws a
  `DecodedViewRefusal` for a `message.raw` that is not canonical unpadded base64url of exactly the
  recorded draft MIME, the run id aside, with one of the route's declared `viewRefusalReasons` (its
  own constant reasons, the 13-character run-id reason among them), which the wrapper ledgers in the
  constant entry, or a repeat when the raw decodes cleanly to text holding the bearer, and no
  refused `message.raw` is ever ledgered), and the wrapper's constant-reason `exactQuery` and
  `exactBodyKeys`. It emulates only the Gmail, Calendar, and Drive routes the thirteen Google cases
  (with their cleanup) send, each on its recorded origin (`https://gmail.googleapis.com` for Gmail
  and the multipart send upload, `https://www.googleapis.com` for Calendar and Drive). The practice
  send is irreversible on Gmail: the emulator only records the sent message in the state (never
  delivered) and accepts only the recorded 7-bit message whose sole recipient header is
  `To: <the seeded practiceAddress>`, and only while that address is the recorded
  `practice@example.test` (a seed may set another; then every send is refused). The draft and sent
  messages answer the recorded `sizeEstimate` (which covers the subject and address) and `body.size`
  (64, 88), so draft and send subjects take only a run id of the fixtures' length (13 characters);
  other run-scoped names take any. A Gmail message answers only the `format` renderings a fixture
  records for it; the paging label, the five messages its listing names, and the practice Drive
  folder are implied (named, never rendered). Absent ids answer only the recorded not-found
  envelopes (a `format=minimal` read of a 16-hex-digit message id, a `Label_<1 to 999999999>` label
  read, an `r-<digits>` draft delete, a Drive file read); everything else about an absent or implied
  item is not emulated. Minted ids: created label ids start above every seeded label number
  (`Label_9101` first, the fixture's value; seeded `Label_<digits>` ids must be
  `Label_<1 to 999999999>`, and a create when no number is left is refused before any fault); draft,
  draft message (also the draft's thread id), sent message, event, and folder ids use forms no
  seeded id or thread id may use; all come from counters in the state that only advance. A draft
  thread answers only when every message in it was created here. Page tokens are the fixtures'
  values in the generation that first issued them and `<token>.g<generation>` afterwards; a token is
  never rebound to another position or list rendering (token values are globally unique: another
  list or page size, or a changed list, gets a distinct `<token>.v<k>`), and it is accepted only
  when this emulator issued it for the same list since the last reset or seed and the list is
  unchanged. Writes end at the seed except the counters, the event cases' own `cancelled` events
  (the fixtures read them back), and the sent message. `test/google.test.ts` replays every fixture
  in suite order on one emulator byte for byte with no substitution (the clock set to each recorded
  write's instant), and each fixture alone substituting only the minted event id (and its derived
  `htmlLink` / `iCalUID`) at exact paths. Drill knobs (`drills`, booleans) each fail exactly one
  case.
- Request-shape latitude (`/google`, the only accepted deviations): any bearer value in the RFC 6750
  `b64token` syntax (`[A-Za-z0-9\-._~+/]+=*`) of at least 8 characters, starting with a character in
  `[G-Zg-z\-._~+/]` other than `n`, `r`, `t`, `u`, with at least one outside `[0-9.eE+-]` (Google's
  `ya29.…` access tokens qualify), that occurs nowhere else in the request (never compared against
  anything, stored, or ledgered); extra request headers (except `X-Goog-Drive-Resource-Keys`, which
  no fixture sends); JSON key order; `content-type` media-type parameters on JSON requests; query
  parameters in any order; any `run-` run id (at most 40 characters) in a run-scoped label name,
  event summary, or folder name; in a draft subject (compose and update) and the sent subject, only
  a run id of exactly 13 characters, the length of the fixtures' `run-synthetic`, because the
  recorded `sizeEstimate` of the draft and sent messages (answered by their message reads and the
  draft thread) covers the subject; on the practice send, a `content-type` of exactly
  `multipart/related; boundary=<b>` with any one unquoted boundary of 1 to 70 `[A-Za-z0-9_]`
  characters and no other parameter; a `gmail.list` `maxResults` from 1 to 500, a
  `calendar.list_events` `maxResults` from 1 to 2500, and a `drive.list_files` `pageSize` from 1 to
  1000; any `timeMin` before `timeMax` (RFC 3339 instants with a real calendar date, hour 0 to 23,
  minute and second 0 to 59, and a `Z` or in-range numeric offset); any id of an item the state
  holds where a fixture has an id (writes: only items created here, plus label changes, trash, and
  untrash of a stored non-draft message); and, for an id the state does not hold, only the recorded
  not-found answers (a `format=minimal` read of a 16-hex-digit message id, a read of a
  `Label_<1 to 999999999>` label, a delete of an `r-<digits>` draft, and a Drive file read). A seed
  may set another `practiceAddress`, but then every send is refused, since the recorded
  `sizeEstimate` of the sent message also covers the address: the send answers only while the seeded
  address is the recorded `practice@example.test`. On the draft compose and update routes,
  `message.raw` must be canonical unpadded base64url of exactly the recorded draft MIME of that
  route, the run id aside; any other `message.raw` (line-wrapped, the standard alphabet, padded,
  with a stray character, or with MIME-level encodings such as RFC 2047 encoded-words,
  quoted-printable, or UTF-16) is refused before anything is recorded or a fault is decided, as a
  constant entry with the route's own declared reason
  (`message.raw must be canonical base64url UTF-8 MIME`,
  `a draft compose other than the recorded run draft is not emulated` or its `update` form, the
  13-character run-id reason, or `message has a key this route does not take`), or
  `the request body repeats the credential` when that raw decodes cleanly to text holding the
  bearer, so a refused `message.raw` never reaches the ledger and an admitted one is the recorded
  text. `Authorization` must be exactly `Bearer <token>` (that spelling, one space). Everything else
  (other keys, values, formats, query parameters, empty query components such as a bare `?` or a
  stray `&`, recorded headers such as Drive's `accept: application/json` missing, another origin,
  repeated query parameters, any recipient but the seeded practice address, a draft or send run id
  of another length, a bearer repeated anywhere in the request, including base64url-encoded inside a
  draft's `message.raw`, and page tokens not issued for the same list since the last reset or seed,
  or whose list changed) is not emulated. The bullet has four copies that change together with
  `test/google.test.ts`: this one, the `src/google.ts` header, `README.md` (Google emulator), and
  `apps/docs/content/docs/api-reference/emulators.mdx` (Google emulator).
- LinkedIn search (`src/linkedin-search.ts` + `src/linkedin-search/{state,api}.ts`) is stateful AND
  fixture-only, without exceptions, on `src/stateful-emulator.ts` in its opt-in fail-closed mode,
  and follows the shared fail-closed rule stated for GitHub above, unchanged (no route has a path
  parameter, so every raw path is matched exactly; the recorded `content-type` header and the raw
  body are checked like every other part; every route's query uses `exactQuery`'s opt-in
  `rawNames`, so a percent-encoded parameter name is refused). It emulates only the three reads the
  seven LinkedIn search cases send, each on its recorded origin: `POST /search` on
  `https://api.exa.ai`, and `GET /api/v2/profile` and `GET /api/v2/profile/email` on
  `https://enrichlayer.com`. Nothing is
  written, minted, or read from a clock: a search answers only the results the state holds for
  exactly its query and `numResults` (the default seed: the fixtures' three answers for the seeded
  query, `numResults` 10, 3, and 2, the limited one without `publishedDate`, as recorded); a profile
  lookup a held profile or, for a seeded absent profile, the recorded 404; an email lookup a held
  profile's recorded email; anything else (another query or `numResults`, the unauthorized probe
  with an accepted key, any other profile URL, the email of an absent profile) is not emulated. Each
  provider takes its own key, so a request's credential decides an answer per origin: the wrapper's
  opt-in, general `bearerDigest` (fail-closed mode only, checked at build) hands routes SHA-256 of
  the arrival origin, a space, and the bearer (`EmulatedRequest.bearerDigest`, never the bearer; a
  digest that throws or repeats the bearer answers the 500 emulator error), and a plan answers the
  origin's recorded 401 when it is one of the digests of the keys the seed marks as rejected on that
  origin. The state holds only those digests, never a key, so a key a request carries as its bearer,
  a rejected one included, never reaches the state, a snapshot, or `/_emulate/*` (a key sent as data
  elsewhere in a request is ledgered like any other text); seed errors are constant text (a category
  and a field path, an unexpected key reported at its parent) and never quote a key. The default
  seed rejects the synthetic invalid keys the two unauthorized cases send. Error bodies are the
  fixtures' byte for byte (`linkedInSearchEmulatorErrorBodies`). `test/linkedin-search.test.ts`
  replays every fixture byte for byte (status, every header, body; nothing is substituted), each
  alone and all in suite order twice on one emulator. Every case ends exactly at its seed. Drill
  knobs (`drills`, booleans) each fail exactly one case.
- Request-shape latitude (`/linkedin-search`, the only accepted deviations): any bearer value in the
  RFC 6750 `b64token` syntax (`[A-Za-z0-9\-._~+/]+=*`) of at least 8 characters, starting with a
  character in `[G-Zg-z\-._~+/]` other than `n`, `r`, `t`, `u`, with at least one outside
  `[0-9.eE+-]`, that occurs nowhere else in the request (never stored or ledgered; only its
  per-origin digest is compared, with the digests of the keys the seed marks as rejected on that
  origin); extra request headers; JSON key order; `content-type` media-type parameters on the
  search; any percent-encoding of the `linkedin_profile_url` value that decodes once to the same
  profile URL; and, with a key the seed marks as rejected on the request's origin, any search
  `query` (one trimmed line of at most 500 characters) with any integer `numResults` from 1 to 100,
  and any profile URL of the form `https://<host>/in/<slug>`, each answered the origin's
  recorded 401. `Authorization` must be exactly `Bearer <token>` (that spelling, one space).
  Everything else (other body keys or values, a `category` other than `people`, a `type` other than
  `auto`, `contents` other than `{ "text": true }`, a search the state holds no answer for (another
  query, or a `numResults` no seeded search of that query records), a profile URL the state holds
  neither as a profile nor as absent, an email lookup of an absent profile, any query parameter on
  the search, other, missing, or repeated query parameters on a lookup, a query parameter name in
  any but its plain form (such as `%6cinkedin_profile_url`), empty query components such as a bare
  `?` or a stray `&`, a body on a lookup, another origin, and a bearer repeated anywhere in the
  request) is not emulated. The bullet has four copies that change together with
  `test/linkedin-search.test.ts`: this one, the `src/linkedin-search.ts` header, `README.md`
  (LinkedIn search emulator), and `apps/docs/content/docs/api-reference/emulators.mdx` (LinkedIn
  search emulator).
- MCP (`src/mcp.ts` + `src/mcp/{state,api,recordings}.ts`) is stateful AND fixture-only, without
  exceptions, on `src/stateful-emulator.ts` in its opt-in fail-closed mode, built with
  `makeChunkedStatefulEmulator` and the opt-ins `constantRefusals`, `guardAllHeaders`,
  `guardOutput`, and `uniqueJsonKeys`, and follows the shared fail-closed rule stated for GitHub
  above, unchanged (every request header name and value but `Authorization`, whatever the ledger
  records, the raw query, and the raw body are checked like every other part; the ledger records
  `accept`, `content-type`, `mcp-method`, `mcp-name`, `mcp-protocol-version`, and `mcp-session-id`).
  The output is guarded too: before any fault is decided or anything is committed, the prepared
  answer (every header and chunk) and the minted session id or cursor the request would store are
  checked for the bearer through the closure, and a hit is the constant credential-repeat entry
  (`the answer would repeat the credential`), no fault used and nothing written, so a bearer that
  happens to equal a minted id (`yolk-emu-session-1`) or to sit in fixture text (`synthetic-mcp` in
  `yolk-synthetic-mcp`) never reaches a response, the state, or `/_emulate/*`. It emulates only the
  two synthetic servers of the sixteen `@yolk-sdk/mcp/conformance` fixtures (copied as data in
  `src/mcp/recordings.ts`; `test/mcp.test.ts` fails on drift): profile `synthetic-modern` on
  `https://mcp.example.test/modern/mcp` and profile `synthetic-legacy` on
  `https://mcp.example.test/legacy/mcp`. Three wire routes (`POST /modern/mcp`, `POST /legacy/mcp`,
  `GET /legacy/mcp`) answer the manifest as route variants: one `RPC <origin><path>#<method>` row
  per recorded JSON-RPC method of each profile, plus the `GET` row, nine rows, none a write (no
  pending entry). A JSON-RPC POST is admitted only when it equals a recorded request within the
  latitude below (methods, `mcp-method`, and `mcp-protocol-version` as recorded; params as recorded
  except JSON key order and the `_meta` client info's name and version); its answer is the recorded
  one with only the request id substituted at exactly the recorded place (the top-level `id` of a
  JSON answer, or the `id` of the SSE response event's payload; notification events and SSE `id:`
  lines stay byte for byte; an answer without the recorded request id, such as the legacy era
  probe's `id: null` error or the 401, is unchanged), the session id in the recorded
  `mcp-session-id` header, and the cursor of the current generation. `initialize` mints
  `yolk-emu-session-<n>` from a counter that never resets (runtime data; reset, seed, and a ledger
  clear never rewind it), a form no seed can hold (seeds hold no sessions, only `modernListing`);
  `notifications/initialized` makes the session ready; `tools/list`, `tools/call`, and the standing
  `GET` (the recorded 405) answer only on a ready session; at most 256 sessions are held and another
  `initialize` is refused before any fault; `reset` and `seed` clear the sessions (the
  state-equals-seed proof excludes only them). The seed's `modernListing` picks the recorded modern
  listing (`one-page`, the default, or `two-pages`); the two-page listing's cursor is the fixture's
  value in the generation that first issues it and `<cursor>.g<generation>` afterwards (every reset
  and seed starts a generation), accepted only as issued in the current generation. The bearer is
  never stored, ledgered, or echoed: routes see only its `bearerDigest` (SHA-256 of the origin, a
  space, and the bearer), compared only with the digest of the public reserved invalid credential
  `yolk-conformance-invalid-credential-0000` (a recognisable bearer, checked at build), which
  answers the recorded 401 byte for byte on the era probe and is refused anywhere else. Scope: the
  bearer is never copied from the request into a response, the state, or `/_emulate/*`; the output
  guard also refuses a prepared fixture answer, minted session id, or cursor that happens to contain
  it, but the emulator's other constants (state values such as `initializing`, wrapper headers such
  as `x-emulator-evidence`) and host-configured control-plane data (a fault body) may coincidentally
  equal a bearer and are not checked. Every refusal, by shape or by state, is ledgered with constant
  text only (`/<unrecognised>`, a standard method or `<other>`, an empty query, no headers or body,
  a constant reason, and the route template or row), writes nothing, and uses up no fault. Every
  plan prepares its answer (`StreamedCommit`); its commit (minting or readying a session, issuing a
  cursor) runs only when no fault answers. Status and `truncate-after-chunks` faults apply only
  after admission and plan, and a faulted request writes nothing: a truncation sends the prepared
  answer cut short and never commits (a truncated `initialize` holds no session and moves neither
  the counter nor the cap; a truncated first page issues no cursor, so its continuation is refused).
  `match.route` selects one row (a value naming no row is rejected when the fault is added) and
  `match.method` is the HTTP method; a truncation of a bodiless answer cannot apply (500, unused).
  `makeMcpEmulator` throws when a copied recording is not canonical JSON (every JSON body and SSE
  `data:` payload equal to `JSON.stringify(JSON.parse(text))`), which id substitution relies on, so
  provider recordings in another form fail loudly. Not emulated: `DELETE`, `ping`, `resources/*`,
  `prompts/*`, `logging/*`, `completion/*`, `tasks/*`, batches, client-sent responses, a JSON body
  repeating a key, `mcp-*` headers no recording carries (such as `mcp-param-*`; routes see header
  names through `EmulatedRequest.headerNames`), cursors the emulator did not issue, other tools or
  arguments, and a missing `Authorization`. `test/mcp.test.ts` replays every fixture byte for byte,
  alone (with the recorded ids, and again with other ids substituted only at the recorded place) and
  all one-page fixtures in suite order on one emulator, substituting only the minted session id in
  the `mcp-session-id` header. Drill knobs (`drills`, booleans) each fail exactly one case, on every
  era whose answers they change.
- Request-shape latitude (`/mcp`, the only accepted deviations): any bearer value in the RFC 6750
  `b64token` syntax (`[A-Za-z0-9\-._~+/]+=*`) of at least 8 characters, starting with a character in
  `[G-Zg-z\-._~+/]` other than `n`, `r`, `t`, `u`, with at least one outside `[0-9.eE+-]`, that
  occurs nowhere else in the request (any header name or value included) and in no answer or value
  the request would store (never stored or ledgered; only its digest is compared, with the digest of
  the public reserved invalid credential `yolk-conformance-invalid-credential-0000`, which answers
  the recorded 401 on the era probe); extra request headers, except `mcp-*` headers other than
  `mcp-method`, `mcp-name`, `mcp-protocol-version`, and `mcp-session-id`; a recorded header value
  sent as several headers that the HTTP layer joins into the recorded value; JSON key order; any
  JSON-RPC request id that is an integer from 0 to 2^53 - 1 or 1 to 64 printable ASCII characters
  where the recording has an id; any non-empty `name` and `version` (and no other key) in the
  `_meta` client info (`io.modelcontextprotocol/clientInfo`) of a modern request; a session id this
  emulator minted since the last reset or seed where the recording sends `mcp-session-id`
  (initializing for `notifications/initialized`, ready otherwise); and, with the seed's `two-pages`
  listing, the cursor this emulator issued in the current generation on the second page.
  `Authorization` must be exactly `Bearer <token>` (that spelling, one space). Everything else
  (another origin or path, any query, other HTTP methods such as `DELETE` or a `GET` on the modern
  profile, JSON-RPC methods no fixture of the profile records such as `ping`, `resources/*`, or
  `prompts/*`, batches and client-sent responses, other members, a JSON body repeating a key
  (compared after unescaping), a `null`, negative, or fractional id, other params (other tools,
  arguments, protocol versions, or capabilities, extra client-info keys, and a legacy `initialize`
  client info other than the recorded one), the MCP headers `accept`, `content-type`, `mcp-method`,
  `mcp-protocol-version`, `mcp-name`, and `last-event-id` other than the recorded values or present
  where none is recorded, any other `mcp-*` header (such as `mcp-param-*`), `mcp-session-id` missing
  where recorded or present where not, an unknown session or one in the wrong phase, a cursor not
  issued in the current generation, the reserved invalid credential on anything but the era probe, a
  bearer repeated anywhere in the request, and a bearer an answer or a minted session id or cursor
  would repeat) is not emulated. The bullet has four copies that change together with
  `test/mcp.test.ts`: this one, the `src/mcp.ts` header, `README.md` (MCP emulator), and
  `apps/docs/content/docs/api-reference/emulators.mdx` (MCP emulator).
- Control-plane routes live under `/_emulate/*`. Control inputs (faults, turns) decode strictly
  (unknown keys rejected); the JS API throws `GatewayEmulatorInputInvalid` /
  `OpenAiEmulatorInputInvalid` / `AnthropicEmulatorInputInvalid` / `CodexEmulatorInputInvalid` /
  `XAiGrokEmulatorInputInvalid` / `OpenCodeGoEmulatorInputInvalid` for invalid input
  (`EmailEmulatorInputInvalid` for an invalid email seed or fault, `R2EmulatorInputInvalid` for an
  invalid R2 seed or fault).
- Emulator bodies are pull-driven (one chunk per pull) and the ledger counts chunks handed over
  (network chunks; a Gateway chunk may pack several SSE events); chunk faults that cannot take
  effect answer 500 and are not consumed, never a silent no-op.
- Credential headers are never recorded; bearer and `x-api-key` values are never checked or
  stored.
- The Node server binds to `127.0.0.1` only, writes body chunks as they arrive (honoring
  backpressure), and destroys the socket when a body stream errors.
- Synthetic data only: model ids, texts, and hosts must be synthetic.

## Tests

`test/router.test.ts`, `test/router-redirects.test.ts` (redirects and `mapRequest` never escape the
route table, with a second unrouted loopback server), `test/gateway.test.ts`, `test/openai.test.ts`,
`test/chat-completions.test.ts` (shared core and per-emulator parameters, including each emulator's
streamed framing), `test/emulator-http.test.ts` (the credential header and query-parameter rules
agree with the conformance ones), `test/node.test.ts`, `test/gateway-conformance.test.ts` (the
Gateway conformance cases in-process and over a loopback socket, a disagreement drill, and faults
through the real provider, including 429 `retry-after` over the socket),
`test/gateway-recordings.test.ts` (each verified Gateway fixture's recorded request sent to the
emulator, with the response's status, event kinds and field names, finish/usage placement, chunk
packing, and error envelope keys compared with the recording, plus disagreement drills),
`test/openai-conformance.test.ts` (the same for the OpenAI chat cases through the generic
OpenAI-compatible provider), `test/anthropic.test.ts` (Messages framing, blocks, stops, auth,
ledger, faults, control plane), and `test/anthropic-conformance.test.ts` (the Anthropic Messages
cases in-process and over a loopback socket, disagreement drills, and 429 / 529 / mid-stream `error`
event / truncation faults through both the native Messages provider and the Claude subscription
provider), `test/responses.test.ts` (Responses framing, items, auth and Grok header rules,
output-limit policy, ledger, scripted turns, faults, control plane, and manifests for `/codex` and
`/xai`), and `test/responses-conformance.test.ts` (the Codex and Grok Responses cases in-process and
over a loopback socket, disagreement drills, and 429 `retry-after` / mid-stream `error` and
`response.failed` events / dropped connection / truncation faults through the real Codex and Grok
providers, pinning Grok's required terminal event, Codex's EOF-completion compatibility, and the 426
for a missing client version), `test/fixture-recordings.test.ts` (recordings parity: each Go and
usage fixture's recorded request answered with the recorded status, content type, event kinds and
order, field names, and content; data copies equal to the fixtures; a drift drill),
`test/opencode.test.ts` (recorded answers, the documented latitude, 400 not-emulated rejections that
leave faults and turns untouched, per-part controls, control planes, coverage, reset, manifest),
`test/opencode-conformance.test.ts` (the Go cases in-process and over a loopback socket, the
commentary replay's recorded text answer, drills, and 429 / truncation / scripted-error /
not-emulated outcomes through the real Go provider), `test/subscription-usage.test.ts` (the Claude,
Codex, and Grok usage routes: recorded bodies, not-emulated rejections, shape-checked scripted and
default bodies, faults, control plane, and untouched model-route manifests),
`test/subscription-usage-conformance.test.ts` (the four usage cases in-process and over a loopback
socket, drills, and 401 / 429 / dropped / truncated faults through the real fetchers),
`test/email.test.ts` (answers only from fixtures, the latitude, every fail-closed reason, state
transitions, faults, reset, coverage, and seed validation), `test/email-conformance.test.ts`
(cross-check A: every email case against one shared in-process emulator and each case alone, ending
as seeded plus the documented Sent copy; one drill fault per case failing exactly that case; a
failed restore reported; fixture and manifest parity), `test/r2.test.ts` (answers only from
fixtures, the latitude, one sample per copied credential key name, credential parameter name, and
token pattern, counted against each list and checked against the shared scan, every fail-closed
reason as a refusal row asserting the constant entry (request `<redacted>`), an unchanged state, and
a match-all fault unused and still answering the next valid request, the credential guard on the
real refusal text, ledger, state, coverage, and faults (repeats raw, percent-encoded, JSON-escaped,
`\xXX`-escaped, decimal and hex HTML references, as keys, in decoded bodies, as numbers by printed
form and digit string, of any length, and of keys inside credential fields; SigV4 names and
credential parameters, encoded and escaped; bearer and API-key-shaped tokens raw, encoded, escaped,
nested, and as keys; base64 bodies holding a credential; non-canonical, non-UTF-8, and non-string
bodies, with and without a credential, refused as `uncheckable-body`; put bytes recorded only as
`bodyBytes`), own `__proto__` keys at any depth refused, cyclic and deeply nested requests answered
`uncheckable-request` without a throw, at least every string either port scan flags refused, bucket
state transitions, faults, reset, coverage, and seed validation), `test/r2-conformance.test.ts` (all
six R2 cases through the real port seam in-process, in sequence on one emulator and each alone,
ending at the seed plus the write cases' objects; a reused run id failing both writes without
writing; the credentials never reaching the ledger, state, coverage, or faults, and every ledgered
request passing both port scans; one drill fault per case failing exactly that case; the
byte-for-byte fixture replay; fixture, manifest, and seed parity), `test/fortnox.test.ts` (routes,
quirks, auth, faults through the real connector, profiles, control plane),
`test/fortnox-conformance.test.ts` (all seven Fortnox cases in-process and over a loopback socket,
the ledger showing the restores, the state-equals-seed proof for the reversible cases, and one drill
per knob), `test/microsoft.test.ts` (manifest, fail closed including nested body keys, query
allowlist, auth, credential redaction, calendar overlap, immutable ids, the concurrent-write rule,
attachments, `$batch`, folders, the copy monitor through the real connector, handler failures,
every fixture's complete envelopes, faults including 429 `retry-after`, seeds, control plane), and
`test/microsoft-conformance.test.ts` (all
eleven Microsoft cases in-process and over a loopback socket, the state-equals-seed-except-counters
proof, and the drills), `test/dropbox.test.ts` and `test/notion.test.ts` (manifest, every fixture's
complete responses byte for byte, the data copies, every fail-closed refusal (by shape and by state)
writing nothing and using no fault, origins, cursor issuance and provenance, the latitude, the
clock-safe recovery, credential and `Dropbox-API-Arg` redaction, minted values above seeded ones,
the never-reset job id under a ledger clear, faults including 429 `retry-after` through the real
connector, seeds, control plane), `test/dropbox-conformance.test.ts` and
`test/notion-conformance.test.ts` (all eight cases of each in-process with one emulator per case and
on one shared emulator, and over a loopback socket; the state-equals-seed proof; the leftover
lookups failing not-emulated on an empty listing or search and answering a planted leftover; one
drill per case failing exactly that case), `test/todoist.test.ts` and `test/telegram.test.ts`
(manifest, the fixture drift tests, the latitude, every fail-closed path refused with a genuinely
matching match-all fault installed: 400, nothing written, the fault unused and still answering the
next valid request; credentials never ledgered or echoed on the refusal paths the tables list
(Telegram: the token and its secret part in path segments, query keys and values, and plain,
percent-encoded, JSON-escaped, and numeric body forms, checked against responses and every
`/_emulate/*` read; Todoist: the bearer value in a query key or value, the path, and plain,
JSON-escaped, and numeric body keys and values); seeded-project reads and seeded-item writes
refused; seed ids in the minted namespace rejected; a `match.route` naming no manifest row
rejected at `faults.add` and `POST /_emulate/faults`; consumed and locked bodies refused as
unreadable; fault answers and refusals readable after a reset or a close; Todoist's unencodable
refusal reason answering the 500; 429 faults through the real connectors;
clock-safe recovery; seeds; control plane), and `test/todoist-conformance.test.ts` /
`test/telegram-conformance.test.ts` (cross-checks A and B: every case in-process and over a loopback
socket, each comparing every emulator's snapshot with its seed afterwards: equal except the id
counters (and the one recorded Telegram send); all seven Todoist cases run sequentially against one
shared emulator, ending at the seed except counters; a `run-<hex>` run id; the leftover lookup
failing closed (its project listing has no fixture); and one drill per case failing exactly that
case), `test/github.test.ts` (manifest, the data copies, the drift test replaying every fixture byte
for byte (status, every header, body) with minted values substituted only at exact field paths on a
second run, the latitude, every fail-closed refusal (by shape and by state) asserting a ledgered
400, an unchanged state, and an unused match-all fault that still answers the next valid request,
constant-text unrecognised shapes and Authorization headers, the bearer never ledgered or echoed
(query keys and values raw and percent-encoded, path, recorded header, plain, JSON-escaped, and
numeric body forms, checked against responses and every `/_emulate/*` read), origins, 429 faults
through the real connector, clock-safe recovery, seeds, control plane),
`test/github-conformance.test.ts` (all seven cases in-process and over a loopback socket, each
ending at its seed except the counters, the deleted comment's id, and the closed lifecycle issue;
all cases twice in sequence on one emulator; the leftover lookup failing closed; one drill per case
failing exactly that case), `test/google.test.ts` (manifest, the data copies, the drift tests above,
the latitude, the 13-character draft and send run ids and the practice-address pin, every
fail-closed refusal by shape and by state asserting a ledgered 400, an unchanged state, and an
unused match-all fault that still answers the next valid request, constant-text unrecognised shapes
and Authorization headers (all-number bearers included), the bearer never ledgered or echoed (query
keys and values, percent-encoded and JSON-escaped beside `100%`, the path, the recorded
`content-type` header, plain, JSON-escaped, and key body forms, a draft `raw`, the multipart send
body, the base64url-decoded MIME of a draft compose or update `message.raw` (the subject holding the
bearer, a 13-character `run-<bearer>` id included), every `message.raw` the route would refuse
(line-wrapped, the standard alphabet, a stray or percent-encoded character, RFC 2047,
quoted-printable, UTF-16, and a malformed draft without the bearer) refused with the route's
declared reason, or as a repeat when it decodes cleanly to the bearer, with no `raw` in the ledger,
and stray escape introducers beside its first character, checked against the real response, the
state, and every `/_emulate/*` read), the multipart boundary parser, RFC 3339 range checks, label
ids at the edge of the minted range, seeded thread ids in a minted form, a seeded draft's thread
refused, page tokens by issuance, globally unique (never rebound after a change or reused by another
page size), and across resets, 429 faults through the real connector, clock-safe recovery (a
throwing, non-finite, or out-of-range clock), seeds and minted ids, control plane),
`test/google-conformance.test.ts` (cross-checks A and B: every case in-process and over loopback
sockets, one per origin, each emulator ending at its seed except the counters, the event cases'
cancelled events, and the one sent message; all thirteen cases sequentially on one shared emulator;
another 13-character run id; the leftover lookup failing closed before and after; and one drill per
case failing exactly that case), `test/linkedin-search.test.ts` (manifest, the data copies and error
bodies, the drift test replaying every fixture byte for byte with no substitution, alone and all in
suite order twice on one emulator, the latitude, rejected keys per origin, every fail-closed refusal
by shape and by state asserting a ledgered 400, an unchanged state, and an unused match-all fault
that still answers the next valid request, constant-text unrecognised shapes and Authorization
headers (UUID-form and all-number keys included), the bearer and the rejected keys never ledgered,
stored, or echoed (query keys and values raw and percent-encoded, the path, the recorded
`content-type` header, plain and JSON-escaped body values and keys, checked against the real
response, the state, and every `/_emulate/*` read), origins, a 429 fault through the real connector,
seed errors in constant text only (a category and a field path, for both key lists: a duplicate
search whose query is a key, a misspelled field, a made-up key, a bad value; the JS error and the
real `POST /_emulate/seed` text), percent-encoded lookup parameter names refused, a GET lookup
carrying a body refused in-process and dropped by the loopback server, control plane),
`test/linkedin-search-conformance.test.ts` (cross-checks A and B: all seven cases in-process and
over loopback sockets, one per origin, each emulator ending exactly at its seed with the expected
ledger and no key anywhere; all cases twice in sequence on one emulator in-process, and once over
the sockets; one drill per case failing exactly that case), `test/mcp.test.ts` (manifest, the data
copy and constants, the drift test above, the latitude, every refusal as a constant-text 400 with an
unchanged state and an unused match-all fault that still answers the next valid request, the
reserved invalid credential's 401 byte for byte, credential repeats (the request id, a JSON-escaped
client info, a JSON key, a percent-encoded query key, the `mcp-session-id` and `mcp-name` headers,
an unrecorded header raw, percent-encoded, and JSON-escaped, a header name) checked against the real
response, the ledger, the state, and every `/_emulate/*` read, each leaving an unused fault that
answers the next valid request, the output guard (`Bearer yolk-emu-session-1` on a fresh emulator,
`Bearer synthetic-mcp` against the discover answer, a bearer naming the minted cursor: refused with
no session, cursor, or counter change, checked against the real response text and headers,
`snapshot()`, and `/_emulate/*`), the canonical-recordings check (a respaced copy fails), the
session lifecycle and cap, cursor issuance across resets and seeds, a stale cursor refused before
any fault, row-matched status and truncation faults (a truncated `initialize` mints no session and
moves no counter; a truncated first page issues no cursor), seeds, control plane),
`test/mcp-conformance.test.ts` (every applicable case per profile through the real
`@yolk-sdk/mcp/client`, its observer, and its call gate, in-process and over a loopback socket, each
case on a fresh emulator ending at its seed except the minted sessions, and all cases twice in
sequence on one emulator; the paged listing across a reset; one drill per case failing exactly that
case on every era it changes; an SSE answer truncated before its response failing as `McpError` at
the timeout, not a hang), and `test/stateful-emulator.test.ts` (the shared wrapper's `{name+}`
parameters, raw parameter patterns matched in full (alternation and lazy quantifiers included), the
opt-in fail-closed mode over a fake core (credential-repeating requests ledgered with constant text
only, scrubbed plan-time reasons, a route's decoded body views checked like its raw body, a throwing
view refused with a declared `DecodedViewRefusal` reason, else as uncheckable with its own constant
reason, never echoing request text; `textClosureOutcome`, the predicate form of the secret closure,
agreeing with it; the opt-in per-origin `bearerDigest`, refused at build without fail-closed mode,
routes seeing only a real SHA-256 digest for the arrival origin (the expected per-origin hashes, the
bearer absent from every response, the ledger, the snapshot, and every `/_emulate/*` read), and a
digest that throws, repeats the bearer, or is no string answering the 500 with no fault used), the
constant-reason `exactBodyKeys` and `exactQuery` (with `rawNames` comparing raw parameter names, and
the raw query the wrapper hands routes), route variants (manifest rows, ledger routes, coverage,
`match.route`, build checks), truncation faults on streamed commits (`makeChunkedStatefulEmulator`;
a truncated writing row writes nothing; one that cannot apply answers 500 unused), `match.route`
naming a manifest row (a template on an emulator without variants; an unknown route or a variant
route's template rejected at `faults.add` and over `/_emulate/faults`), `constantRefusals` (no
request text before admission, a match-all fault unused), `guardOutput` (a prepared answer header, a
chunk, a straddled body, or a persisted text holding the bearer refused as the constant entry with
no write and an unused fault; a plain commit answers 500), `guardAllHeaders` (raw, percent-encoded,
and JSON-escaped repeats in any header value, and a header name), `uniqueJsonKeys` and
`repeatsJsonKey` (repeated keys raw, escaped, and nested refused; sibling objects and strings not),
the opt-in resolved mode (`resolveRequest`: refused with fail-closed mode at build; unrecognised
requests ledgered as constants with the method as sent; a refused resolution answered before the
body is read, its fields scrubbed; a path-carried token and its secret part repeated in the query,
the guarded path, a body value, a JSON-escaped value, a key, an exponent-notation number, or a
percent-encoded body refused with no body kept, no fault used, and nothing written; faults
matching, and the core seeing, only the ledgered path; the query recorded as sent), `json-or-empty`
bodies, `makeHeaderlessStatefulEmulator` (no `headers` field), `errorTexts`, and the unchanged
behaviour without these options and without fail-closed mode; resolved mode also: routes seeing
the ledgered path and no header names, `recordHeaders` and a throwing resolution, consumed and
locked bodies, fault answers and refusals readable after a reset or a close over a core that
cancels its own bodies, and an unencodable plan reason answering the 500), and
`test/stateful-public-types.test.ts` (compile coverage of the public Todoist and Telegram fault,
fault-match, fault-state, ledger-entry, and coverage types: old-shaped values, status-only ledger
faults, no `headers` field). Loopback sockets only; never call real services.
