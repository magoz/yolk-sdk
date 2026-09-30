# Emulators Package

`@yolk-sdk/emulators` is an **experimental** package of emulators for outside services and the
Effect `HttpClient` routing that points code at them.

## Subpaths

| Subpath                         | Source                    | Role                                                                                                                                     |
| ------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `@yolk-sdk/emulators/router`    | `src/router.ts`           | `EmulatorRoute`, `EmulatedHttpClient.layer`, `InProcessHttpClient.layer`                                                                 |
| `@yolk-sdk/emulators/gateway`   | `src/gateway.ts`          | Vercel AI Gateway fetch-handler emulator and its route evidence manifest                                                                 |
| `@yolk-sdk/emulators/openai`    | `src/openai.ts`           | OpenAI Chat Completions fetch-handler emulator and its manifest                                                                          |
| `@yolk-sdk/emulators/anthropic` | `src/anthropic.ts`        | Anthropic Messages fetch-handler emulator and its manifest                                                                               |
| `@yolk-sdk/emulators/node`      | `src/node.ts`             | `serveFetchHandler` / `startFetchHandlerServer` on `127.0.0.1`                                                                           |
| (internal)                      | `src/emulator-kernel.ts`  | Shared kernel: faults, scripted turns, ledger, pull-driven bodies, control plane, evidence tagging, route binding (`makeEmulatorKernel`) |
| (internal)                      | `src/chat-completions.ts` | Shared OpenAI-compatible Chat Completions core (`makeChatCompletionsEmulator`)                                                           |
| (internal)                      | `src/messages.ts`         | Anthropic Messages core (`makeMessagesEmulator`)                                                                                         |
| (internal)                      | `src/emulator-http.ts`    | Fault/scripted-error status and header validators                                                                                        |
| (internal)                      | `src/route-evidence.ts`   | `EmulatorRouteEvidence`, the evidence header, `bindRouteHandlers`                                                                        |

There is no root export or barrel.

## Boundaries

- Dependencies: `effect` only. `src` never imports `@yolk-sdk/*`, React, or Next
  (`scripts/check-package-boundaries.ts` enforces this). Tests may import `@yolk-sdk/agent` and
  `@yolk-sdk/conformance` (workspace devDependencies).
- `node:` builtins are allowed only in `src/node.ts` (also enforced).
- `router` is Effect code; `gateway`, `openai`, and `anthropic` are plain Web fetch handlers (no Effect runtime
  needed, no Node builtins); `node` is the only Node boundary.
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
- Wire shapes come from the recorded conformance fixtures (the Gateway ones are now verified live
  recordings the emulator is not yet aligned with, so the Gateway route stays `unverified` until
  aligned; the OpenAI ones are synthetic), copied as data,
  never imported. Each emulated route lists the conformance case ids it follows in its manifest
  (`gatewayEmulatorRoutes`, `openAiEmulatorRoutes`, `anthropicEmulatorRoutes`). Each manifest route needs its own handler: `bindRouteHandlers`
  (`src/route-evidence.ts`) pairs them at construction and throws `EmulatorRouteUnmapped` for a
  manifest route without a handler or a handler without a manifest route.
- Evidence policy: unknown emulated API routes fail closed (404 JSON, written to the ledger;
  control-plane requests are never recorded); unverified routes answer but carry
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
  and unknown-model status, 401 error, completion-token field (recorded in the ledger as
  `maxCompletionTokens`, never validated), whether reasoning is emulated, its turn schema, and its
  input-invalid error. Keep the Gateway's public API and wire behaviour unchanged when editing the
  core; `test/gateway.test.ts` is the guard. `/openai` does not emulate reasoning yet: its turn
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
  `anthropic-version` / `anthropic-beta`. Its extra fault `error-event-after-chunks` (a mid-stream
  `event: error`) applies only to streamed responses and before `message_stop`; otherwise it
  answers 500 and is kept (never a silent no-op).
- Control-plane routes live under `/_emulate/*`. Control inputs (faults, turns) decode strictly
  (unknown keys rejected); the JS API throws `GatewayEmulatorInputInvalid` /
  `OpenAiEmulatorInputInvalid` / `AnthropicEmulatorInputInvalid` for invalid input.
- Emulator bodies are pull-driven (one chunk per pull) and the ledger counts chunks handed over;
  chunk faults that cannot take effect answer 500 and are not consumed, never a silent no-op.
- Credential headers are never recorded; bearer and `x-api-key` values are never checked or
  stored.
- The Node server binds to `127.0.0.1` only, writes body chunks as they arrive (honoring
  backpressure), and destroys the socket when a body stream errors.
- Synthetic data only: model ids, texts, and hosts must be synthetic.

## Tests

`test/router.test.ts`, `test/router-redirects.test.ts` (redirects and `mapRequest` never escape
the route table, with a second unrouted loopback server), `test/gateway.test.ts`,
`test/openai.test.ts`, `test/chat-completions.test.ts` (shared core parity and per-emulator
parameters), `test/node.test.ts`, `test/gateway-conformance.test.ts` (the Gateway conformance
cases in-process and over a loopback socket, a disagreement drill, and faults through the real
provider, including 429 `retry-after` over the socket), `test/openai-conformance.test.ts` (the
same for the OpenAI chat cases through the generic OpenAI-compatible provider), `test/anthropic.test.ts`
(Messages framing, blocks, stops, auth, ledger, faults, control plane), and
`test/anthropic-conformance.test.ts` (the Anthropic Messages cases in-process and over a loopback
socket, disagreement drills, and 429 / 529 / mid-stream `error` event / truncation faults through
both the native Messages provider and the Claude subscription provider). Loopback sockets only; never call real services.
