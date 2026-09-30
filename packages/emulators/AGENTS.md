# Emulators Package

`@yolk-sdk/emulators` is an **experimental** package of emulators for outside services and the
Effect `HttpClient` routing that points code at them.

## Subpaths

| Subpath                         | Source                      | Role                                                                                                                                     |
| ------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `@yolk-sdk/emulators/router`    | `src/router.ts`             | `EmulatorRoute`, `EmulatedHttpClient.layer`, `InProcessHttpClient.layer`                                                                 |
| `@yolk-sdk/emulators/gateway`   | `src/gateway.ts`            | Vercel AI Gateway fetch-handler emulator and its route evidence manifest                                                                 |
| `@yolk-sdk/emulators/openai`    | `src/openai.ts`             | OpenAI Chat Completions fetch-handler emulator and its manifest                                                                          |
| `@yolk-sdk/emulators/anthropic` | `src/anthropic.ts`          | Anthropic Messages fetch-handler emulator and its manifest                                                                               |
| `@yolk-sdk/emulators/codex`     | `src/codex.ts`              | ChatGPT Codex Responses fetch-handler emulator and its manifest                                                                          |
| `@yolk-sdk/emulators/xai`       | `src/xai.ts`                | xAI Grok CLI proxy Responses fetch-handler emulator and its manifest                                                                     |
| `@yolk-sdk/emulators/opencode`  | `src/opencode.ts`           | OpenCode Go emulator (chat, Messages, Responses, usage under `/zen/go/v1`) and its manifest                                              |
| `@yolk-sdk/emulators/node`      | `src/node.ts`               | `serveFetchHandler` / `startFetchHandlerServer` on `127.0.0.1`                                                                           |
| (internal)                      | `src/emulator-kernel.ts`    | Shared kernel: faults, scripted turns, ledger, pull-driven bodies, control plane, evidence tagging, route binding (`makeEmulatorKernel`) |
| (internal)                      | `src/chat-completions.ts`   | Shared OpenAI-compatible Chat Completions core (`makeChatCompletionsEmulator`)                                                           |
| (internal)                      | `src/messages.ts`           | Anthropic Messages core (`makeMessagesEmulator`)                                                                                         |
| (internal)                      | `src/responses.ts`          | OpenAI Responses core (`makeResponsesEmulator`) shared by `/codex` and `/xai` (not `/opencode`, which is fixture-only)                   |
| (internal)                      | `src/fixture-route.ts`      | Fixture-only route core (`makeFixtureRouteEmulator`): recorded answers, 400 not-emulated otherwise; used by every Go and usage route     |
| (internal)                      | `src/subscription-usage.ts` | Subscription-usage `GET` routes on the fixture-only core (`makeSubscriptionUsageEmulator`) for Claude, Codex, Grok, and Go               |
| (internal)                      | `src/*-recordings.ts`       | Go and usage fixture exchanges copied as data (`opencode-recordings.ts`, `subscription-usage-recordings.ts`)                             |
| (internal)                      | `src/emulator-compose.ts`   | Path dispatch of several kernel-built parts behind one origin (`composeFetch`, `withSubscriptionUsage`)                                  |
| (internal)                      | `src/emulator-http.ts`      | Fault/scripted-error status and header validators                                                                                        |
| (internal)                      | `src/route-evidence.ts`     | `EmulatorRouteEvidence`, the evidence header, `bindRouteHandlers`                                                                        |

There is no root export or barrel.

## Boundaries

- Dependencies: `effect` only. `src` never imports `@yolk-sdk/*`, React, or Next
  (`scripts/check-package-boundaries.ts` enforces this). Tests may import `@yolk-sdk/agent` and
  `@yolk-sdk/conformance` (workspace devDependencies).
- `node:` builtins are allowed only in `src/node.ts` (also enforced).
- `router` is Effect code; `gateway`, `openai`, `anthropic`, `codex`, `xai`, and `opencode` are plain Web fetch
  handlers (no Effect runtime needed, no Node builtins); `node` is the only Node boundary.
- No top-level side effects, env reads, or network calls. `NODE_ENV` is read with `Config` inside
  `Effect.gen` when a router layer builds.
- Does not use `@emulators/core` yet; stateful connector emulators may later.

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
- Wire shapes come from the conformance fixtures (the Gateway ones are verified live recordings
  and the Gateway route is `verified`, with `test/gateway-recordings.test.ts` comparing the
  emulator's response shapes with them; the OpenAI, Anthropic, Codex, Grok, OpenCode Go, and
  subscription-usage ones are synthetic placeholders), copied as data, never imported. Each
  emulated route lists the conformance case ids it follows in its manifest
  (`gatewayEmulatorRoutes`, `openAiEmulatorRoutes`, `anthropicEmulatorRoutes`,
  `codexEmulatorRoutes`, `xAiGrokEmulatorRoutes`, `openCodeGoEmulatorRoutes`,
  `anthropicSubscriptionUsageEmulatorRoutes`, `codexSubscriptionUsageEmulatorRoutes`,
  `xAiGrokSubscriptionUsageEmulatorRoutes`). Each manifest route
  needs its own handler: `bindRouteHandlers` (`src/route-evidence.ts`) pairs them at construction
  and throws `EmulatorRouteUnmapped` for a manifest route without a handler or a handler without a
  manifest route.
- Fixture-only rule (lasting; every new emulator and route follows it): response behaviour comes
  only from the committed fixtures. A request matching a recorded request's shape, within the
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
  Codex, Grok) today, on `src/fixture-route.ts`. The earlier model routes (`/gateway`, `/openai`,
  `/anthropic`, `/codex`, `/xai` Messages and Responses) predate the rule and keep their synthetic
  behaviour and 404 fallback unchanged; do not copy that behaviour into new routes.
- Request-shape latitude (fixture-only routes, the only accepted deviations): any credential value
  (never checked or stored); extra request headers; JSON key order; any string value except the
  discriminators `model`, `role`, `type`, and `phase`; any positive integer where the recording has
  a number (the output-token limit); for `anthropic-beta` (Claude usage), a comma-separated list
  that includes `oauth-2025-04-20`; any non-empty `x-userid` and `x-grok-client-version` (Grok
  usage); for `content-type`, media-type parameters. Everything else must
  equal the recording: object keys, array lengths, booleans (`stream`, `store`, `include_usage`,
  `parallel_tool_calls`, `additionalProperties`), the `accept` value, the query string (a bare `?` counts as no query; otherwise byte for
  byte), the method,
  and the headers the SDK sends (Go chat, Responses, usage: Bearer; Go Messages: `x-api-key` and
  `anthropic-version: 2023-06-01`; Claude usage: Bearer and `anthropic-beta`; Codex usage: Bearer
  and `ChatGPT-Account-Id`; Grok usage: Bearer, `X-XAI-Token-Auth: xai-grok-cli`, `x-userid`,
  `x-grok-client-version`, and `x-grok-client-mode: headless`). Fault and scripted-error statuses on
  fixture-only routes are 400-599 only.
- Evidence policy: unknown API routes fail closed and are written to the ledger (404 JSON on the
  earlier model-route emulators, 400 not-emulated on fixture-only routes; control-plane requests
  are never recorded); unverified routes answer but carry
  `x-emulator-evidence: unverified`, are tagged in the ledger, and are listed by the evidence
  check; evidence older than 30 days warns; connector write routes need `verified` evidence with a
  readable, not-future `observedAt`, and a verified route fails when none of its cited cases has a
  `verified` fixture (the check fails otherwise).
- Emulators never redirect and always send a body: fault and scripted-error statuses exclude 1xx,
  204, 205, and 3xx; header names/values are validated and `location` is rejected when a fault or
  turn is added. Build a response before consuming its fault; a response that cannot be built
  answers an evidence-tagged 500 recorded in the ledger (`responseError`).
- Every emulator is built on `src/emulator-kernel.ts`: fault and scripted-turn state (strict
  decoding), the ledger, pull-driven bodies with `error-after-chunks` / `truncate-after-chunks`,
  status-fault and scripted-error responses, the `/_emulate/*` control plane, coverage, evidence
  tagging, and route binding (`serve` throws `EmulatorRouteUnmapped`). Wire cores add only request
  parsing, framing, their ledger fields, and wire-specific faults; do not re-implement kernel
  pieces in a core.
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
- Control-plane routes live under `/_emulate/*`. Control inputs (faults, turns) decode strictly
  (unknown keys rejected); the JS API throws `GatewayEmulatorInputInvalid` /
  `OpenAiEmulatorInputInvalid` / `AnthropicEmulatorInputInvalid` / `CodexEmulatorInputInvalid` /
  `XAiGrokEmulatorInputInvalid` / `OpenCodeGoEmulatorInputInvalid` for invalid input.
- Emulator bodies are pull-driven (one chunk per pull) and the ledger counts chunks handed over
  (network chunks; a Gateway chunk may pack several SSE events); chunk faults that cannot take
  effect answer 500 and are not consumed, never a silent no-op.
- Credential headers are never recorded; bearer and `x-api-key` values are never checked or
  stored.
- The Node server binds to `127.0.0.1` only, writes body chunks as they arrive (honoring
  backpressure), and destroys the socket when a body stream errors.
- Synthetic data only: model ids, texts, and hosts must be synthetic.

## Tests

`test/router.test.ts`, `test/router-redirects.test.ts` (redirects and `mapRequest` never escape
the route table, with a second unrouted loopback server), `test/gateway.test.ts`,
`test/openai.test.ts`, `test/chat-completions.test.ts` (shared core and per-emulator parameters,
including each emulator's streamed framing), `test/node.test.ts`, `test/gateway-conformance.test.ts` (the Gateway conformance
cases in-process and over a loopback socket, a disagreement drill, and faults through the real
provider, including 429 `retry-after` over the socket), `test/gateway-recordings.test.ts` (each
verified Gateway fixture's recorded request sent to the emulator, with the response's status,
event kinds and field names, finish/usage placement, chunk packing, and error envelope keys
compared with the recording, plus disagreement drills), `test/openai-conformance.test.ts` (the
same for the OpenAI chat cases through the generic OpenAI-compatible provider), `test/anthropic.test.ts`
(Messages framing, blocks, stops, auth, ledger, faults, control plane), and
`test/anthropic-conformance.test.ts` (the Anthropic Messages cases in-process and over a loopback
socket, disagreement drills, and 429 / 529 / mid-stream `error` event / truncation faults through
both the native Messages provider and the Claude subscription provider), `test/responses.test.ts`
(Responses framing, items, auth and Grok header rules, output-limit policy, ledger, scripted turns,
faults, control plane, and manifests for `/codex` and `/xai`), and
`test/responses-conformance.test.ts` (the Codex and Grok Responses cases in-process and over a
loopback socket, disagreement drills, and 429 `retry-after` / mid-stream `error` and
`response.failed` events / dropped connection / truncation faults through the real Codex and Grok
providers, pinning Grok's required terminal event, Codex's EOF-completion compatibility, and the
426 for a missing client version), `test/fixture-recordings.test.ts` (recordings parity: each Go
and usage fixture's recorded request answered with the recorded status, content type, event kinds
and order, field names, and content; data copies equal to the fixtures; a drift drill),
`test/opencode.test.ts` (recorded answers, the documented latitude, 400 not-emulated rejections
that leave faults and turns untouched, per-part controls, control planes, coverage, reset,
manifest), `test/opencode-conformance.test.ts` (the Go cases in-process and over a loopback socket,
the commentary replay's recorded text answer, drills, and 429 / truncation / scripted-error /
not-emulated outcomes through the real Go provider), `test/subscription-usage.test.ts` (the Claude,
Codex, and Grok usage routes: recorded bodies, not-emulated rejections, shape-checked scripted and
default bodies, faults, control plane, and untouched model-route manifests), and
`test/subscription-usage-conformance.test.ts` (the four usage cases in-process and over a loopback
socket, drills, and 401 / 429 / dropped / truncated faults through the real fetchers). Loopback sockets only; never call real services.
