# @yolk-sdk/emulators

> **EXPERIMENTAL.** This package is new and its API may change in any canary release, beyond the
> usual canary instability.

Emulators for outside services, for tests and local development. A route table sends an Effect
`HttpClient` to an emulator instead of the real service. Two emulators speak the OpenAI-compatible
Chat Completions wire: the Vercel AI Gateway and OpenAI itself. A third emulates Anthropic Messages,
and two more speak the OpenAI Responses wire of the subscription providers: the ChatGPT Codex
endpoint and the xAI Grok CLI proxy. The OpenCode Go emulator answers the Go chat, Messages,
Responses, and usage routes under one origin, and the Anthropic, Codex, and Grok emulators also
answer their subscription-usage endpoints; those newer routes are fixture-only (see below). One
emulator is not HTTP at all: a fixture-driven fake backend for the generic `EmailClient` port.
Emulators never import other `@yolk-sdk/*` code: their wire shapes follow conformance fixtures
(verified recordings for the Gateway, synthetic placeholders elsewhere), and each emulated route
names the conformance cases behind it. The Fortnox emulator is a stateful stand-in for the Fortnox
`/3` API that reproduces the observed quirks the Fortnox conformance cases claim.

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Install

```bash
pnpm add -D @yolk-sdk/emulators@canary effect@4.0.0-rc.115
```

## Subpaths

There is no root export. Import an explicit subpath:

| Subpath                         | Purpose                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@yolk-sdk/emulators/router`    | `EmulatorRoute`, `EmulatedHttpClient.layer`, `InProcessHttpClient.layer` (Effect; no Node builtins)         |
| `@yolk-sdk/emulators/gateway`   | `makeGatewayEmulator`, `gatewayEmulatorRoutes`, fault and scripted-turn schemas (plain fetch handler)       |
| `@yolk-sdk/emulators/openai`    | `makeOpenAiEmulator`, `openAiEmulatorRoutes`, fault and scripted-turn schemas (plain fetch handler)         |
| `@yolk-sdk/emulators/anthropic` | `makeAnthropicEmulator`, `anthropicEmulatorRoutes`, fault and scripted-turn schemas (plain fetch handler)   |
| `@yolk-sdk/emulators/codex`     | `makeCodexEmulator`, `codexEmulatorRoutes`, fault and scripted-turn schemas (ChatGPT Codex Responses)       |
| `@yolk-sdk/emulators/xai`       | `makeXAiGrokEmulator`, `xAiGrokEmulatorRoutes`, fault and scripted-turn schemas (Grok CLI proxy Responses)  |
| `@yolk-sdk/emulators/opencode`  | `makeOpenCodeGoEmulator`, `openCodeGoEmulatorRoutes` (OpenCode Go chat, Messages, Responses, and usage)     |
| `@yolk-sdk/emulators/email`     | `makeEmailEmulator`, `emailEmulatorRoutes`, seed and fault schemas (plain-JSON `EmailClient` backend)       |
| `@yolk-sdk/emulators/node`      | `serveFetchHandler` (scoped Effect) and `startFetchHandlerServer` (Promise): serve a handler on `127.0.0.1` |
| `@yolk-sdk/emulators/fortnox`   | `makeFortnoxEmulator`, `fortnoxEmulatorRoutes`, `fortnoxEmulatorQuirks`, seed and fault schemas (Node only) |

## Routing

Pick a transport by swapping `HttpClient` layers. Code under test keeps calling the real origin.

| Transport | Layer                                     | What happens                                                             |
| --------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| Replay    | `@yolk-sdk/conformance/replay`            | Recorded fixtures, offline                                               |
| InProcess | `InProcessHttpClient.layer(routes)`       | Calls the emulator's fetch handler directly (no sockets)                 |
| Emulated  | `EmulatedHttpClient.layer(routes)`        | Rewrites the origin to a loopback emulator process, over your own client |
| Live      | your own `HttpClient` (for example Fetch) | The real service                                                         |

```ts
import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { makeGatewayEmulator } from '@yolk-sdk/emulators/gateway'
import { serveFetchHandler } from '@yolk-sdk/emulators/node'
import { EmulatedHttpClient, EmulatorRoute, InProcessHttpClient } from '@yolk-sdk/emulators/router'

const gateway = makeGatewayEmulator()

// In-process: no sockets.
const inProcess = InProcessHttpClient.layer([
  EmulatorRoute.handler('https://ai-gateway.vercel.sh', gateway.fetch)
])

// Emulated: a real loopback server under the host's FetchHttpClient.
const emulated = Layer.unwrap(
  serveFetchHandler(gateway.fetch).pipe(
    Effect.map(server =>
      EmulatedHttpClient.layer([
        EmulatorRoute.url('https://ai-gateway.vercel.sh', server.url)
      ]).pipe(Layer.provide(FetchHttpClient.layer))
    )
  )
)
```

Both layers:

- keep the request path and query, and fail closed on any origin without a route with an
  `HttpClientError` whose message names only the origin;
- reject malformed or duplicate origins at build time (`EmulatorRouteInvalid`);
- refuse to build when `NODE_ENV` is `production` or cannot be read (`EmulatorEnvironmentRefused`);
  a missing `NODE_ENV` is allowed.

`EmulatedHttpClient` also requires every `baseUrl` to be `http(s)` on loopback (`127.0.0.0/8`,
`::1`, or `localhost`; IPv4-mapped forms such as `[::ffff:127.0.0.1]` are rejected) and needs your
real `HttpClient` underneath. `InProcessHttpClient` sends `Empty`, `Uint8Array`, and string `Raw`
bodies; other body kinds fail with an `EncodeError`.

Redirects never leave the route table. `EmulatedHttpClient` checks and rewrites each request at the
send step, so redirect follow-ups (`HttpClient.followRedirects` on top) and requests changed by
your own `HttpClient.mapRequest` are routed or fail closed too. With `FetchHttpClient` underneath,
routed requests are sent with `redirect: 'manual'`, so a 3xx comes back to the caller as a 3xx.
Other `FetchHttpClient.RequestInit` defaults are kept when provided around the whole client stack
(or where the request runs); defaults provided only to `FetchHttpClient.layer` itself are replaced.
Put `HttpClient.followRedirects` on top of `EmulatedHttpClient`, never underneath it. **Any other
underlying client must not follow redirects by itself**: a redirect it follows internally never
passes through the route table.

## Gateway emulator

`makeGatewayEmulator(options?)` returns `{ fetch, ledger, reset, faults, script, coverage }` for
`POST /v1/chat/completions`. Each call has its own state. Its wire shapes follow the verified live
Gateway recordings (2026-09-30) in `@yolk-sdk/agent/providers/vercel/conformance`, and its route is
`verified`; ids, costs, and routing metadata are synthetic stand-ins.

Defaults (no script):

- `knownModels` defaults to a small synthetic-safe list including `openai/gpt-4.1-nano`,
  `deepseek/deepseek-v3.2`, and `deepseek/deepseek-v4.1-flash`; `reasoningModels` defaults to the
  two DeepSeek ids.
- `stream: true` streams `chat.completion.chunk` server-sent events as recorded: a
  `{ role: 'assistant' }` opening delta, several text deltas, then one finish event whose `delta`
  carries `provider_metadata` (the recorded upstream entry, `openai` for `openai/*` models or
  `baseten` for `deepseek/*` models, then a `gateway` routing and cost entry, all synthetic) and
  which carries `usage` (when `stream_options.include_usage` is set), `system_fingerprint`,
  `service_tier` (`openai/*` models only), and `generationId`, followed only by `data: [DONE]`.
  Every chunk carries `system_fingerprint`, and every choice `logprobs: null`.
  `stream: false` returns one `chat.completion` JSON body (not covered by a recording).
- Events are packed several per network chunk, as the live Gateway sends them: `eventsPerChunk`
  (default 2, a positive integer; 1 sends one event per chunk) counted from the end, so the last
  chunk carries the finish event and `data: [DONE]` together and the first chunk may carry fewer.
  Chunk faults count these network chunks. An invalid `eventsPerChunk` throws
  `GatewayEmulatorInputInvalid`.
- A reasoning model asked for reasoning (`reasoning_effort`, or `thinking: { type: 'enabled' }`)
  streams `delta.reasoning` with `delta.reasoning_details`
  (`[{ type: 'reasoning.text', text, format, index }]`) before the text.
- A request with `tools` gets one tool call whose arguments are synthesized from the tool's JSON
  Schema (required string properties get non-empty synthetic values), streamed as several
  `delta.tool_calls[].function.arguments` fragments, finishing with `tool_calls`. A `tool_choice`
  naming an offered function picks that tool (otherwise the first); `tool_choice: 'none'` answers
  with text.
- An unknown model gets the recorded 404 envelope
  `{ error: { message: "Model '<id>' not found", type: 'model_not_found', param: { modelId } } }`
  (no `code`).
- A missing `Authorization: Bearer <non-empty>` header gets a 401 envelope
  `{ error: { message, type, code } }` (synthetic, not recorded). The token is never checked or
  stored.
- Unknown routes get a 404 JSON error (fail closed) and are written to the ledger.

`script.enqueue(turn)` queues a turn for the next chat request, sent exactly as given:

- a completion: `{ text?, reasoning?, reasoningField?, order?, toolCalls?, usage?, finishReason? }`
  where each tool call is `{ name, argumentFragments }`, `usage: null` drops usage from the finish
  event, `order: 'text-first'` sends reasoning after the text, and `reasoningField` defaults to
  `reasoning` (with `reasoning_details`; `reasoning_content` sends the DeepSeek-native field alone);
- an error: `{ error: { status, body, headers? } }`.

Emulators never redirect, and every emulated response carries a body. Fault and scripted-error
statuses must be 200–599 without 204, 205, or any 3xx (including 304); header names must be HTTP
tokens, values must not contain control characters, and `location` is rejected. Invalid input
throws `GatewayEmulatorInputInvalid` (the control plane answers 400).

`faults.add(fault)` adds a wire fault with an optional `match: { path?, model? }` (`path` ending in
`*` is a prefix) and an optional `count`:

| Fault                   | Effect                                                                    |
| ----------------------- | ------------------------------------------------------------------------- |
| `status`                | Answer with a status, headers, and body (for example 429 + `retry-after`) |
| `error-after-chunks`    | Send N body chunks, then error the body stream (a dropped connection)     |
| `truncate-after-chunks` | Send N body chunks, then close cleanly (no `data: [DONE]`)                |

Chunk faults count network chunks: with the default packing, `truncate-after-chunks` with N = 2
sends up to four events (four for the default plain-text response). A chunk fault that cannot
take effect answers 500 instead of silently doing nothing. If the emulator cannot build a planned
response, it answers an evidence-tagged 500, the ledger records 500 with `responseError`, and the
matching fault is not used up.

`ledger.entries()` records every emulated API request (control-plane requests are not recorded):
method, path, parsed JSON body, model, `stream`, the `max_tokens` limit (as `maxCompletionTokens`;
recorded, never validated), `reasoning_effort`, `thinking`, tool names, the fault applied, the route's evidence tag, the status actually sent, and the body chunks handed over
so far. Credential headers are never recorded.

Control plane (same fetch handler):

| Route                | Methods                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `/_emulate/ledger`   | `GET`, `DELETE`                                                  |
| `/_emulate/faults`   | `GET`, `POST`, `DELETE` (`POST` takes one fault or `{ faults }`) |
| `/_emulate/script`   | `POST` (one turn or `{ turns }`)                                 |
| `/_emulate/reset`    | `POST`                                                           |
| `/_emulate/state`    | `GET`                                                            |
| `/_emulate/coverage` | `GET` (the route evidence manifest with request counts)          |

## OpenAI emulator

`makeOpenAiEmulator(options?)` returns the same `{ fetch, ledger, reset, faults, script, coverage }`
shape for OpenAI Chat Completions: `POST /v1/chat/completions`, routed from
`https://api.openai.com`. It shares the Gateway emulator's Chat Completions core, so tool-call
fragments, JSON mode, faults, scripted turns, the ledger, and the control plane behave the same.
What differs:

- Streaming uses the plain OpenAI framing: one event per network chunk, a
  `{ role: 'assistant', content: '' }` opening delta, and usage in a trailing chunk with empty
  `choices`, without the Gateway's metadata fields.
- `knownModels` defaults to `openAiEmulatorDefaultModels` (`gpt-4.1-nano`, `gpt-4.1-mini`).
- Errors use the OpenAI envelope `{ error: { message, type, param, code } }`; an unknown model gets
  404 with code `model_not_found`, and a missing `Authorization: Bearer <non-empty>` header gets
  401 with code `invalid_api_key`. The token is never checked or stored.
- The ledger records `max_completion_tokens` as `maxCompletionTokens` (never validated).
- Reasoning models are not emulated yet: no default output streams reasoning, scripted turns
  reject `reasoning`, `reasoningField`, and `order`, and `/_emulate/state` has no `reasoningModels`.
- Invalid faults or turns throw `OpenAiEmulatorInputInvalid`.

```ts
import { makeOpenAiEmulator } from '@yolk-sdk/emulators/openai'
import { EmulatorRoute, InProcessHttpClient } from '@yolk-sdk/emulators/router'

const openai = makeOpenAiEmulator()

const httpLayer = InProcessHttpClient.layer([
  EmulatorRoute.handler('https://api.openai.com', openai.fetch)
])
```

`openAiEmulatorRoutes` links the route to the OpenAI chat conformance cases in
`@yolk-sdk/agent/providers/openai/conformance`.

## Anthropic emulator

`makeAnthropicEmulator(options?)` returns the same `{ fetch, ledger, reset, faults, script,
coverage }` shape for Anthropic Messages: `POST /v1/messages`, routed from
`https://api.anthropic.com`. Faults, the ledger, the control plane, evidence tagging, and route
binding are shared with the Chat Completions emulators; the Messages wire is its own:

- `stream: true` streams the Messages events in API order (block order and `ping` placement are
  emulator choices until a live recording): `message_start` (with input
  usage), then per content block `content_block_start`, its deltas, and `content_block_stop` (a
  `ping` follows the first block start), then `message_delta` (`stop_reason`, and usage: input
  and cache counts next to the cumulative `output_tokens`, as the unverified fixtures record it)
  and `message_stop`. `stream: false` returns one `message` JSON body.
- `thinking: { type: 'enabled' | 'adaptive' }` adds a `thinking` block (`thinking_delta` events,
  then one `signature_delta`) before the answer.
- A request with `tools` gets one `tool_use` block whose input is synthesized from the tool's
  `input_schema` and streamed as `input_json_delta` fragments (the first one empty), stopping with
  `tool_use`. `tool_choice: { type: 'tool', name }` picks that tool (otherwise the first);
  `tool_choice: { type: 'none' }` answers with text. `thinking` together with a forced
  `tool_choice` (`tool` or `any`) gets 400 `invalid_request_error`.
- An answer that would not fit `max_tokens` (about four characters per token) is cut and stops
  with `max_tokens`. A missing or non-positive `max_tokens` gets 400 `invalid_request_error`.
- Errors use `{ type: 'error', error: { type, message } }`; an unknown model gets 404
  `not_found_error`.
- Authentication accepts a non-empty `x-api-key` (native API keys) or `Authorization: Bearer`
  (Claude OAuth); anything else gets 401 `authentication_error`. Neither value is checked or
  stored. The ledger records which header carried it (`credentialHeader`), `anthropic-version`,
  `anthropic-beta`, `max_tokens` (`maxTokens`), `thinking`, `tool_choice`, and tool names.
- `anthropic-version` must be `2023-06-01` (the value the SDK providers send by default); a missing or
  other value gets 400 `invalid_request_error`.
- Not enforced: the OAuth `anthropic-beta` header for bearer credentials, and `budget_tokens`
  limits.
- `knownModels` defaults to `anthropicEmulatorDefaultModels` (`claude-haiku-4-5`,
  `claude-sonnet-4-5`). Invalid faults or turns throw `AnthropicEmulatorInputInvalid`.

`script.enqueue(turn)` queues a message `{ thinking?, text?, toolUses?, order?, usage?,
stopReason? }` (each tool use is `{ name, inputFragments, id? }`; a block is sent only when its
field is present; `usage: null` drops usage; `order: 'text-first'` sends thinking after the text;
`stopReason` defaults to `tool_use` with tool uses, else `end_turn`) or an error
`{ error: { status, body, headers? } }`.

`faults.add(fault)` takes the shared `status`, `error-after-chunks`, and `truncate-after-chunks`
kinds (a `status` fault's default body is the Anthropic envelope for the status, for example
`rate_limit_error` for 429 and `overloaded_error` for 529), plus `error-event-after-chunks`: send N
events, then one `event: error` (default `overloaded_error`, or `error: { type, message }`) and
close without `message_stop`. It applies to streamed responses only and must come before
`message_stop`; otherwise the request answers 500 and the fault is kept.

```ts
import { makeAnthropicEmulator } from '@yolk-sdk/emulators/anthropic'
import { EmulatorRoute, InProcessHttpClient } from '@yolk-sdk/emulators/router'

const anthropic = makeAnthropicEmulator()

anthropic.faults.add({ kind: 'status', status: 529, count: 1 })

const httpLayer = InProcessHttpClient.layer([
  EmulatorRoute.handler('https://api.anthropic.com', anthropic.fetch)
])
```

`anthropicEmulatorRoutes` links the route to the Anthropic Messages conformance cases in
`@yolk-sdk/agent/providers/anthropic/conformance`.

## Responses emulators (Codex, xAI Grok)

`makeCodexEmulator(options?)` (`@yolk-sdk/emulators/codex`) and `makeXAiGrokEmulator(options?)`
(`@yolk-sdk/emulators/xai`) return the same `{ fetch, ledger, reset, faults, script, coverage }`
shape for the OpenAI Responses wire the subscription providers use:

| Subpath  | Origin and route                                           | Default models           |
| -------- | ---------------------------------------------------------- | ------------------------ |
| `/codex` | `https://chatgpt.com`, `POST /backend-api/codex/responses` | `gpt-5.4`, `gpt-5.5`     |
| `/xai`   | `https://cli-chat-proxy.grok.com`, `POST /v1/responses`    | `grok-build`, `grok-4.6` |

Both share one internal Responses core on the emulator kernel, so faults, the ledger, the control
plane, evidence tagging, and route binding behave as for the other emulators. The Responses wire:

- Requests carry `model`, an `input` string or array (400 without one), `instructions`, `tools`,
  `tool_choice`, `reasoning`, `stream`, `store`, and `max_output_tokens`.
- `stream: true` streams server-sent events with typed `event:` names and a `sequence_number`, in
  the API's order: `response.created`, `response.in_progress`, then per output item
  `response.output_item.added`, its parts and deltas, and `response.output_item.done`, then
  `response.completed` with the full `response` (output items and `usage`). `stream: false`
  returns one completed `response` JSON body.
- A request whose `reasoning` asks for a `summary` gets a `reasoning` item first
  (`response.reasoning_summary_part.added`, `response.reasoning_summary_text.delta` / `.done`,
  `response.reasoning_summary_part.done`). Answers are a `message` item
  (`response.content_part.added`, `response.output_text.delta` / `.done`,
  `response.content_part.done`).
- A request with function `tools` gets one `function_call` item whose arguments are synthesized
  from the tool's JSON Schema and streamed as `response.function_call_arguments.delta` fragments,
  then `response.function_call_arguments.done`. `tool_choice: { type: 'function', name }` picks
  that tool (otherwise the first); `tool_choice: 'none'` answers with text.
- Errors use the envelope `{ error: { message, type, param, code } }`; an unknown model gets 400
  `model_not_found`, and a request without `Authorization: Bearer <non-empty>` gets 401
  `invalid_api_key`. The bearer is never checked or stored.
- `/codex`: `max_output_tokens` gets 400 `unsupported_parameter` (the Codex endpoint takes no output
  limit); the ledger records the `originator` header. `ChatGPT-Account-Id` is neither required nor
  recorded.
- `/xai`: after the bearer, a missing `X-XAI-Token-Auth` gets 401, a missing
  `x-grok-client-version` gets 426 (the proxy version-gates requests), and a missing
  `x-grok-model-override` gets 400. The ledger records the client version and model override, never
  the token-auth value. `max_output_tokens` must be a positive integer (or 400) and is recorded as
  `maxOutputTokens`, not enforced.
- Not enforced (unverified leniency): `store: false`, `stream: true`, `instructions`, that the model
  override matches `model`, the client version value, and output limits.

`script.enqueue(turn)` queues a response `{ reasoning?, text?, functionCalls?, order?, usage?,
format? }` (each function call is `{ name, argumentFragments, callId? }`; an item is sent only when
its field is present; `usage: null` drops usage from `response.completed`; `order: 'text-first'`
sends reasoning after the text; `format: 'json'` answers a JSON body even for `stream: true`, as
the JSON fallback the providers accept) or an error `{ error: { status, body, headers? } }`.

`faults.add(fault)` takes the shared `status`, `error-after-chunks`, and `truncate-after-chunks`
kinds (for example 429 with `retry-after`, or truncation before `response.completed`), plus
`error-event-after-chunks`: send N events, then one `error` event (default) or, with
`event: 'response.failed'`, a `response.failed` event, carrying `error: { code, message }`
(default `server_error`), and close without `response.completed`. It applies to streamed responses
only and must come before `response.completed`; otherwise the request answers 500 and the fault is
kept. Invalid faults or turns throw `CodexEmulatorInputInvalid` / `XAiGrokEmulatorInputInvalid`.

```ts
import { makeXAiGrokEmulator } from '@yolk-sdk/emulators/xai'
import { EmulatorRoute, InProcessHttpClient } from '@yolk-sdk/emulators/router'

const grok = makeXAiGrokEmulator()

grok.faults.add({ kind: 'truncate-after-chunks', chunks: 5, count: 1 })

const httpLayer = InProcessHttpClient.layer([
  EmulatorRoute.handler('https://cli-chat-proxy.grok.com', grok.fetch)
])
```

`codexEmulatorRoutes` and `xAiGrokEmulatorRoutes` link each route to the Responses conformance
cases in `@yolk-sdk/agent/providers/openai/conformance` (Codex) and
`@yolk-sdk/agent/providers/xai/conformance` (Grok).

## Fixture-only routes

The OpenCode Go routes and the Claude, Codex, and Grok subscription-usage routes follow a stricter
rule than the earlier model routes (whose behaviour above is unchanged): response behaviour comes
only from the committed conformance fixtures.

- A request that matches a recorded request's shape, within the request-shape latitude below,
  gets that fixture's recorded response, copied as data: the same status, headers, chunks, and
  bytes.
- Everything else answers one 400 not-emulated, written to the ledger (`notEmulated`) and using up
  no fault or turn: `{ error: { type: 'not_emulated', message: 'Not emulated: <reason>' } }`. That
  covers unknown routes and methods, missing or invalid credentials, missing or other headers and
  query parameters, unknown models, non-streamed modes, tools, reasoning, extra fields, and
  anything else no fixture records. No provider status, envelope, or error code is guessed.
- Test controls: the shared faults (`status`, `error-after-chunks`, `truncate-after-chunks`; a
  `status` fault without a body answers `{ error: { type: 'emulator_fault', message } }`) and
  scripted error turns `{ error: { status, body, headers? } }`. Usage routes also take a scripted
  `{ usage }` body and a `subscriptionUsage` option, both required to keep the recorded JSON shape
  (the same keys and value kinds; only values change).
- Request-shape latitude (the only accepted deviations): any credential value (never checked or
  stored); extra request headers; JSON key order; any string value except the discriminators
  `model`, `role`, `type`, and `phase`; any positive integer where the recording has a number (the
  output-token limit); an `anthropic-beta` list that includes `oauth-2025-04-20` (Claude usage);
  any non-empty `x-userid` and `x-grok-client-version` (Grok usage); `content-type` parameters. Object keys, array lengths, booleans (`stream`, `store`,
  `include_usage`, `parallel_tool_calls`, `additionalProperties`), `accept`, the query string (byte
  for byte; a bare `?` counts as no query), the method, `X-XAI-Token-Auth: xai-grok-cli`, and `x-grok-client-mode: headless` must
  equal the recording or the SDK's fixed value. Faults and scripted errors on these routes take
  statuses of 400-599 only.

All fixtures behind these routes are synthetic and the routes are `unverified`.

## OpenCode Go emulator

`makeOpenCodeGoEmulator(options?)` (`@yolk-sdk/emulators/opencode`) answers the origin
`https://opencode.ai` with one fetch handler for the routes the OpenCode Go provider and usage
fetcher call under `/zen/go/v1`. Each route is fixture-only and answers its Go conformance fixture:

| Route                              | Headers the provider sends                   | Recorded answer                                                     |
| ---------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| `POST /zen/go/v1/chat/completions` | `Authorization: Bearer`                      | Streamed plain text with a usage chunk and `data: [DONE]`           |
| `POST /zen/go/v1/messages`         | `x-api-key`, `anthropic-version: 2023-06-01` | Streamed plain text ending with `message_stop`                      |
| `POST /zen/go/v1/responses`        | `Authorization: Bearer`                      | Streamed plain text, or (replayed tool turn) a streamed text answer |
| `GET /zen/go/v1/usage`             | `Authorization: Bearer`                      | `usage.rolling` / `weekly` / `monthly` as `{ percent, resetsAt }`   |

Only the recorded models are emulated (`openCodeGoEmulatorDefaultModels`: `synthetic-go-chat`,
`synthetic-go-messages`, `synthetic-go-responses`, one per protocol). It returns
`{ fetch, reset, coverage, chat, messages, responses, usage }`: each part is a full emulator API
(`ledger`, `faults`, `script`, `coverage`, its own `fetch`), and over HTTP its control plane is
`/_emulate/<chat|messages|responses|usage>/*`. `coverage()` and `GET /_emulate/coverage` combine
all four routes; `reset()` and `POST /_emulate/reset` reset every part. Requests on no route
answer 400 not-emulated, ledgered by the chat part. `openCodeGoUsageDefault` is the recorded usage
body; `options.subscriptionUsage` replaces it with a same-shaped body. Invalid input throws
`OpenCodeGoEmulatorInputInvalid`.

```ts
import { makeOpenCodeGoEmulator } from '@yolk-sdk/emulators/opencode'
import { EmulatorRoute, InProcessHttpClient } from '@yolk-sdk/emulators/router'

const go = makeOpenCodeGoEmulator()

go.responses.faults.add({ kind: 'status', status: 429, headers: { 'retry-after': '2' }, count: 1 })

const httpLayer = InProcessHttpClient.layer([
  EmulatorRoute.handler('https://opencode.ai', go.fetch)
])
```

`openCodeGoEmulatorRoutes` links the four routes to the cases in
`@yolk-sdk/agent/providers/opencode/conformance`.

## Subscription-usage routes

The router takes one route per origin, so the usage endpoint of each subscription provider is
served by the emulator already bound to its origin, with its own manifest, ledger, faults, turns,
and coverage (`emulator.usage`, control plane `/_emulate/usage/*`). The model route's manifest,
coverage, and top-level `ledger` / `faults` / `script` are unchanged; the emulator types gain
`usage` and a `subscriptionUsage` option, and `reset()` and `POST /_emulate/reset` reset both.
Each usage route is fixture-only: a request with the headers the SDK fetcher sends, the recorded
`accept: application/json`, and the recorded query gets the recorded body (`*SubscriptionUsageDefault`);
anything else answers 400 not-emulated. Credential and account values are never recorded, and
are not checked except Grok's fixed `X-XAI-Token-Auth: xai-grok-cli`.

| Emulator     | Route                            | Headers the fetcher sends (all required)                                              | Recorded body                                            |
| ------------ | -------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `/anthropic` | `GET /api/oauth/usage`           | Bearer, `anthropic-beta` listing `oauth-2025-04-20`                                   | `five_hour`, `seven_day` as `{ utilization, resets_at }` |
| `/codex`     | `GET /backend-api/wham/usage`    | Bearer, `ChatGPT-Account-Id`                                                          | `rate_limit.primary_window` / `secondary_window`         |
| `/xai`       | `GET /v1/billing?format=credits` | Bearer, `X-XAI-Token-Auth`, `x-userid`, `x-grok-client-version`, `x-grok-client-mode` | `config.creditUsagePercent` and `config.currentPeriod`   |
| `/opencode`  | `GET /zen/go/v1/usage`           | Bearer                                                                                | `usage.rolling` / `weekly` / `monthly`                   |

The ledger records `anthropic-beta` (Claude) and `x-grok-client-version` / `x-grok-client-mode`
(Grok), never `ChatGPT-Account-Id` or `x-userid`. The manifests
`anthropicSubscriptionUsageEmulatorRoutes`, `codexSubscriptionUsageEmulatorRoutes`,
`xAiGrokSubscriptionUsageEmulatorRoutes`, and the usage route of `openCodeGoEmulatorRoutes` cite
the usage snapshot cases of each vendor's conformance subpath.

## Email emulator

`makeEmailEmulator({ seed? })` is an in-memory fake backend for the generic `EmailClient` port of
`@yolk-sdk/connectors/email`. Yolk never speaks IMAP, POP3, or SMTP, and neither does this
emulator: there is no socket, TLS, MIME, or mail library, no Node builtin, and no SDK import. It is
a plain object whose `call(method, request)` takes one port call as plain JSON (the request without
credential fields) and answers `{ response }`, `{ failure }`, or `{ notEmulated: { reason } }`.
`emailClientLayerFromBackend(emulator)` from `@yolk-sdk/connectors/email/conformance` turns it
into the `EmailClient` layer, so the email conformance cases and your own tests run the real
connector actions against it:

```ts
import { Layer } from 'effect'
import { emailClientLayerFromBackend } from '@yolk-sdk/connectors/email/conformance'
import { makeEmailEmulator } from '@yolk-sdk/emulators/email'

const email = makeEmailEmulator()

email.faults.add({
  kind: 'failure',
  method: 'move',
  count: 1,
  failure: { kind: 'error', code: 'transport_failed', message: 'Synthetic outage.' }
})

const emailLayer = emailClientLayerFromBackend(email)
```

Responses come only from the email conformance fixtures (copied as data; `emailEmulatorFixtures`).
The emulator keeps a mailbox (`emailEmulatorDefaultSeed`: folders with `\Drafts`, `\Sent`, and
`\Trash` SPECIAL-USE attributes and two INBOX messages) that only decides which fixture answers:
the first fixture whose method and request match and whose answer is consistent with the mailbox
(preferring one not used since the last reset). The mailbox then records what that fixture says
happened: flags set, a draft appended, a message moved to the destination id the fixture names, a
message deleted, a Sent copy saved. It never invents an id, flag, or response.

- Request-shape latitude: credential fields are never compared or recorded, and `connection.host`
  is not compared, so a different practice host still matches. Every other connection field
  (`protocol`, `port`, `security`) and everything else must equal a fixture request exactly.

Anything else fails closed with a ledgered `notEmulated` answer (the port analogue of HTTP 400):
an unknown method (`unknown-method`), a request that is not an object (`invalid-request`), no
matching fixture (`no-matching-fixture`), or no matching fixture consistent with the mailbox
(`state-conflict`). Faults (`kind: 'failure'`, a `method`, an optional deep-subset `match` on the
request, an optional `count`, and the `failure` to answer) change no state. `ledger` records every
call (credential-free request, outcome, fixture or fault id, reason), `state()` returns the current
mailbox, `reset()` restores the seed and clears the ledger, faults, and fixture use, and
`coverage()` reports calls per route, refusals, and unused fixtures. An invalid seed or fault
throws `EmailEmulatorInputInvalid`.

`emailEmulatorRoutes` names each emulated method as `PORT EmailClient.<method>` with the email
cases it follows. All routes are unverified: the fixtures are synthetic. Live verification needs a
host `EmailClient` implementation connected to a practice mailbox.

## Fortnox emulator

> **Node only.** `@yolk-sdk/emulators/fortnox` runs on the upstream
> [`@emulators/core`](https://github.com/vercel-labs/emulate) custom runtime (Apache-2.0, pinned to
> exactly `0.12.0`), which imports Node builtins. The core is loaded lazily by
> `makeFortnoxEmulator`, so importing the subpath has no side effects.

`await makeFortnoxEmulator(options?)` returns
`{ fetch, baseUrl, ledger, faults, reset, seed, snapshot, coverage, close }`. Each call has its own
state; `await close()` when done. Serve `fetch` in-process (`InProcessHttpClient`) or on loopback
(`serveFetchHandler`) and route `https://api.fortnox.se` to it; the Fortnox connector runs
unchanged.

```ts
import { Layer } from 'effect'
import { makeFortnoxEmulator } from '@yolk-sdk/emulators/fortnox'
import { EmulatorRoute, InProcessHttpClient } from '@yolk-sdk/emulators/router'

const fortnox = await makeFortnoxEmulator()

const httpLayer = InProcessHttpClient.layer([
  EmulatorRoute.handler('https://api.fortnox.se', fortnox.fetch)
])
// ...run the code under test, then:
await fortnox.close()
```

Routes (base path `/3`, JSON bodies, `Authorization: Bearer <non-empty>`; a missing bearer gets a
401 `ErrorInformation`, and the token is never stored, forwarded, or ledgered):

| Route                                      | Behavior                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `GET /3/companyinformation`                | `{ CompanyInformation }`                                                                                             |
| `GET /3/customers`                         | Search (`name`, `email`, `city`, ...), `filter` (`active`/`inactive`), `page`/`limit`, `MetaInformation`             |
| `GET`, `PUT /3/customers/{CustomerNumber}` | `{ Customer }` envelope                                                                                              |
| `GET /3/invoices`                          | Filters `unbooked`, `unpaid`, `unpaidoverdue`, `fullypaid`, `cancelled`; search; `fromdate`/`todate`; `page`/`limit` |
| `GET`, `PUT /3/invoices/{DocumentNumber}`  | `{ Invoice }` envelope with rows                                                                                     |
| `POST /3/invoices`                         | Create (201); an unknown `CustomerNumber` gets 400 `ErrorInformation` code `2000433`                                 |
| `GET /3/invoices/{DocumentNumber}/preview` | A small synthetic PDF (`application/pdf`); does not mark the invoice sent                                            |
| `GET /3/invoices/{DocumentNumber}/email`   | Marks the invoice `Sent` and records an outbox entry in state; never sends anything                                  |

`GET /3/companyinformation` and `GET /3/customers` have no recorded fixture: they cite no
conformance case ids, use minimal shapes named after the connector's read fields, and are
unverified, uncited read routes (the evidence check warns about them).

Anything else fails closed with a 404 `ErrorInformation` (ledgered); unsupported query parameters
(checked per route before it runs, so a rejected write writes nothing), unknown filters, unknown or
read-only body fields, and values the emulated company does not have (non-SEK currency, including
the currency a new invoice inherits from its customer; cost centers) get a 400 `ErrorInformation`
instead of being ignored. Customer categorical values are limited to the emulated subset (not
Fortnox's full enums): `VATType` `SEVAT`, `Type` `COMPANY` or `PRIVATE`, and `TermsOfPayment` as
whole days from `0` to `365`. Other values (named terms such as `K`, export or reverse-charge VAT)
get a 400 on a customer update, and a new invoice is rejected with a 400 before anything is
written when the customer it inherits from (a seed can hold anything) carries a `VATType` or
`TermsOfPayment` outside the subset, or when its
computed due date is not a representable `YYYY-MM-DD` date. An empty string still keeps the
stored value. The list filter
`lastmodified` (the connector's `lastModified` input) is not emulated: the emulator tracks no
modification times and answers it with a 400 saying so. Errors use the lowercase `{ ErrorInformation: { error, message, code } }` of the rejection
fixture; `fortnoxEmulatorErrorCodes` lists the codes (the `2999xxx` ones are synthetic).

Observed quirks (`fortnoxEmulatorQuirks`, each tied to its conformance case):

1. **Row discount sticky** (`fortnox.invoice.row-discount-sticky`): `InvoiceRows` replaces the rows;
   rows without `RowId` match existing rows by position; a matched row that omits
   `Discount`/`DiscountType` keeps them; `Discount: 0` clears. RowIds are regenerated on every
   update, and totals are recomputed (`Price × DeliveredQuantity × (1 − discount%)`, VAT 25% by
   default, `Total` rounded to whole kronor).
2. **Empty string keeps value** (`fortnox.customer.empty-string-keeps-value`): a customer update with
   `""` keeps the stored value; omitted fields keep theirs.
3. **Payment filters exclude unbooked** (`fortnox.invoice.payment-filters-exclude-unbooked`):
   `unpaid`, `unpaidoverdue`, and `fullypaid` consider booked invoices only; `unpaidoverdue` needs a
   `DueDate` before today (the injectable `now` clock, UTC).
4. **Rejection** (`fortnox.write.rejection-error-information`): writes for unknown customers or with
   invalid fields answer 400 `ErrorInformation`.
5. **Read-only `Country`**: sending a customer `Country` answers 400 (no conformance case yet).

State and seeds: company information, customers, and invoices with rows, plus the email outbox.
The default seed is the synthetic fixture entities, with the same customer and document numbers as
`fortnoxConformanceFixtureSeeds`, so the Fortnox conformance cases run unmodified. Pass
`seed: { profile?, company?, customers?, invoices? }` (typed; entity lists replace the profile's)
with profiles `'default'`, `'empty-company'`, or `'no-booked-invoices'`. `reset()` restores the
current seed and clears the ledger and faults; `seed(next)` replaces the state and becomes what
`reset()` restores; `snapshot()` returns a deep copy of the state.

Faults (`faults.add` or `POST /_emulate/faults`): `{ kind: 'status', status, headers?, body?,
match?: { method?, path? }, count? }` answers matching requests before the route runs (nothing is
written). As in the Gateway emulator, statuses without a body (1xx, 204, 205), redirects (3xx),
invalid header names or values, `location`, and framing headers are rejected when the fault is
added; a fault is used up only once its response is built, and a response that cannot be built
answers an evidence-tagged 500 `ErrorInformation` with `responseError` in the ledger. For example a 429 with `retry-after: 2` reaches the connector as `fortnox_rate_limited`
with `retryAfterMs: 2000`. The ledger records method, path, route template, query, parsed body,
status, evidence, the applied fault, and any `responseError`.

Control plane: `/_emulate/ledger` (`GET`, `DELETE`), `/_emulate/faults` (`GET`, `POST`, `DELETE`),
`/_emulate/reset` (`POST`), `/_emulate/state` (`GET`), `/_emulate/seed` (`POST`), and
`/_emulate/coverage` (`GET`).

**Drill knobs (tests only).** `quirks: { stickyRowDiscount: false }`,
`{ emptyStringClears: true }`, and `{ paymentFiltersIncludeUnbooked: true }` each flip one observed
quirk to the plausible-but-wrong behavior. They exist only to prove that the matching conformance
case catches a disagreement (it fails with `ConformanceMismatch` while the others pass); never use
them to model Fortnox.

## Evidence

`gatewayEmulatorRoutes`, `openAiEmulatorRoutes`, `anthropicEmulatorRoutes`, `codexEmulatorRoutes`,
`xAiGrokEmulatorRoutes`, `openCodeGoEmulatorRoutes`, the three subscription-usage manifests,
`emailEmulatorRoutes`, and `fortnoxEmulatorRoutes` list every emulated route with `method`, `path`,
`kind`, `write`, the conformance `caseIds` it follows, `evidence` (`verified` or `unverified`), and
`observedAt`. Every response from an unverified route of a fetch-handler emulator carries
`x-emulator-evidence: unverified`; the email emulator records evidence on each ledger entry
instead, since its plain-JSON replies carry no header. The Gateway route is `verified`
(`observedAt: '2026-09-30'`): its wire shapes are checked against the verified live recordings.
Every other route (OpenAI, Anthropic, Codex, Grok, OpenCode Go, the usage routes, email, and
Fortnox) is unverified, like the synthetic fixtures it follows.
Each manifest route maps to its own handler; an emulator whose manifest has a route without a
handler throws when it is constructed. The Yolk repository checks these manifests: unknown case ids,
duplicate routes, connector write routes without verified evidence, verified connector write routes
whose `observedAt` is missing, unreadable, or in the future, and verified routes whose cited cases
have no verified fixture fail, as do verified connector write routes citing no cases; unverified or
stale (over 30 days) evidence and other routes citing no cases warn.

The email emulator's eight write routes are unverified connector writes. Until an owner-approved
live run against a practice mailbox verifies them, the repository lists them in a visible,
time-bounded allowlist (`scripts/emulator-evidence-pending.json`, which holds each entry's expiry
date): the check reports them as PENDING warnings until that date and fails again after it.

All Fortnox routes are currently `unverified` (no live recording yet), including four connector
write routes. Until an owner-approved live run verifies them, the repository lists them in a
visible, time-bounded allowlist (`scripts/emulator-evidence-pending.json`, which holds each
entry's expiry date): the check reports them as PENDING warnings until that date and fails again
after it.

## Node server

`serveFetchHandler(handler, { port = 0 })` serves on `127.0.0.1` only (any other `host` is
refused) as a scoped Effect resource returning `{ url, close }`. Streamed bodies are written chunk
by chunk, so progressive delivery survives the socket; a body stream error drops the connection.
`startFetchHandlerServer(handler, { port = 0 })` is the same server as a Promise, for
non-Effect test runners and hosts without an Effect runtime:

```ts
import { makeGatewayEmulator } from '@yolk-sdk/emulators/gateway'
import { startFetchHandlerServer } from '@yolk-sdk/emulators/node'

const server = await startFetchHandlerServer(makeGatewayEmulator().fetch)
// ... point the code under test at server.url ...
await server.close()
```

## License

`@yolk-sdk/emulators` is MIT. The Fortnox emulator depends on (does not vendor or bundle) the
Apache-2.0 [`@emulators/core`](https://github.com/vercel-labs/emulate) package, which ships no
`NOTICE` file.
