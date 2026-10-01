# @yolk-sdk/emulators

> **EXPERIMENTAL.** This package is new and its API may change in any canary release, beyond the
> usual canary instability.

Emulators for outside services, for tests and local development. A route table sends an Effect
`HttpClient` to an emulator instead of the real service. Two emulators speak the OpenAI-compatible
Chat Completions wire: the Vercel AI Gateway and OpenAI itself. A third emulates Anthropic Messages,
and two more speak the OpenAI Responses wire of the subscription providers: the ChatGPT Codex
endpoint and the xAI Grok CLI proxy. The OpenCode Go emulator answers the Go chat, Messages,
Responses, and usage routes under one origin, and the Anthropic, Codex, and Grok emulators also
answer their subscription-usage endpoints; those newer routes are fixture-only (see below). Two
emulators are not HTTP at all: fixture-driven fake backends for the generic `EmailClient` port and
for the host R2 ports (`R2Presigner`, `R2ObjectClient`).
Emulators never import other `@yolk-sdk/*` code: their wire shapes follow conformance fixtures
(verified recordings for the Gateway, synthetic placeholders elsewhere), and each emulated route
names the conformance cases behind it. The Fortnox emulator is a stateful stand-in for the Fortnox
`/3` API that reproduces the observed quirks the Fortnox conformance cases claim, the Microsoft
Graph emulator is a stateful stand-in for the Outlook, calendar, and OneDrive routes the Microsoft
conformance cases use. The Dropbox, Notion, Todoist, Telegram, GitHub, Google, and LinkedIn search
emulators are stateful, fixture-only stand-ins for the Dropbox RPC and upload routes, the Notion
`/v1` routes, the Todoist API v1 routes, the Telegram Bot API routes, the GitHub REST routes, the
Gmail, Calendar, and Drive routes, and the Exa and Enrich Layer routes their conformance cases use:
they answer only what the fixtures show and refuse everything else with a 400 not-emulated.

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Install

```bash
pnpm add -D @yolk-sdk/emulators@canary effect@4.0.0-rc.115
```

## Subpaths

There is no root export. Import an explicit subpath:

| Subpath                               | Purpose                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@yolk-sdk/emulators/router`          | `EmulatorRoute`, `EmulatedHttpClient.layer`, `InProcessHttpClient.layer` (Effect; no Node builtins)                 |
| `@yolk-sdk/emulators/gateway`         | `makeGatewayEmulator`, `gatewayEmulatorRoutes`, fault and scripted-turn schemas (plain fetch handler)               |
| `@yolk-sdk/emulators/openai`          | `makeOpenAiEmulator`, `openAiEmulatorRoutes`, fault and scripted-turn schemas (plain fetch handler)                 |
| `@yolk-sdk/emulators/anthropic`       | `makeAnthropicEmulator`, `anthropicEmulatorRoutes`, fault and scripted-turn schemas (plain fetch handler)           |
| `@yolk-sdk/emulators/codex`           | `makeCodexEmulator`, `codexEmulatorRoutes`, fault and scripted-turn schemas (ChatGPT Codex Responses)               |
| `@yolk-sdk/emulators/xai`             | `makeXAiGrokEmulator`, `xAiGrokEmulatorRoutes`, fault and scripted-turn schemas (Grok CLI proxy Responses)          |
| `@yolk-sdk/emulators/opencode`        | `makeOpenCodeGoEmulator`, `openCodeGoEmulatorRoutes` (OpenCode Go chat, Messages, Responses, and usage)             |
| `@yolk-sdk/emulators/email`           | `makeEmailEmulator`, `emailEmulatorRoutes`, seed and fault schemas (plain-JSON `EmailClient` backend)               |
| `@yolk-sdk/emulators/r2`              | `makeR2Emulator`, `r2EmulatorRoutes`, seed and fault schemas (plain-JSON R2 port backend)                           |
| `@yolk-sdk/emulators/node`            | `serveFetchHandler` (scoped Effect) and `startFetchHandlerServer` (Promise): serve a handler on `127.0.0.1`         |
| `@yolk-sdk/emulators/fortnox`         | `makeFortnoxEmulator`, `fortnoxEmulatorRoutes`, `fortnoxEmulatorQuirks`, seed and fault schemas (Node only)         |
| `@yolk-sdk/emulators/microsoft`       | `makeMicrosoftEmulator`, `microsoftEmulatorRoutes`, seed and fault schemas (Node only)                              |
| `@yolk-sdk/emulators/dropbox`         | `makeDropboxEmulator`, `dropboxEmulatorRoutes`, seed and fault schemas (Node only)                                  |
| `@yolk-sdk/emulators/notion`          | `makeNotionEmulator`, `notionEmulatorRoutes`, seed and fault schemas (Node only)                                    |
| `@yolk-sdk/emulators/todoist`         | `makeTodoistEmulator`, `todoistEmulatorRoutes`, seed and fault schemas (Node only)                                  |
| `@yolk-sdk/emulators/telegram`        | `makeTelegramEmulator`, `telegramEmulatorRoutes`, seed and fault schemas (Node only)                                |
| `@yolk-sdk/emulators/github`          | `makeGithubEmulator`, `githubEmulatorRoutes`, seed and fault schemas (Node only)                                    |
| `@yolk-sdk/emulators/google`          | `makeGoogleEmulator`, `googleEmulatorRoutes`, seed and fault schemas (Gmail, Calendar, Drive; Node only)            |
| `@yolk-sdk/emulators/linkedin-search` | `makeLinkedInSearchEmulator`, `linkedInSearchEmulatorRoutes`, seed and fault schemas (Exa, Enrich Layer; Node only) |

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

## R2 emulator

`makeR2Emulator({ seed? })` is an in-memory fake backend for the host R2 ports of
`@yolk-sdk/connectors/r2-storage`: `R2Presigner` (a presigned PUT URL) and `R2ObjectClient`
(conditional get and put). There is no SigV4 signer, S3 client, socket, Node builtin, or SDK import:
it is a plain object whose `call(port, method, request)` takes one port call as plain JSON (the
request without credential fields; bytes as base64) and answers `{ response }`, `{ failure }`, or
`{ notEmulated: { reason } }`. `r2PortsLayerFromBackend(emulator)` from
`@yolk-sdk/connectors/r2-storage/conformance` turns it into both port layers, so the R2 conformance
cases and your own tests run the real connector action and object helpers against it:

```ts
import { r2PortsLayerFromBackend } from '@yolk-sdk/connectors/r2-storage/conformance'
import { makeR2Emulator } from '@yolk-sdk/emulators/r2'

const r2 = makeR2Emulator()

r2.faults.add({
  kind: 'failure',
  port: 'R2ObjectClient',
  method: 'put',
  count: 1,
  failure: { kind: 'error', code: 'transport_failed', message: 'Synthetic outage.' }
})

const r2Layer = r2PortsLayerFromBackend(r2)
```

Responses come only from the R2 conformance fixtures (copied as data; `r2EmulatorFixtures`). The
emulator keeps a bucket (`r2EmulatorDefaultSeed`: the practice bucket with the one object the get
fixtures read) that only decides which fixture answers: the first fixture whose port, method, and
request match and whose answer is consistent with the bucket (preferring one not used since the
last reset). The bucket then records what that fixture says happened: an object created
(absent-only) or replaced (under the current etag), with the etag the fixture names. It never
invents an etag, a byte, or a failure, and presigning writes nothing. The connector cannot delete R2
objects, so objects the write cases create stay; running the write cases again on the same emulator
fails them without writing, as a reused run id does against a live bucket.

Credentials never reach the ledger or any other output. Every credential field (`credential(s)`,
`accessKeyId`, `secretAccessKey`, `sessionToken`, `token`, and the other names the shared port scan
classifies as credentials) is dropped at any depth before anything is compared or recorded. Every
refusal is ledgered with constant text only (request `<redacted>`), uses no fault, and changes no
state; only a request equal to a fixture request is recorded, with every `bodyBase64` as
`<redacted>` plus its decoded length (`bodyBytes`). Every `bodyBase64` (put bytes) must be canonical
standard base64 of UTF-8 text (else `uncheckable-body`), and its decoded text is checked like the
rest of the request. A request is refused as `credential-in-request` when any key, string value,
number (as printed or as its digit string), or decoded body repeats a value found under a credential
field (any non-empty key, string, or number, with no minimum length), or holds, outside the exact
canonical synthetic placeholders, `X-Amz-Credential`, `X-Amz-Signature`, `X-Amz-Security-Token`, a
credential query parameter, or a token the shared scan flags (a bearer token, a common API-key
prefix, a JSON Web Token, a PEM private key). Each text is checked raw, within three rounds of
percent-decoding and three of escape-decoding (`\uXXXX`, `\xXX`, and numeric HTML references, as the
R2 conformance guard decodes), and through any depth of percent-encoding and JSON escaping, failing
closed past a work cap. A request with an own `__proto__` key at any depth is refused as
`invalid-request`, and one the checks cannot walk (cyclic, or nested too deeply) as
`uncheckable-request`: `call` never throws. The copied key, parameter, and token lists have one test
sample each, counted against the list and checked against the shared scan. A presign answer is the
fixture's URL, which carries only those placeholders.

- Request-shape latitude: credential fields are never compared or recorded, and JSON key order is
  not compared. Everything else (the endpoint, bucket, key, content type, `maxBytes`,
  `expectedEtag`, the put `condition`, `bodyBase64`, and `maxUploadBytes`) must equal a fixture
  request exactly, so only the fixtures' `run-synthetic` run id is emulated. A `bodyBase64` must be
  canonical standard base64 of UTF-8 text (else `uncheckable-body`); it is compared as sent but
  recorded only as its decoded length. No object may have an own `__proto__` key (else
  `invalid-request`), and no key or value, the decoded body included, may carry a credential or
  repeat a dropped credential value of any length (else `credential-in-request`). Every refusal is
  ledgered with constant text only (request `<redacted>`).

Anything else fails closed with a ledgered `notEmulated` answer (the port analogue of HTTP 400),
with constant text only: a port and method outside the manifest (`unknown-method`; ledgered as
`<unrecognised>`), a request that is not an object or has an own `__proto__` key
(`invalid-request`), a body that cannot be checked (`uncheckable-body`), a credential outside the
credential fields (`credential-in-request`), a request the checks cannot walk
(`uncheckable-request`; ledgered as `<unrecognised>`), no matching fixture (`no-matching-fixture`),
or no matching fixture consistent with the bucket (`state-conflict`). None uses a fault or changes
the bucket. Faults (`kind: 'failure'`, a `port` and `method`, an optional deep-subset `match` on the
request, an optional `count`, and the `failure` to answer) apply only to a call a fixture would
answer and change no state. `ledger` records every call (the fixture request of an answered or
faulted call, `<redacted>` for a refusal; outcome, fixture or fault id, reason), `state()` returns
the current bucket, `reset()` restores the seed and clears the ledger, faults, and fixture use, and
`coverage()` reports calls per route, refusals, and unused fixtures. An invalid seed or fault throws
`R2EmulatorInputInvalid`.

`r2EmulatorRoutes` names each emulated method as `PORT <Port>.<method>` with the R2 cases it
follows: `R2Presigner.presignPutObject`, `R2ObjectClient.get`, and `R2ObjectClient.put` (the only
write). All routes are unverified: the fixtures are synthetic. Live verification needs a host
implementation of both ports connected to a practice bucket.

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
answers an evidence-tagged 500 `ErrorInformation` with `responseError` in the ledger, as does a
route handler that throws. For example a 429 with `retry-after: 2` reaches the connector as `fortnox_rate_limited`
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

## Microsoft Graph emulator

> **Node only.** `@yolk-sdk/emulators/microsoft` runs on the same pinned `@emulators/core` runtime
> as the Fortnox emulator, loaded lazily by `makeMicrosoftEmulator`, so importing the subpath has
> no side effects.

`await makeMicrosoftEmulator(options?)` returns
`{ fetch, baseUrl, sharePointOrigin, ledger, faults, monitors, reset, seed, snapshot, coverage, close }`.
Each call has its own state; `await close()` when done. It emulates only what the eleven Microsoft
conformance cases need, so the Microsoft connector and the cases run unchanged against it.

Route **two origins** to the same fetch handler: Graph (`https://graph.microsoft.com`) and the
SharePoint host of the copy monitor URLs (`sharePointOrigin`, default
`https://synthetic-my.sharepoint.com`, the fixtures' host; the connector only accepts monitor URLs on
`*.sharepoint.com` or `api.onedrive.com`). The paths never overlap, so both origins may share one
loopback server:

```ts
import { makeMicrosoftEmulator } from '@yolk-sdk/emulators/microsoft'
import { EmulatorRoute, InProcessHttpClient } from '@yolk-sdk/emulators/router'

const microsoft = await makeMicrosoftEmulator()

const httpLayer = InProcessHttpClient.layer([
  EmulatorRoute.handler('https://graph.microsoft.com', microsoft.fetch),
  EmulatorRoute.handler(microsoft.sharePointOrigin, microsoft.fetch)
])
// With serveFetchHandler, use EmulatorRoute.url(origin, server.url) for both origins.
// ...run the code under test, then:
await microsoft.close()
```

Graph routes (JSON; `Authorization: Bearer <non-empty>`, whose value is never checked, stored,
forwarded, or ledgered; a missing bearer gets 401 `InvalidAuthenticationToken`). Every Outlook
route needs `Prefer: IdType="ImmutableId"`, and every calendar route
`Prefer: outlook.timezone="UTC"`, as every fixture of theirs sends it:

| Route (`/v1.0` prefix)                                        | Behavior                                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /users/{userId}/calendars/{calendarId}/calendarView`     | Events overlapping `[startDateTime, endDateTime)`, by start; `$select`, `$top` (required, ≤ 50; one page)   |
| `POST /users/{userId}/calendars/{calendarId}/events`          | 201 with the new event and its `id`; attendee-free, single-instance, UTC only                               |
| `GET`, `PATCH`, `DELETE /users/{userId}/events/{eventId}`     | Read (`$select`), update `subject`, delete (204; later reads 404)                                           |
| `POST /users/{userId}/events/{eventId}/cancel`                | 202 with an empty body; the event is removed, so a later GET or DELETE is a 404                             |
| `GET /users/{userId}/mailFolders/{folderId}/messages`         | Folder by id; newest first; `$select`, `$top` (required, ≤ 2), `$skip`; opaque `@odata.nextLink`            |
| `POST /users/{userId}/messages`                               | 201 draft in Drafts (never sent): `subject`, text `body`, `toRecipients`, the owner as `from`               |
| `PATCH /users/{userId}/messages/{messageId}`                  | A draft's `subject` and `isRead`                                                                            |
| `POST /users/{userId}/messages/{messageId}/move`              | 201 with the draft moved to Deleted Items (`destinationId: "deleteditems"` only)                            |
| `GET /users/{userId}/messages/{messageId}/attachments[/{id}]` | Listing (`$select` only) includes inline ones, never `contentId`; retrieval has `contentId`, `contentBytes` |
| `POST /$batch`                                                | Up to 20 `permanentDelete` subrequests of drafts that can all run (204 each); else the whole batch is 400   |
| `GET /drives/{driveId}/items/{itemId}` and `/children`        | Item read (`$select`) and children by name (`$select`, `$top` required, ≤ 200; one page)                    |
| `POST /drives/{driveId}/items/{itemId}/children`              | 201 folder with a free name; `@microsoft.graph.conflictBehavior` `fail` only                                |
| `DELETE /drives/{driveId}/items/{itemId}`                     | 204; the item and its subtree are removed (no recycle bin), later reads 404                                 |
| `POST /drives/{driveId}/items/{itemId}/copy`                  | A file to `parentReference { driveId, id }` on the drive, same name; 202 with one monitor `Location`        |

The copy monitor, `GET /personal/{site}/_api/v2.0/monitor/{monitorId}` on the SharePoint origin,
needs no credential (like the real capability URL). Its first poll runs the copy and answers
`completed` (200) with the new item's `resourceId`, as the copy fixture records;
`copyInProgressPolls` (default 0) adds `inProgress` (202) answers before that. Monitors are runtime
data like the ledger: not part of `snapshot()`, listed by `monitors()` and `/_emulate/state`, and
cleared by `reset` and `seed`.

Wire behavior the cases claim:

- **Ids.** A moved message keeps its immutable id (`Prefer: IdType="ImmutableId"`), and a later
  update by that id applies.
- **Times.** Event `dateTime` values are UTC with seven fractional digits
  (`2026-09-23T12:00:00.0000000`) and `timeZone: "UTC"`; calendar reads answer
  `preference-applied: outlook.timezone="UTC"`. A calendar request without that preference, or
  with any other time zone, is refused.
- **Paging.** Folder message listings page with `$top`/`$skip`; their `@odata.nextLink` is the
  configured `baseUrl`, the request's raw path (so `/users/ada%40example.test` keeps its `%40`),
  and `%24select`/`%24top`/`%24skip`, byte for byte as the paging fixture. Calendar views and
  children listings answer one page of at most `$top` (their fixtures never page), and attachment
  listings every attachment (their fixtures send only `$select`).
- **Concurrent writes.** Of two overlapping writes to one message, one gets 409
  `ErrorIrresolvableConflict` and changes nothing.
- **Envelopes.** Responses carry the fixtures' `@odata.context` (for example
  `$metadata#users('ada%40example.test')/messages/$entity`), entity fields, and error envelopes;
  `test/microsoft.test.ts` replays every fixture and compares each complete response, normalizing
  only emulator-generated values (change keys and etags, draft conversation and internet message
  ids, created ids, and `innerError` request ids and dates).

Emulator extrapolations (no fixture). This list predates the fixture-only rule as now stated
(`AGENTS.md`): it is legacy, to be removed, and never a precedent for another emulator or route. The
cases need each of these to run, except request-shape latitude (accepted request variations; no
invented wire behaviour) and the last, which is opt-in and off by default:

- **Concurrency window.** The first write (update or move) to reach the handler holds the message
  for `conflictWindowMs` (default 25); an overlapping write gets 409; non-overlapping writes both
  apply (the immutable-id case moves, then updates, the same message).
- **Id counters.** Created ids (events, drafts, drive items) and change keys come from counters
  that only advance, so a reversible case ends at the seed except the counters.
- **Removal.** A deleted or cancelled event, a permanently deleted draft, and a deleted folder
  (with its subtree, such as the copy case's folder holding the copied file) are removed from the
  state, so a reversible case ends at the seed.
- **Seed values.** Entities no fixture shows (the inbox, the attachment message itself, the drive
  root and `Sources` folder) are synthesized; `hasAttachments` is answered as seeded (`false` for
  new drafts), never derived from the attachments.
- **Request-shape latitude.** Requests that vary harmlessly from the fixtures' are answered like
  them: `$select` may be omitted or name any fields the emulator renders, in any order; `$top` may
  be below the fixture value (1 to 2, 50, or 200) and `$skip` any offset on folder messages; the
  user segment may be the user's id, mail, or user principal name, case-insensitive; write bodies
  may send any subset of the fixture keys (for example a draft with only `subject`), any `showAs`
  free/busy status, either boolean for `isRead` and `isReminderOn`, and non-empty `toRecipients`
  with or without names; and `calendarView` accepts any valid range, including UTC offsets. A
  missing message or attachment answers 404 `ErrorItemNotFound`, the documented Graph code, which
  no fixture records for them.
- **In-progress copies (opt-in).** `copyInProgressPolls` (default 0, so no case sees it) makes the
  monitor answer `{ "@odata.context", "percentageComplete": 0, "status": "inProgress" }` (202)
  that many times before the copy runs; no fixture records an in-progress poll.

Anything else fails closed with the Graph error envelope `{ error: { code, message, innerError } }`
(`innerError` holds a synthetic `date`, `request-id`, and `client-request-id`): unknown routes and
methods (including `/me` paths) get 404 `SyntheticRouteNotEmulated` and are ledgered; query keys a
route does not emulate get 400 before the route runs (so a rejected write writes nothing), as do
`$select` fields, body properties (including unknown keys inside `body`, recipients,
`emailAddress`, `start`/`end`, and `parentReference`), and values it does not emulate. That covers
Outlook requests without the immutable-id preference, `If-Match` conditional requests, conflict
behaviors other than `fail` (or none), name conflicts, HTML bodies, attendees, non-UTC times,
send-as `from`, calendar requests without `Prefer: outlook.timezone="UTC"`, collection listings
without `$top` or with `$top` above the largest value a fixture sends (2 for folder messages, 50
for calendar views, 200 for children), calendar views and children listings with more results than
`$top`, `$skip` anywhere but folder messages, folder message listings by well-known name or an
unknown folder id, moves to any destination but `deleteditems` (including `inbox`, `drafts`, and
folder ids), updates, moves, and permanent deletes of messages that are not drafts, permanently
deleting a message with attachments, copies of folders, with a new `name`, without
`parentReference.driveId`, or to another drive, file creation, a `$batch` subrequest that could
not answer 204, and a copy that can no longer run when its monitor is polled (400 at the monitor;
no fixture records a failed copy). A route handler that throws answers a 500 Graph error
envelope, recorded in the ledger with `responseError` (if the injected clock throws too, its
`innerError.date` is the fixed `1970-01-01T00:00:00`; unknown routes still answer, and ledger,
their 404, and a closed emulator its 503, with that date). `microsoftEmulatorErrorCodes` lists the
codes: `ErrorItemNotFound`, `itemNotFound`, and `ErrorIrresolvableConflict` come from the
fixtures; `InvalidAuthenticationToken`, `ErrorInvalidUser`, and `TooManyRequests` (the default 429
fault body) are documented Graph codes no fixture records; the `Synthetic*` ones are emulator
codes.

State and seeds: the mailbox user, mail folders, messages, file attachments (inline and regular),
calendars and events, the drive and its items, and id counters. The default seed is the synthetic
fixture entities with the same ids as `microsoftConformanceFixtureSeeds` (mailbox
`ada@example.test`, calendar, events, attachment message, paging folder with three messages, drive,
parent folder, and copy source). Pass `seed: { profile?, user?, mailFolders?, messages?,
attachments?, calendars?, events?, drive?, driveItems? }` (entity lists replace the profile's) with
profiles `'default'` or `'empty'`. `reset()` restores the current seed and clears the ledger,
faults, and monitors; `seed(next)` replaces the state; `snapshot()` returns a deep copy.

Faults, the ledger, and the control plane mirror the Fortnox emulator: `status` faults (`match`
by method and raw path, `count`) answer before the route runs and follow the shared status and
header rules; the default body is a Graph error envelope (`TooManyRequests` for 429, so a 429 with
`retry-after: 2` reaches the connector as `microsoft_rate_limited` with `retryAfterMs: 2000`). The
ledger records method, raw path, route template, query (credential-named keys such as
`access_token`, and the conformance scan's credential query parameters such as `X-Amz-Signature`
and `X-Amz-Credential`, are redacted), parsed body (credential-named keys at any depth, such as a
`$batch` subrequest's `Authorization`, are redacted), the `Prefer` header, status, evidence, the
applied fault, and any `responseError`. Control plane: `/_emulate/ledger`, `faults`,
`reset`, `state`, `seed`, and `coverage`.

**Drill knobs (tests only).** `drills: { calendarRangeEmpty: true }` (empty calendar views),
`{ createOmitsId: true }` (event create answers without `id`), `{ timestampPrecisionDigits: 3 }`,
and `{ omitNextLink: true }` each make the emulator disagree with one claim, only to prove the
matching conformance case catches it. The timestamp and paging knobs fail only their case; an empty
view also fails the timestamp case's precondition, and an id-less create also fails the cancel
case, which creates its event the same way.

## Dropbox emulator

> **Node only.** `@yolk-sdk/emulators/dropbox` runs on the same pinned `@emulators/core` runtime as
> the Fortnox and Microsoft emulators, loaded lazily by `makeDropboxEmulator`, so importing the
> subpath has no side effects.

`await makeDropboxEmulator(options?)` returns
`{ fetch, fetchOn, ledger, faults, cursors, reset, seed, snapshot, coverage, close }`. Each call has
its own state; `await close()` when done. It emulates only what the eight Dropbox conformance
cases (with their cleanup) send, so the Dropbox connector actions, the `createDropboxFile` /
`updateDropboxFile` upload helpers, and the cases run unchanged against it. The read-only leftover
lookup (`findDropboxConformanceLeftovers`) fails against the default seed: it lists the empty work
folder, and no fixture records a listing of an empty folder, so that listing answers the ledgered
400 not-emulated (nothing is written) and the lookup fails with `DropboxConformanceActionFailed`
(`dropbox_list_folder_failed`, HTTP 400); the live runner turns that into its lookup-failed `WARN`.
It lists a work folder that holds entries. Each route answers only on the origin its fixtures record: the RPC routes on
`https://api.dropboxapi.com` (`dropboxEmulatorApiOrigin`) and the upload on
`https://content.dropboxapi.com` (`dropboxEmulatorContentOrigin`). `fetch` takes the origin from the
request URL (in-process routing keeps it); behind a loopback rewrite, which loses it, serve
`fetchOn(origin)` for each origin on its own server:

```ts
import {
  dropboxEmulatorApiOrigin,
  dropboxEmulatorContentOrigin,
  makeDropboxEmulator
} from '@yolk-sdk/emulators/dropbox'
import { EmulatorRoute, InProcessHttpClient } from '@yolk-sdk/emulators/router'

const dropbox = await makeDropboxEmulator()

const httpLayer = InProcessHttpClient.layer([
  EmulatorRoute.handler(dropboxEmulatorApiOrigin, dropbox.fetch),
  EmulatorRoute.handler(dropboxEmulatorContentOrigin, dropbox.fetch)
])
// With serveFetchHandler: one server per origin, serving dropbox.fetchOn(origin).
// ...run the code under test, then:
await dropbox.close()
```

Routes (every one a `POST` under `/2`, `Authorization: Bearer <non-empty>`, whose value is never
checked, stored, forwarded, or ledgered; RPC routes take a JSON body with no query string):

| Route                            | Behavior                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `/2/files/list_folder`           | `{ path, limit }` of a folder: `{ entries, cursor, has_more }`, at most `limit` entries per page        |
| `/2/files/list_folder/continue`  | `{ cursor }`: the next page of an unchanged listing; every page, the last included, carries a cursor    |
| `/2/files/get_metadata`          | `{ path }`: file metadata, or 409 `path/not_found`; `include_deleted: true` after a recorded delete     |
| `/2/files/search_v2`             | `{ query, options: { max_results, filename_only: true } }`: file name matches; a cursor with `has_more` |
| `/2/files/search/continue_v2`    | `{ cursor }`: the next matches of an unchanged search (the last page has no cursor)                     |
| `/2/files/create_folder_v2`      | `{ path, autorename: false }`: `{ metadata }` without `.tag`; an existing folder, any casing, is 409    |
| `/2/files/delete_v2`             | `{ path }` (a path or `id:`) of a folder: `{ metadata }` tagged `folder`; the folder and its content go |
| `/2/files/copy_v2`, `move_v2`    | `{ from_path, to_path, autorename: false }` of a file: `{ metadata }` (copy: new id; move: same id)     |
| `/2/files/upload` (content host) | `Dropbox-API-Arg` `add` or `{ ".tag": "update", update: <rev> }` (by `id:`), `strict_conflict: true`    |

Wire behavior, as the fixtures record it:

- **Errors.** Route errors are HTTP 409 with the fixtures' `error_summary` envelopes, byte for byte
  (`dropboxEmulatorErrorBodies`): `path/not_found/.` for a missing path in an existing folder,
  `path/conflict/folder/..` for an existing folder, and `path/conflict/file/..` (a `reason`
  object) for an `add` upload onto an existing file or an `update` naming a stale rev. A rejected
  write changes nothing.
- **Paths.** Lookups are case-insensitive; `path_lower` is the lower-cased path. `get_metadata`
  answers `path_display` with the request's casing for every component but the last, which keeps
  the stored casing, as the lower-cased lookup fixture records.
- **Paging.** `list_folder` pages through a folder's entries and `search_v2` through the files
  whose names contain the query, case-insensitively, as the paging and search fixtures record.
- **Relocation.** `copy_v2` answers a new file with a new id and rev and the source's size, content
  hash, and timestamps; `move_v2` keeps the id and timestamps and gets a new rev.
- **Uploads.** `add` never overwrites; `update` replaces the file under the same id with a new rev
  only when its rev is current.
- **Deleted entries.** Deleting an empty folder keeps a deleted-entry record (state `deleted`), so
  `get_metadata` with `include_deleted: true` answers the `deleted` metadata, as the delete fixture
  records; afterwards `get_metadata` without it answers 409 `path/not_found`.

Every answer value comes from a fixture, through the seed or the request, except the values the
emulator mints (it never mints anything else):

- **Minted values.** Created ids (`id:SyntheticEntry00000001`) and revs (`a1b2c3d4e5f60101`) come
  from counters that only advance and start above the highest seeded id and rev in that form, so a
  minted value never repeats a seeded one; a created file's content hash is 62 zeros and its rev's
  last two digits, as the upload fixture writes it; upload timestamps come from the injectable `now`
  clock; cursors (`AAHsyntheticListCursorNNNN`, `AAHsyntheticSearchCursorNNNN`) come from counters
  that never reset. A reversible case therefore ends at the seed except the counters and the
  deleted-entry record of an empty case folder it deleted.
- **Implied folders.** The parent folders the seeded paths need (`/Conformance`,
  `/Conformance/Paging`, `/Conformance/Search`, `/Conformance/Work`) are `implied`: no fixture shows
  them, so lookups pass through them but any answer that would render one is not emulated.
- **Cursors.** A cursor is accepted only when this emulator issued it since the last reset or seed
  (reset and seed clear the registry; cursor values are never reissued) and the listing or search
  it continues renders exactly as when it was issued. Cursors are runtime data, listed by
  `cursors()` and `/_emulate/state`.
- **Request-shape latitude (`/dropbox`, the only accepted deviations).** Any bearer value (never
  checked or stored); extra request headers; JSON key order; `content-type` media-type parameters;
  any path and search query (looked up in the state); any `list_folder` `limit` from 1 to 2000 and
  any `search_v2` `options.max_results` from 1 to 1000; and any upload body bytes. Everything else
  (other keys, booleans, modes, query parameters, another origin, ids or revs where the fixtures
  send paths, the root folder, and cursors not issued since the last reset or whose listing
  changed) is not emulated.

Anything else answers one ledgered 400 not-emulated (`{ error: { type: 'not_emulated', message } }`,
`notEmulated` in the ledger), writes nothing, and uses up no fault: unknown routes and methods, a
route on another origin, a missing bearer, query parameters, other content types, unknown or
missing body keys, `autorename` or `include_deleted: false`, `strict_conflict: false`, other upload
modes, the root folder, `id:` or `rev:` paths where the fixtures send paths, `get_metadata` of a
folder or of a path whose parent folder is missing or a file, `include_deleted` without a recorded
delete or on a live entry, listing a file, a missing folder, an empty folder, or a folder holding an
implied one, a search without matches or matching a folder, a missing parent folder, deleting a file, a missing
entry, or an implied folder, copying or moving a folder or onto an existing entry, an `add` upload
onto a folder, an `update` upload of a missing file, and the cursors above. A route that throws (for
example when the upload clock throws) answers an evidence-tagged 500 emulator error with
`responseError` in the ledger, and a closed emulator answers 503.

State and seeds: entries (files and folders by parent id; files carry rev, size, content hash, and
timestamps; `implied` marks a folder no fixture shows), deleted-entry records, and counters. The
default seed is the synthetic fixture entries at the paths of `dropboxConformanceFixtureSeeds`
(the paging folder with three entries, the mixed-case file, two search matches, and the copy source,
under implied folders). Pass `seed: { profile?, entries?, deleted? }` (entries by display path; a
parent folder must be seeded too) with profiles `'default'` or `'empty'`. `reset()` restores the
current seed and clears the ledger, faults, and cursors; `seed(next)` replaces the state;
`snapshot()` returns a deep copy.

Faults (`faults.add` or `POST /_emulate/faults`): `{ kind: 'status', status, headers?, body?,
match?: { method?, path? }, count? }` with a status of 400-599 answers a matching request the
emulator would otherwise answer, instead of its write (nothing is written): the route's pure,
state-reading eligibility check runs first, so a request that is not emulated never uses one up.
The default body is `{ error: { type: 'emulator_fault', message } }` (never a guessed Dropbox body),
so a 429 with `retry-after: 2` reaches the connector as `dropbox_rate_limited` with
`retryAfterMs: 2000`. The ledger records method, raw path, route template, query (credential-named
keys such as `authorization` and `access_token` redacted; a value starting with `{` or `[`, such as
a browser-style `arg`, parsed with credential-named keys redacted at any depth, or `<redacted>` when
unparseable), the parsed JSON body (credential-named keys redacted), an upload's body length (never
its bytes), the `Dropbox-API-Arg` header (parsed, credential-named keys redacted at any depth; an
unparseable value is recorded as `<redacted>`), status, evidence, the applied fault, `notEmulated`,
and any `responseError`. Control plane: `/_emulate/ledger`, `faults`, `reset`, `state`, `seed`, and
`coverage`.

**Drill knobs (tests only).** `drills: { listFolderSinglePage, getMetadataCaseSensitive,
searchRepeatsMatches, notFoundAsPathLookup, folderConflictAsFile, deleteLeavesNoTombstone,
moveMintsNewId, uploadIgnoresRev }` (booleans) each make the emulator disagree with exactly one
Dropbox case, only to prove that case catches it.

## Notion emulator

> **Node only.** `@yolk-sdk/emulators/notion` runs on the same pinned `@emulators/core` runtime,
> loaded lazily by `makeNotionEmulator`, so importing the subpath has no side effects.

`await makeNotionEmulator(options?)` returns
`{ fetch, fetchOn, ledger, faults, reset, seed, snapshot, coverage, close }`. Each call has
its own state; `await close()` when done. It emulates only what the eight Notion conformance cases
(with their cleanup) send, so the Notion connector and the cases run unchanged against it. The
read-only leftover lookup (`findNotionConformanceLeftovers`) fails against it whenever its search
for `yolk-conformance` has no match (a clean workspace) or matches a trashed page (after the write
case): no fixture records either answer, so the search answers the ledgered 400 not-emulated
(nothing is written) and the lookup fails with `NotionConformanceActionFailed`
(`notion_search_failed`, HTTP 400); the live runner turns that into its lookup-failed `WARN`. It
answers when every match is an untrashed page with timestamps. Every route answers only on the
origin its fixtures record, `https://api.notion.com` (`notionEmulatorOrigin`): `fetch` reads the
origin from the request URL (in-process routing keeps it); behind a loopback rewrite, which loses
it, serve `fetchOn(notionEmulatorOrigin)`. Route `https://api.notion.com` to it:

```ts
import { makeNotionEmulator } from '@yolk-sdk/emulators/notion'
import { EmulatorRoute, InProcessHttpClient } from '@yolk-sdk/emulators/router'

const notion = await makeNotionEmulator()

const httpLayer = InProcessHttpClient.layer([
  EmulatorRoute.handler('https://api.notion.com', notion.fetch)
])
// ...run the code under test, then:
await notion.close()
```

Routes (under `/v1`; every request needs `Authorization: Bearer <non-empty>`, whose value is never
checked, stored, forwarded, or ledgered, and `Notion-Version: 2025-09-03`, the version every fixture
sends; bodies are JSON):

| Route                                            | Behavior                                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `POST /v1/search`                                | `{ query, filter: { property: "object", value: "page" }, page_size, start_cursor? }`: pages by title  |
| `GET /v1/users/me`                               | The integration's bot user                                                                            |
| `GET /v1/pages/{pageId}`                         | The page (trashed pages too); 404 `object_not_found` or 400 `validation_error` envelopes              |
| `POST /v1/pages`                                 | The recorded create: a child of a page titled `yolk-conformance page: safe to delete`                 |
| `PATCH /v1/pages/{pageId}`                       | `{ archived: true }`: the page with `archived` and `in_trash` true                                    |
| `GET /v1/blocks/{blockId}/children`              | `page_size` (required), `start_cursor`: a page's child blocks                                         |
| `GET /v1/pages/{pageId}/properties/{propertyId}` | `page_size` (required), `start_cursor`: the items of a paginated property                             |
| `GET /v1/databases/{databaseId}`                 | The database with its `data_sources` (`{ id, name }`)                                                 |
| `GET /v1/data_sources/{dataSourceId}`            | The data source: `properties` schema, `parent: { type: "database_id" }`, `database_parent`            |
| `POST /v1/data_sources/{dataSourceId}/query`     | `{ page_size: 1 }`: the recorded first row, `parent: { type: "data_source_id" }`, and the next cursor |

Wire behavior, as the fixtures record it:

- **Version.** Every route needs `Notion-Version: 2025-09-03`; any other version (or none) is not
  emulated.
- **Cursor paging.** Lists answer `{ object: "list", results, next_cursor, has_more, type, <type>:
{} }`, and the last page carries `next_cursor: null` (present, not absent). Search and block
  cursors are the next result's id; property item cursors are opaque, with `property_item.next_url`
  naming the property id as the page object returns it.
- **Errors.** A page read of a well-formed id that addresses no page answers 404
  `{ object: "error", status: 404, code: "object_not_found", message, request_id }`; a malformed id
  answers 400 `validation_error`, with the fixtures' messages.
- **Property ids.** The property id path segment is decoded once, so the connector's second
  percent-encoding (`Syn%253Ap`) names the property the page returns as `Syn%3Ap`.
- **Data source split.** The database lists its data sources; the data source holds the schema and
  names its database; its query answers the recorded first row, whose parent names the data source,
  with the next row's id (which the fixture only names) as `next_cursor`.
- **Archive.** `archived: true` answers the page with `archived` and `in_trash` true and keeps
  `last_edited_time`; the page still reads back (200) as archived.

Every answer value comes from a fixture, through the seed or the request, except the values the
emulator mints (it never mints anything else):

- **Minted values.** Created page ids (`1f0000e0-0000-4000-8000-000000000001`, ...) come from a
  counter that only advances and starts above the highest seeded id in that form; created pages take
  their timestamps from the injectable `now` clock; request ids come from the ledger sequence;
  property item cursors come from a counter that never resets (the first is the fixture's value);
  search and block cursors are the next result's id (the fixture's value) only in the generation
  that first issued that id for that list, and `<id>.g<generation>` after a reset or seed (each
  starts a generation). A reversible run ends at the seed except the counter and its own page, in
  the trash.
- **Implied pages.** Pages a fixture only names by id (the blocks page, the write case's parent page,
  the database's parent page, and the second data source row) are `impliedPages`: their ids resolve
  where a fixture names them (a block parent, a create parent, a database parent, the query's next
  row), but no content exists for them, so any answer that would render one is not emulated.
- **Search scope.** Search considers only the pages whose content the state holds (the `pages`):
  an implied page has no known title, so it never matches a search. A search answers only matches
  in the shape the search fixture records (untrashed pages with timestamps): a match that is
  trashed, or shown only as a query row (no timestamps), makes the search not emulated.
- **Cursors.** A cursor is accepted only when this emulator issued it for the same list (the same
  search query, block parent, or property) since the last reset or seed, and the list renders
  exactly as when it was issued. No cursor value crosses a reset or seed (see minted values), so a
  pre-reset cursor stays refused even after the same first-page request.
- **Request-shape latitude (`/notion`, the only accepted deviations).** Any bearer value (never
  checked or stored); extra request headers; JSON key order; `content-type` media-type parameters;
  the order of query parameters; Notion ids with or without dashes, in any case; any search `query`
  (looked up in the state); and any `page_size` from 1 to 100 whose page shows only recorded results
  (the data source query: 1). `Notion-Version` must be `2025-09-03`. Everything else (other keys,
  filters, booleans, sorts, query parameters, another origin, titles, repeated or missing `page_size`, and cursors
  not issued for the same list since the last reset or whose list changed) is not emulated.

Anything else answers one ledgered 400 not-emulated (`{ error: { type: 'not_emulated', message } }`,
`notEmulated` in the ledger), writes nothing, and uses up no fault: unknown routes and methods (other
users, comments, block reads or updates, database queries, page deletes), another origin, a missing bearer or
`Notion-Version`, query parameters on routes that take none, other search filters and keys, a search
without matches or whose matches include a trashed page or a page shown only as a query row, `sorts`, `filter`, or `start_cursor` on the data source query,
a query page that would show a row no fixture shows (or a last page), the cursors above, children
of anything but a page or of a page without recorded child blocks, a property with no seeded item list (or a singly encoded property id), a
missing database or data source, a read of an implied page or of a page shown only as a query row,
page creates with `children`, a database parent, another title, more than one title item,
annotations, or a missing or trashed parent, page updates other than `{ archived: true }`, and
archiving a missing, implied, row, or already trashed page. A route that throws answers an
evidence-tagged 500 emulator error with `responseError` in the ledger, and a closed emulator answers 503.

State and seeds: the bot user, pages (`parent`, trash flags, `properties` as stored, `url`), implied
pages, blocks, paginated property items, databases, data sources, and the page counter. The default
seed is the synthetic fixture entities with the same ids as `notionConformanceFixtureSeeds`. Pass
`seed: { profile?, botUser?, pages?, impliedPages?, blocks?, propertyItems?, databases?,
dataSources? }` (lists replace the profile's) with profiles `'default'` or `'empty'`. Property
item `next_url` values name the recorded origin. `reset()`, `seed(next)`, and
`snapshot()` behave as in the Dropbox emulator; reset and seed also clear issued cursors.

Faults, the ledger (which records the `Notion-Version` header), and the control plane behave as in
the Dropbox emulator; a 429 fault with `retry-after` reaches the connector as
`notion_rate_limited`.

**Drill knobs (tests only).** `drills: { searchRepeatsResults, botUserAsPerson,
envelopeStatusMismatch, omitTitlePlainText, blockCursorRepeats, rejectDoubleEncodedPropertyId,
rowParentAsDatabase, trashedPageNotFound }` (booleans) each make the emulator disagree with exactly
one Notion case, only to prove that case catches it.

## Todoist and Telegram emulators

> **Node only.** `@yolk-sdk/emulators/todoist` and `@yolk-sdk/emulators/telegram` run on the same
> pinned `@emulators/core` runtime as the Fortnox and Microsoft emulators, loaded lazily by
> `makeTodoistEmulator` / `makeTelegramEmulator`, so importing either subpath has no side effects.

Both are **fixture-only** and stateful: response behaviour comes only from their committed
conformance fixtures (copied as data), the state decides which recorded answer applies (created
ids, a deleted project, a sent message), and everything the fixtures do not record answers one
ledgered 400 not-emulated, `{ error: { type: 'not_emulated', message: 'Not emulated: <reason>' } }`
(`notEmulated` in the ledger), with no guessed provider status, envelope, or error code. That covers
unknown routes and methods, missing or malformed credentials, query parameters, body fields, and
values no fixture records. A refused request writes nothing and uses up no fault (eligibility is
checked against the request and the state before any fault is chosen). They share one
internal wrapper (ledger, faults, control plane, clock-free recovery); each returns
`{ fetch, ledger, faults, reset, seed, snapshot, coverage, close }` (Todoist adds `cursors`). Each
call has its own state; `await close()` when done (later requests answer 503).

```ts
import { makeTelegramEmulator } from '@yolk-sdk/emulators/telegram'
import { makeTodoistEmulator } from '@yolk-sdk/emulators/todoist'
import { EmulatorRoute, InProcessHttpClient } from '@yolk-sdk/emulators/router'

const todoist = await makeTodoistEmulator()
const telegram = await makeTelegramEmulator()

const httpLayer = InProcessHttpClient.layer([
  EmulatorRoute.handler('https://api.todoist.com', todoist.fetch),
  EmulatorRoute.handler('https://api.telegram.org', telegram.fetch)
])
// ...run the code under test, then:
await Promise.all([todoist.close(), telegram.close()])
```

### Todoist emulator

Routes (under `/api/v1`, JSON, `Authorization: Bearer <token>` with a token of at least 8
characters, whose value is never checked against anything, stored, forwarded, or ledgered; without
it a request is not emulated):

| Route                                | Behavior                                                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /tasks?project_id&limit&cursor` | Active tasks by `child_order` of the paging project (`limit=2`) or a case project created here (no `limit`); REST v1 cursor paging (`{ results, next_cursor }`) |
| `POST /tasks`                        | `{ content, project_id, due_date? }` in a case project created here: the new task (200)                                                                         |
| `GET /tasks/{taskId}`                | An active task (labels as label names), or the fixtures' 404 `Task not found` body                                                                              |
| `POST /tasks/{taskId}`               | `content` and/or `due_datetime` of an active task created here: the updated task                                                                                |
| `POST /tasks/{taskId}/close`         | Closes an active task created here (204, no body); it leaves the active listing                                                                                 |
| `GET /labels?limit`                  | Personal labels, one page (`next_cursor: null`)                                                                                                                 |
| `POST /projects`                     | `{ name, parent_id }` for a case project `yolk-conformance-<runId>-<lifecycle\|due\|parent\|delete>`                                                            |
| `GET /projects/{projectId}`          | A project created here, or the fixtures' 404 `Project not found` body                                                                                           |
| `DELETE /projects/{projectId}`       | A project created here: 204; it and its task are removed, so later reads answer 404                                                                             |

Wire claims, all from the fixtures: project and task bodies carry the fixtures' keys, order, and
default values (including `child_order: 1`); 404 bodies are `{ error, error_code: 478, error_extra:
{ event_id }, error_tag: 'NOT_FOUND', http_code: 404 }`; the first task page of a listing larger
than `limit=2` answers `next_cursor` (`SyntheticTaskCursor0001`, ...), the cursor leads to the next
page of the same project and `limit`, and the last page answers `next_cursor: null`;
`due_date: '2030-01-15'` and `due_datetime: '2030-01-15T12:00:00Z'` answer the recorded due
objects; an update keeps `updated_at`, as recorded.

Nothing else is synthesised. Seeded projects (the work and paging projects, whose objects no
fixture records; the fixtures name only their ids) are reference targets only: reading one answers
not-emulated, and only projects and tasks created through the recorded create flow are updated,
closed, or deleted. A case project takes one task and a seeded parent one sub-project, because the
fixtures record `child_order: 1` only (a second one is not emulated). The labeled task is in the
work project (the synthetic label fixture was corrected to match the paging listing, which never
lists it).

**Unrecognised requests.** The emulator fails closed: a request is recognised only when its raw path
is exactly one of the routes above under its HTTP method, with raw id segments that are Todoist ids
(percent-encoding is never recognised). Every other request is ledgered and answered with constant
text only: the path `/<unrecognised>`, a standard method or `<other>`, no query, no body, and the
reason `no emulated Todoist route for this method and path`. A request whose `Authorization` header
is present but is not one recognisable bearer (a non-bearer scheme, a value under 8 characters,
extra words, combined duplicate headers) is ledgered the same way, whatever its route, with the
reason `an unrecognisable Authorization header is not emulated`: its credential cannot be extracted
and scrubbed, so nothing from the request is recorded.

**Sharing one emulator.** Run write cases sequentially on one emulator, or `reset()` between cases.
A seeded parent takes one case project at a time (the fixtures record `child_order: 1` only), so
concurrent write cases, or a case that failed before its cleanup, make later project creates answer
not-emulated (a definitive rejection: nothing is created). `test/todoist-conformance.test.ts` runs
all seven cases one after another on one emulator, which ends at the seed except the counters.

Every answer value comes from a fixture, through the seed or the request, except the values the
emulator mints (it never mints anything else):

- **Minted values.** Created project ids (`6XEmuProject0001`), task ids (`6XEmuTask0000001`), and
  404 `event_id`s (`00000000000000000000000000000001`) come from counters that only advance;
  created timestamps come from the injectable `now` clock (default `Date.now`). Minted ids use the
  reserved prefix `6XEmu`, which a seed may not use (it is rejected), so seeded and created ids
  never collide. Cursors are runtime data (`cursors()`, `/_emulate/state`), valid only as issued
  since the last `reset` or `seed`.
- **Removal.** A deleted project and its task are removed from the state, so a write case ends at
  the seed except the counters.
- **Request-shape latitude** (the only accepted deviations from the fixture requests): any
  credential value of at least 8 characters that occurs nowhere else in the request (its path,
  query, or body; never checked against anything, stored, or ledgered); extra request headers;
  `content-type` parameters; query parameters in any order; any Todoist id (1-64 of `[A-Za-z0-9_-]`)
  of an existing item where a fixture has an id (reads: seeded or created tasks and created
  projects; task listings: the paging project with `limit=2` and case projects created here without
  `limit`; writes: only items created through the recorded create flow; a new project's `parent_id`:
  a seeded project); any `run-` run id (at most 40 characters) in a case project name; any non-empty
  task `content`; a task update sending `content`, `due_datetime`, or both; a label listing `limit`
  of 1 to 200 that covers every label.

Not emulated (400), among others: other routes (`/tasks/filter`, sections, comments, REST v2, and
the project listing `GET /projects`); task listings without `project_id`, of any project but the
paging project with `limit=2` or a case project created here without `limit`, or with a cursor the
emulator did not issue since its last reset or that is sent with another `project_id` or `limit`;
label listings without `limit` or with more labels than `limit` (paging them is not emulated); body
fields no fixture sends (`labels`, `priority`, `due_string`, `description`, ...); other due values;
project names outside the run namespace; reading a seeded project; projects under a case project or
an unknown parent, or a second sub-project; tasks outside a case project created here, or a second
one in it; reading a closed task; updating or closing a seeded, unknown, or closed task; deleting a
seeded or unknown project; a path, query, or body that repeats the bearer value; write bodies that
are not `application/json` objects. Reading an absent task or project answers the fixtures' 404.

**Leftover lookup.** No fixture records the project listing that `findTodoistConformanceLeftovers`
sends (`GET /projects?limit=200`), so it answers the ledgered 400 not-emulated like any other
unrecorded route: the lookup fails with `todoist_list_projects_failed` (HTTP 400), and the
repository runners print their lookup-failed WARN (`WARN could not look for leftovers (lookup
failed: todoist_list_projects_failed HTTP 400); check for yolk-conformance items by hand`) instead
of leftover warnings. It never writes. Emulating the listing needs a committed fixture for it first.

Seeds: `seed: { profile?, userId?, projects?, tasks?, labels? }` (entity lists replace the
profile's) with profiles `'default'` (the fixture entities, with the ids of
`todoistConformanceFixtureSeeds`) and `'empty'` (only the work project). Ids starting with `6XEmu`
are rejected.

**Drill knobs (tests only).** `drills: { cursorRestarts, notFoundWithoutError, taskLabelsAsIds,
listIncludesClosed, ignoreDue, createOmitsParent, deleteKeepsTasks }` each make the emulator
disagree with exactly one Todoist case (paging, not-found envelope, labels, lifecycle, due dates,
parent id, delete), only to prove that case catches it.

### Telegram emulator

Routes (on `https://api.telegram.org`; the bot token is a path segment):

| Route                              | Behavior                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `POST /bot<token>/getChat`         | `{ chat_id }`: `{ ok: true, result }` for a member chat, else the recorded 400 `Bad Request: chat not found` |
| `GET /bot<token>/getFile?file_id`  | `{ ok: true, result: { file_id, file_unique_id, file_size, file_path } }` for a seeded file                  |
| `GET /file/bot<token>/<file_path>` | The file's bytes (`application/octet-stream`), exactly `file_size` of them                                   |
| `POST /bot<token>/sendMessage`     | `{ chat_id, text, disable_web_page_preview: true }`: `{ ok: true, result }` with the sent message            |

**The bot token is required but never stored, forwarded, ledgered, or echoed.** The emulator fails
closed. A request is recognised only when its raw path is exactly an emulated route shape under that
route's HTTP method: `/bot<token>/<method>` with an emulated method, or
`/file/bot<token>/<file_path>` with plain `[A-Za-z0-9_.-]` segments, the token on the raw segment
matching `<digits>:<secret>` (a secret of at least 8 of `[A-Za-z0-9_-]`), and no other path text.
Every other request (an unknown method or route, extra segments, a missing, malformed, or
percent-encoded token, an encoded separator such as `%2F` or `%252F`) is ledgered and answered with
constant text only: the path `/<unrecognised>`, a standard method or `<other>`, no query, no body,
and the reason `no emulated Bot API route for this method and path`. For a recognised request, the
token is taken from that exact segment; the emulator scrubs it and its secret part from the ledgered
method, path (`/bot<redacted>/getChat`), query keys and values, and every not-emulated message, and
it refuses, with constant text, a query, a remaining path segment, or a body that repeats either:
raw, percent-decoded, or in any parsed JSON key, string value, or number (so `\u`-escaped forms and
numbers such as `1.2345678e7` are caught). Refusal messages never quote a request key or value. A
token whose bot id is `0` names no bot: `getChat` answers the recorded 401 `Unauthorized` (`{ ok:
false, error_code: 401, description }`); other methods with it are not emulated. Fault `match.path`
uses the redacted path; `match.route` the manifest template (`/bot{token}/sendMessage`).

`sendMessage` is irreversible on the real service: the emulator records each sent message in its
state (`sentMessages`: `message_id` from 101, `chat_id`, `text`, `date` from the `now` clock in
seconds) and never delivers anything; only `reset` or `seed` drops them. The answer's `from` is the
seeded bot (never derived from the token).

Every answer value comes from a fixture, through the seed or the request, except the values the
emulator mints (it never mints anything else): the `message_id` counter and the clock-derived
`date`.

**Request-shape latitude** (the only accepted deviations from the fixture requests): any credential
value of at least 8 characters that occurs nowhere else in the request (its path, query, or body;
never checked against anything, stored, or ledgered); extra request headers; `content-type`
parameters; a well-formed `<digits>:<secret>` bot token with a secret of at least 8 characters (the
bot id `0` names no bot); any well-formed `chat_id` string (an integer or a public `@username`; one
the bot is not in answers the recorded 400 on `getChat`); any non-empty message `text`.

Not emulated (400), among others: other methods (`getMe`, `deleteMessage`, ...), `GET getChat`,
query parameters or body fields no fixture sends (`parse_mode`, `link_preview_options`, ...),
`disable_web_page_preview` other than `true`, numeric `chat_id`s, `sendMessage` to a chat the bot is
not in, `getFile` of a file the bot did not receive, and file paths `getFile` did not answer.

Seeds: `seed: { profile?, bot?, chats?, files?, nextMessageId? }` with profiles `'default'` (the
fixture bot, chat, and 32-byte text file, with the ids of `telegramConformanceFixtureSeeds`) and
`'empty'` (the bot only). A file's `file_size` must equal its UTF-8 content's byte length.

**Drill knobs (tests only).** `drills: { getChatOkFalse, errorsAs200, fileSizeOffByOne,
sendOkFalse }` each make the emulator disagree with exactly one Telegram case.

### Faults, ledger, recovery, and control plane

Faults are `{ kind: 'status', status, headers?, body?, match?: { method?, path?, route? }, count? }`
with statuses 400-599 only (fixture-only routes never fake a success). A fault is chosen only after
the request passed every check, including the route handler's eligibility check against the
state (which writes nothing), and it answers before the commit (nothing is written); a refused
request answers 400 not-emulated and leaves every fault unused. The default body is
`{ error: { type: 'emulator_fault', message } }`. For example a 429 reaches the connectors as
`todoist_rate_limited` / `telegram_rate_limited`. Header rules are the shared ones (valid names and
values, no `location`, no framing headers); invalid faults throw `TodoistEmulatorInputInvalid` /
`TelegramEmulatorInputInvalid`. The ledger records method and path, route template, query keys
and values, parsed body, status, evidence, `notEmulated`, the applied fault, and `responseError`;
credential-named keys are redacted, and guarded credential values are scrubbed from every one of
them (a body that holds one is refused and never recorded). An unrecognised request (fail closed,
above) is ledgered with constant fields only: `/<unrecognised>`, a standard method or `<other>`,
an empty query, no body, and a constant `notEmulated` reason.

Recovery never reads the clock: a route handler that throws (for example because the injected clock
throws while creating a project or sending a message) answers an evidence-tagged 500
`{ error: { type: 'emulator_error', message } }` with `responseError` in the ledger and writes
nothing; not-emulated answers (400) and a closed emulator (503) need no clock. The control plane is
`/_emulate/ledger`, `faults`, `reset`, `state`, `seed`, and `coverage`, as for Fortnox.

## GitHub emulator

> **Node only.** `@yolk-sdk/emulators/github` runs on the same pinned `@emulators/core` runtime,
> loaded lazily by `makeGithubEmulator`, so importing the subpath has no side effects.

`await makeGithubEmulator(options?)` returns
`{ fetch, fetchOn, ledger, faults, reset, seed, snapshot, coverage, close }`. Each call has its own
state; `await close()` when done. It is a stateful, fixture-only stand-in for exactly the GitHub
REST routes the seven GitHub conformance cases send, so the GitHub connector and the cases run
unchanged against it. Every route answers only on the origin its fixtures record,
`https://api.github.com` (`githubEmulatorOrigin`): `fetch` reads the origin from the request URL;
behind a loopback rewrite, serve `fetchOn(githubEmulatorOrigin)`. Route `https://api.github.com` to
it:

```ts
import { makeGithubEmulator } from '@yolk-sdk/emulators/github'
import { EmulatorRoute, InProcessHttpClient } from '@yolk-sdk/emulators/router'

const github = await makeGithubEmulator()

const httpLayer = InProcessHttpClient.layer([
  EmulatorRoute.handler('https://api.github.com', github.fetch)
])
// ...run the code under test, then:
await github.close()
```

Routes (every request needs exactly `Authorization: Bearer <token>` with a recognisable bearer (see
Credentials), whose value is never compared against anything, stored, forwarded, or ledgered,
`Accept: application/vnd.github+json`, and `X-GitHub-Api-Version: 2026-03-10`, what every fixture
sends; bodies are JSON; `{owner}/{repo}` is the seeded repository):

| Route                                                             | Behavior                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /repos/{owner}/{repo}/labels`                                | `per_page`, `page`: repository labels with the paging fixture's `Link` header         |
| `GET /repos/{owner}/{repo}/issues/{issueNumber}`                  | The issue; the recorded 404 for a number the repository has not reached               |
| `GET /search/issues`                                              | `q`: the recorded 422 for a scoped query longer than 256 characters                   |
| `GET /repos/{owner}/{repo}/contents/{path+}`                      | A seeded file: `type: "file"`, base64 `content` folded every 60 characters            |
| `POST /repos/{owner}/{repo}/issues/{issueNumber}/comments`        | `{ body }`: 201 and the comment, on an open issue                                     |
| `GET /repos/{owner}/{repo}/issues/{issueNumber}/comments`         | `per_page=100`, `since`: the issue's comments updated at or after `since` (0 or 1)    |
| `DELETE /repos/{owner}/{repo}/issues/comments/{commentId}`        | 204; the recorded 404 when this emulator deleted it already                           |
| `POST /repos/{owner}/{repo}/issues/{issueNumber}/labels`          | `{ labels: [name] }`: one repository label added; answers the issue labels            |
| `DELETE /repos/{owner}/{repo}/issues/{issueNumber}/labels/{name}` | The remaining labels (never none); the recorded 404 for a label not on the issue      |
| `POST /repos/{owner}/{repo}/issues`                               | `{ title, body }`: 201 and the open issue                                             |
| `PATCH /repos/{owner}/{repo}/issues/{issueNumber}`                | `{ title }` or `{ state: "closed", state_reason: "completed" }` on an issue made here |

Wire behavior, as the fixtures record it:

- **Link paging.** Label pages carry the paging fixture's `Link` header, minted in its exact form:
  `<https://api.github.com/repositories/{id}/labels?per_page=N&page=M>` relations in the order
  `prev`, `next`, `last`, `first` (`next` and `last` while pages remain, `prev` and `first` after
  the first page; the page after the last answers `[]` with `prev`, `last`, and `first`). A listing
  that fits one page carries no `Link`, as the label fixture records. No other route mints `Link`.
  Label pages are page numbers the client computes, as GitHub's are, not cursors: the label list
  never changes within a seed (no route writes labels), so no page can drift. The `Link` URLs name
  `/repositories/{id}/labels`, which is not emulated (the connector never follows them).
- **Errors.** The not-found, comment, label, and validation bodies are the fixtures' byte for byte
  (`githubEmulatorErrorBodies`), with `content-type: application/json; charset=utf-8`.
- **Issues.** Issues render in the fixture key order with `comments: 0`, `locked: false`, no
  assignees or milestone. A rename keeps `updated_at` (the lifecycle fixture records that);
  closing sets `state_reason: "completed"` and `closed_at` and `updated_at` from the clock.
- **Contents.** `content` is the UTF-8 file's base64, folded every 60 characters with a trailing
  line break, and `size` its byte length.

Every answer value comes from a fixture, through the seed or the request, except the values the
emulator mints (it never mints anything else):

- **Minted values.** Created issue numbers and comment ids come from counters that only advance; the
  default seed starts them at the fixtures' created values (issue `42`, comment `9000000001`), and a
  seed's counters must lie above every seeded number. They end at the last addressable issue number
  (ten digits) and comment id (fifteen digits, what the delete route takes); past that, a create is
  refused before any fault. A created issue's `id` (`3000000000 + number`) and `node_id`
  (`I_kwSynthetic<number>`), and a comment's `node_id` (`IC_kwSynthetic<id>`), derive from the
  minted value in the fixtures' form; no seeded node id (of an issue or a label; node ids are unique
  across both) may use those forms at or above its counter. Timestamps come from the injectable
  `now` clock, in whole seconds.
- **Implied issues.** Issue numbers below `nextIssueNumber` that the state does not hold are
  implied (the repository reached them, but no fixture shows them): any answer that would render
  one is not emulated. Numbers at or above it answer the not-found fixture's 404.
- **State rules.** Comments and label changes apply to issues the state holds and that are open;
  only issues created here are renamed or closed; a label add takes one repository label not yet on
  the issue that sorts after the issue's labels (the fixture's answer is both appended and in name
  order); a label removal leaves at least one label (no fixture records an empty answer); a comment
  listing shows at most one comment (the order of several is not recorded); an issue holding
  comments is never rendered (every fixture answers `comments: 0`); a comment delete of an id this
  emulator never held is not emulated.
- **Kept after writes.** A deleted comment's id stays in `deletedComments` (the comment fixture's
  second delete answers 404), and a closed issue stays in the repository (GitHub cannot delete
  issues). A write case ends at the seed except those and the counters.
- **Fail closed.** A request is recognised only when its raw path is exactly an emulated route shape
  (every path parameter matches its raw pattern: owner and repository names, decimal issue numbers
  and comment ids, plain label names, plain file paths) under that route's method, and any
  `Authorization` header is exactly `Bearer <token>` (see Credentials). Every other request (an
  unknown route or method, an encoded character, a malformed or duplicated `Authorization` header)
  is ledgered and answered with constant text only: the path `/<unrecognised>`, a standard method or
  `<other>`, an empty query, no body, and a constant reason
  (`no emulated GitHub route for this method and path`,
  `an unrecognisable Authorization header is not emulated`).
- **Credentials.** A recognised bearer must match the RFC 6750 `b64token` syntax exactly
  (`^[A-Za-z0-9\-._~+/]+=*$`, at least 8 characters), start with a character in `[G-Zg-z\-._~+/]`
  other than `n`, `r`, `t`, `u`, and hold at least one character outside the JSON-number alphabet
  `[0-9.eE+-]` (every GitHub and Google token form does: `ghp_…`, `github_pat_…`, `gho_…`,
  `ya29.…`). So no number's text can contain it; it holds no escape introducer (`%`, `\`, `"`), so
  no escape starts inside it; and its first character is no hex digit and no JSON escape letter, so
  no stray `%`, `\`, or partial escape to its left can complete with it, and its characters always
  decode in place. An `Authorization` header with any other value is unrecognisable. A recognised
  request that repeats the bearer value in its raw path, any path segment, the raw query or any
  query key or value, any recorded header, or its body is refused and ledgered with constant text
  only: a standard method, the path `/<unrecognised>`, its route template, an empty query, no
  headers or body, and a constant reason (`the query repeats the credential`, for example). Each
  part is checked through the closure of two total, lexical transforms that cannot fail: a tolerant
  percent-decode (every `%XX` below `%80` becomes its ASCII character; any other `%` sequence is
  left as it is) and a tolerant JSON-unescape (in any text, whether or not it parses as JSON,
  `\uXXXX` below `\u0080` and `\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t` become their
  characters). Starting from each part's raw text, either transform is applied to every text of the
  previous step, deduplicated, until no new text appears (a fixpoint), and every text is checked for
  the bearer as a substring; both transforms never lengthen a text and shorten it whenever they
  change it. So any depth of percent-encoding or JSON escaping, in any order, is seen through in
  every part: the raw path and each raw path segment, the raw query and each query key and value
  (already decoded once by `URLSearchParams`), each recorded header, and the raw body. The work is
  capped at 64 rounds, 1024 distinct texts, or 8 Mi characters read by the transforms, whichever
  comes first; a part whose closure hits a cap before its fixpoint counts as repeating the
  credential and is refused with the same constant entry (uncertainty refuses, it never admits; so
  any part over 4 Mi characters is always refused). Any other recognised request has the bearer
  value scrubbed from its ledgered fields and every not-emulated reason (plan-time reasons
  included); its recorded query is keyed by recorded key; a key recorded more than once lists its
  values in order (as a JSON array); and recorded headers and query keys and values that start like
  JSON (`{`, `[`, `"`) are recorded parsed with credential-named keys redacted at any depth, or as
  `<redacted>` when they do not parse, whatever the header's declared format. Refusals never echo a
  request's own query or body keys, and empty query components (a bare `?`, a stray `&`) are
  refused.
- **Request-shape latitude (`/github`, the only accepted deviations).** Any bearer value in the RFC
  6750 `b64token` syntax (`[A-Za-z0-9\-._~+/]+=*`) of at least 8 characters, starting with a
  character in `[G-Zg-z\-._~+/]` other than `n`, `r`, `t`, `u` (so a legacy all-hex token is
  refused), with at least one outside `[0-9.eE+-]`, that occurs nowhere else in the request (never
  compared against anything, stored, or ledgered); extra request headers; JSON key order;
  `content-type` media-type parameters; the order of query parameters; any non-empty issue title and
  comment body, and any issue body text; any comment listing `since` of the form
  `YYYY-MM-DDTHH:MM:SSZ`; any label listing `per_page` from 1 to 100, with no `page` or a `page`
  from 2 to one past the last page; any issue search `q` that starts with the seeded
  `repo:<owner>/<repo>` qualifier and whose query after it is longer than 256 characters (answered
  the recorded 422); any issue number the repository has not reached (answered the recorded 404);
  and any issue, comment, repository label, or file the state holds where a fixture has one, under
  the per-route state rules. `Authorization` must be exactly `Bearer <token>` (that spelling, one
  space), `Accept` `application/vnd.github+json`, and `X-GitHub-Api-Version` `2026-03-10`.
  Everything else (other keys and values, query parameters, empty query components such as a bare
  `?` or a stray `&`, another origin or repository, a repeated query key, an explicit `page=1`, and
  a comment listing `per_page` other than 100) is not emulated.

Anything else answers one ledgered 400 not-emulated (`{ error: { type: 'not_emulated', message } }`,
`notEmulated` in the ledger), writes nothing, and uses up no fault: other routes (issue and pull
request listings, locks, assignees, reactions, timelines), a search of at most 256 characters
(no fixture records results), `sort`, `order`, or paging on search, a contents `ref` or a missing
file, issue creates with `labels`, `assignees`, `milestone`, or `type`, updates other than the two
recorded ones (so the lifecycle case's failure-path restore, which closes as `not_planned`, is not
emulated), adding a label the repository lacks (that would create it) or two labels at once, and
writes to closed or implied issues. That includes the open-issue listing
(`GET /repos/{owner}/{repo}/issues`) of the read-only leftover lookup
`findGithubConformanceLeftovers`, which no fixture records: the lookup fails
(`GithubConformanceActionFailed`, `github.list_issues`, `github_validation`, HTTP 400), and the
repository runner prints its lookup-failed `WARN` instead of leftover warnings. A route that throws
answers an evidence-tagged 500 emulator error with `responseError` in the ledger, and a closed
emulator answers 503; neither reads the clock.

State and seeds: the authenticated `viewer` (the author of everything created here), the
`repository` (owner, name, the id the `Link` URLs name, default branch), labels, issues (labels by
name; `createdHere` marks issues created here), comments, `deletedComments`, files (path, blob sha,
UTF-8 text), and the counters. The default seed is the synthetic fixture entities with the values of
`githubConformanceFixtureSeeds`: the five paging-fixture labels, open work issue 1 labelled `bug`,
and `docs/synthetic-notes.txt`. Pass a `seed` with any of `profile`, `viewer`, `repository`,
`labels`, `issues`, `files`, `nextIssueNumber`, and `nextCommentId` (lists replace the profile's)
with profiles `'default'` or `'empty'`. `reset()`, `seed(next)`, and `snapshot()` behave as in the
Dropbox emulator.

Faults, the ledger (which records the `Accept` and `X-GitHub-Api-Version` headers), and the control
plane behave as in the Dropbox emulator; a 429 fault with `retry-after` reaches the connector as
`github_rate_limited`.

**Drill knobs (tests only).** The `drills` booleans `linkOmitsNext`,
`notFoundOmitsDocumentationUrl`, `validationWithoutErrors`, `contentUnfolded`, `sinceExcludesEqual`,
`addAnswerOmitsLabel`, and `closeWithoutClosedAt` each make the emulator disagree with exactly one
GitHub case, only to prove that case catches it.

## Google emulator

> **Node only.** `@yolk-sdk/emulators/google` runs on the same pinned `@emulators/core` runtime,
> loaded lazily by `makeGoogleEmulator`, so importing the subpath has no side effects.

`await makeGoogleEmulator(options?)` returns
`{ fetch, fetchOn, ledger, faults, reset, seed, snapshot, coverage, close }`. Each call has its own
state; `await close()` when done. It emulates only the Gmail, Calendar, and Drive routes the
thirteen Google conformance cases (with their cleanup) send, so the Google connector actions and the
cases run unchanged against it, the irreversible practice send included. Each route answers only on
the origin its fixtures record: Gmail (the API and the multipart send upload) on
`https://gmail.googleapis.com` (`googleEmulatorGmailOrigin`), Calendar and Drive on
`https://www.googleapis.com` (`googleEmulatorApisOrigin`). `fetch` takes the origin from the request
URL (in-process routing keeps it); behind a loopback rewrite, which loses it, serve
`fetchOn(origin)` for each origin on its own server:

```ts
import {
  googleEmulatorApisOrigin,
  googleEmulatorGmailOrigin,
  makeGoogleEmulator
} from '@yolk-sdk/emulators/google'
import { EmulatorRoute, InProcessHttpClient } from '@yolk-sdk/emulators/router'

const google = await makeGoogleEmulator()

const httpLayer = InProcessHttpClient.layer([
  EmulatorRoute.handler(googleEmulatorGmailOrigin, google.fetch),
  EmulatorRoute.handler(googleEmulatorApisOrigin, google.fetch)
])
// With serveFetchHandler: one server per origin, serving google.fetchOn(origin).
// ...run the code under test, then:
await google.close()
```

The read-only leftover lookup (`findGoogleConformanceLeftovers`) fails against it: its first read,
the Gmail label listing, has no fixture (nor do its draft search, free-text event query, and
trashed-included Drive listing), so it answers the ledgered 400 not-emulated (nothing is written)
and the lookup fails with `GoogleConformanceActionFailed` (`gmail_list_labels_failed`, HTTP 400);
the live runner turns that into its lookup-failed `WARN`.

Routes (every request needs `Authorization: Bearer <token>`, a recognisable bearer; bodies are
JSON unless noted; Drive requests also send `accept: application/json`, as recorded):

| Route                                                            | Behavior                                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /gmail/v1/users/me/messages`                                | `labelIds`, `maxResults`, `pageToken`: `{ messages: [{ id, threadId }], nextPageToken? }`     |
| `GET /gmail/v1/users/me/messages/{messageId}`                    | `format=minimal`, `metadata`, or `full`, as recorded for that message; the recorded 404       |
| `GET /gmail/v1/users/me/messages/{messageId}/attachments/{id}`   | `{ size, data }` (base64url) of a seeded attachment                                           |
| `POST /gmail/v1/users/me/messages/{messageId}/modify`            | `{ addLabelIds: [<created label>] }`: `{ id, threadId, labelIds }`                            |
| `POST /gmail/v1/users/me/messages/{messageId}/trash`, `/untrash` | No body: adds or removes `TRASH`, answering `{ id, threadId, labelIds }`                      |
| `POST /gmail/v1/users/me/labels`                                 | `{ name: "yolk-conformance <runId> label" }`: the created user label (`Label_9101` first)     |
| `GET`, `DELETE /gmail/v1/users/me/labels/{labelId}`              | Delete a created label (204; it leaves every message); a read of an absent label answers 404  |
| `POST /gmail/v1/users/me/drafts`, `PUT .../drafts/{draftId}`     | The recorded run draft without recipients: `{ id, message: { id, threadId, labelIds } }`      |
| `DELETE /gmail/v1/users/me/drafts/{draftId}`                     | 204 (the draft and its message go); an absent draft answers the recorded 404                  |
| `GET /gmail/v1/users/me/threads/{threadId}`                      | `format=full`: a draft thread created here                                                    |
| `POST /upload/gmail/v1/users/me/messages/send`                   | `uploadType=multipart`, `multipart/related`: the practice message only (see below)            |
| `GET`, `POST /calendar/v3/calendars/{calendarId}/events`         | Range listing (`singleEvents=true`, `orderBy=startTime`) with page tokens; the run event      |
| `GET`, `PATCH`, `DELETE .../events/{eventId}`                    | Read (cancelled too), the recorded rename, delete to `cancelled` (204), then the recorded 410 |
| `GET`, `POST /drive/v3/files`                                    | Folder listing (`'<folder>' in parents and trashed = false`) with page tokens; the run folder |
| `GET`, `PATCH`, `DELETE /drive/v3/files/{fileId}`                | Read with the connector `fields` (absent: the recorded 404), `{ trashed: true }`, delete 204  |

**The practice send is recorded, never delivered.** `google.gmail.send-practice-address` is
irreversible on Gmail. The emulator accepts only the recorded 7-bit message whose sole recipient
header is `To: <the seeded practiceAddress>` (no `Cc`, `Bcc`, other address, or list) with the
run-scoped subject and `{}` metadata, records it in the state (a message with the `SENT` label whose
`format=metadata` read answers the recorded headers, with the `Date` header from the `now` clock and
a minted `Message-ID`), and delivers nothing anywhere; only `reset` or `seed` drops it. A seed may
set another `practiceAddress`, but then every send answers 400 not-emulated (the reason names the
recorded `practice@example.test`): the recorded `sizeEstimate` of the sent message covers its
address, as it covers its subject, so draft and send subjects need a run id of the fixtures' length
(13 characters; see the latitude below). The draft metadata `body.size` (64) and the sent message
`body.size` (88) are the fixtures' recorded values, answered as recorded.

**Fail closed: the shared rule.** Google follows the shared fail-closed rule of the stateful
wrapper, exactly as the GitHub emulator states it above: every route parameter has a raw pattern
matched in full (Gmail ids, a calendar id whose only encoding is `%40`, event ids, Drive ids), so a
request is recognised only when its raw path is exactly an emulated route shape under that route's
method and any `Authorization` header is exactly `Bearer <token>` with a recognisable bearer (an RFC
6750 `b64token` of at least 8 characters, starting with a character in `[G-Zg-z\-._~+/]` other than
`n`, `r`, `t`, `u`, with at least one outside `[0-9.eE+-]`; Google's `ya29.…` tokens qualify). Every
other request is ledgered and answered with constant text only: the path `/<unrecognised>`, a
standard method or `<other>`, no query, no body, and a constant reason. The bearer value is never
compared against anything, stored, forwarded, or ledgered. A recognised request that repeats it in
its raw path, any path segment, the query or any query key or value, the recorded `content-type`
header, or its raw body (the multipart send body included), or, on the draft compose and update
routes, in the base64url-decoded MIME of `message.raw` (a decoded view the routes give the wrapper),
through any depth of percent-encoding or JSON escaping, is ledgered as the constant
credential-repeat entry; any other recognised request has it scrubbed from its ledgered fields and
every not-emulated message. A `message.raw` the route would refuse (anything but canonical unpadded
base64url of exactly the recorded draft MIME, the run id aside) makes the view throw a
`DecodedViewRefusal` with one of the route's declared constant reasons (`viewRefusalReasons`: the
canonical-base64url reason, the other-than-the-recorded-run-draft reason, the 13-character run-id
reason, the extra-key reason), which the wrapper ledgers in the constant entry before anything is
recorded (or `the request body repeats the credential` when the raw decodes cleanly to text holding
the bearer), so a refused `message.raw` never reaches the ledger. Refusals never echo a request's
own query or body keys.

Every answer value comes from a fixture, through the seed or the request, except the values the
emulator mints (it never mints anything else):

- **Minted values.** Created label ids (`Label_9101`, ...) start above every seeded label number
  (label ids are `Label_<1 to 999999999>`: a seeded `Label_<digits>` id outside that form is
  rejected, and a create when no number is left is not emulated); draft ids
  (`r-8000000000000000001`, ...), draft and sent message ids (`18f00000000000d1`,
  `18f00000000000e1`, ...; a created draft is its own thread), event ids
  (`syntheticconformance0001`, ...), and folder ids (`synthetic-conformance-folder-0001`, ...) use
  forms no seeded id or thread id may use. All come from counters in the state that only advance.
  Event `created` / `updated`, folder `createdTime` / `modifiedTime` / `trashedTime`, and the sent
  `Date` header come from the injectable `now` clock. Page tokens are the fixtures' values
  (`synthetic-gmail-page-2`, ...) in the generation that first issued them, and
  `<token>.g<generation>` after a reset or seed (each starts a generation); a token is never
  rebound: token values are globally unique, so another list or page size, or a changed list, gets a
  distinct `<token>.v<k>`.
- **Implied entities.** The paging label (`impliedLabelIds`), the five messages its listing names
  (`impliedMessages`, rendered only as `{ id, threadId }` list entries), and the practice Drive
  folder (`impliedFolderIds`) are only named by the fixtures: references resolve through them (a
  label listing, a folder parent), but an answer that would render one is not emulated.
- **Recorded renderings.** A Gmail message answers only the formats a fixture records for it (the
  work message `minimal`, the attachment message `full`, a composed draft `metadata` and `full`, an
  updated draft `full`, a sent message `metadata`); another format is not emulated.
- **What writes leave.** A reversible case ends at the seed except the counters, plus each event
  case's own event, which Calendar keeps readable as `cancelled` (the fixtures read it back); the
  send leaves its sent message. Deleting a label removes it from every message.
- **Page tokens.** A token is accepted only when this emulator issued it for the same list (label
  and `maxResults`; calendar, range, and `maxResults`; folder and `pageSize`) since the last reset
  or seed, and the list renders exactly as when it was issued.
- **Request-shape latitude (`/google`, the only accepted deviations).** Any bearer value in the RFC
  6750 `b64token` syntax (`[A-Za-z0-9\-._~+/]+=*`) of at least 8 characters, starting with a
  character in `[G-Zg-z\-._~+/]` other than `n`, `r`, `t`, `u`, with at least one outside
  `[0-9.eE+-]` (Google's `ya29.…` access tokens qualify), that occurs nowhere else in the request
  (never compared against anything, stored, or ledgered); extra request headers (except
  `X-Goog-Drive-Resource-Keys`, which no fixture sends); JSON key order; `content-type` media-type
  parameters on JSON requests; query parameters in any order; any `run-` run id (at most 40
  characters) in a run-scoped label name, event summary, or folder name; in a draft subject (compose
  and update) and the sent subject, only a run id of exactly 13 characters, the length of the
  fixtures' `run-synthetic`, because the recorded `sizeEstimate` of the draft and sent messages
  (answered by their message reads and the draft thread) covers the subject; on the practice send, a
  `content-type` of exactly `multipart/related; boundary=<b>` with any one unquoted boundary of 1 to
  70 `[A-Za-z0-9_]` characters and no other parameter; a `gmail.list` `maxResults` from 1 to 500, a
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
  or whose list changed) is not emulated.

Anything else answers one ledgered 400 not-emulated (`{ error: { type: 'not_emulated', message } }`,
`notEmulated` in the ledger), writes nothing, and uses up no fault: among others the label listing,
draft listing, and calendar listing, `q` on Gmail or Calendar listings, an empty listing (no fixture
records one), a Gmail listing that would leave out messages in Trash or Spam, a Calendar range
holding a cancelled event, a Drive listing including trashed items, reads of an existing label or
of an implied entity, threads of seeded messages, label changes other than adding one label
created here, writes to seeded events and files, and the page tokens above. A route that throws
(for example when the injected clock throws while creating an event or a folder, or sending)
answers an evidence-tagged 500 `{ error: { type: 'emulator_error', message } }` with
`responseError` in the ledger and writes nothing; a closed emulator answers 503. No recovery answer
reads the clock.

State and seeds: `practiceAddress`, Gmail `messages` (with their recorded renderings),
`impliedMessages`, `impliedLabelIds`, created `labels`, `attachments`, `drafts`, Calendar
`calendars` and `events`, Drive `files` and `impliedFolderIds`, and the counters. The default seed
is the synthetic fixture entities with the ids of `googleConformanceFixtureSeeds`. Pass
`seed: { profile?, practiceAddress?, messages?, impliedMessages?, impliedLabelIds?, attachments?,
calendars?, events?, files?, impliedFolderIds? }` (lists replace the profile's; labels and drafts
are never seeded) with profiles `'default'` or `'empty'`. `reset()`, `seed(next)`, and
`snapshot()` behave as in the Dropbox emulator; reset and seed also clear issued page tokens.

Faults and the control plane behave as in the Dropbox emulator (the ledger records only the
`content-type` request header); a 429 fault with `retry-after` reaches the connector as
`google_rate_limited` with `retryAfterMs`.

**Drill knobs (tests only).** `drills: { gmailPageRepeats, attachmentStandardBase64,
notFoundWithoutMessage, labelDeleteKeepsOnMessages, draftUpdateKeepsContent,
trashAnswerOmitsTrash, sentMessageWithoutTo, calendarPageRepeats, eventPatchKeepsSummary,
repeatedEventDeleteConflict, drivePageRepeats, getFileWithoutParents, listIncludesTrashed }`
(booleans) each make the emulator disagree with exactly one Google case, only to prove that case
catches it.

## LinkedIn search emulator

> **Node only.** `@yolk-sdk/emulators/linkedin-search` runs on the same pinned `@emulators/core`
> runtime, loaded lazily by `makeLinkedInSearchEmulator`, so importing the subpath has no side
> effects.

`await makeLinkedInSearchEmulator(options?)` returns
`{ fetch, fetchOn, ledger, faults, reset, seed, snapshot, coverage, close }`. Each call has its own
state; `await close()` when done. It emulates only the Exa and Enrich Layer routes the seven
LinkedIn search conformance cases send, so the LinkedIn search connector actions and the cases run
unchanged against it. Each route answers only on the origin its fixtures record: the Exa people
search on `https://api.exa.ai` (`linkedInSearchEmulatorExaOrigin`), the Enrich Layer profile and
email lookups on `https://enrichlayer.com` (`linkedInSearchEmulatorEnrichLayerOrigin`, under the
connector's `/api/v2` base). `fetch` takes the origin from the request URL (in-process routing keeps
it); behind a loopback rewrite, which loses it, serve `fetchOn(origin)` for each origin on its own
server:

```ts
import {
  linkedInSearchEmulatorEnrichLayerOrigin,
  linkedInSearchEmulatorExaOrigin,
  makeLinkedInSearchEmulator
} from '@yolk-sdk/emulators/linkedin-search'
import { EmulatorRoute, InProcessHttpClient } from '@yolk-sdk/emulators/router'

const linkedIn = await makeLinkedInSearchEmulator()

const httpLayer = InProcessHttpClient.layer([
  EmulatorRoute.handler(linkedInSearchEmulatorExaOrigin, linkedIn.fetch),
  EmulatorRoute.handler(linkedInSearchEmulatorEnrichLayerOrigin, linkedIn.fetch)
])
// With serveFetchHandler: one server per origin, serving linkedIn.fetchOn(origin).
// ...run the code under test, then:
await linkedIn.close()
```

Routes (every request needs `Authorization: Bearer <key>`, a recognisable bearer; each provider
takes its own key, and both are reads):

| Route                       | Behavior                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| `POST /search`              | `{ query, category: "people", numResults, type: "auto", contents: { text: true } }`: `{ results }` |
| `GET /api/v2/profile`       | `linkedin_profile_url`: a held profile, or the recorded 404 for a seeded absent profile            |
| `GET /api/v2/profile/email` | `linkedin_profile_url`: `{ email }` of a held profile                                              |

Every answer comes from a fixture, byte for byte, through the seed; the emulator mints nothing (no
ids, cursors, or clock reads), so nothing is ever written and every case ends exactly at its seed:

- **Searches.** A search answers only the results the state holds for exactly its query and
  `numResults`. The default seed holds the three answers the fixtures record for the seeded query:
  `numResults` 10 (the people-results case), and 3 and 2 (the control and the limited search of the
  num-results-limit case, which answers its second result without `publishedDate`, as recorded).
  Another query or `numResults` (the unauthorized probe with an accepted key, for example) is not
  emulated; no fixture records an empty search.
- **Profiles.** A profile lookup answers a held profile in the profile fixture's fields
  (`public_identifier`, `full_name`, `headline`), and an absent profile (the seeded
  `absentProfileUrl`) the recorded 404 body; an email lookup answers a held profile's recorded
  `{ email }`. Any other profile URL, and the email of an absent profile, is not emulated.
- **Rejected keys, per origin.** A key the seed marks as rejected on an origin answers that
  origin's recorded 401 body (Exa's `{ requestId, error }`, Enrich Layer's
  `{ code, description, name }`), for any request of the emulated shape on that origin. The default
  seed rejects the synthetic invalid keys the two unauthorized cases send
  (`yolk-conformance-invalid-exa-key` on Exa, `yolk-conformance-invalid-enrich-layer-key` on Enrich
  Layer); a key rejected on one origin is accepted on the other. The error bodies are
  `linkedInSearchEmulatorErrorBodies`.

**Fail closed: the shared rule, and keys kept only as digests.** LinkedIn search follows the shared
fail-closed rule of the stateful wrapper, exactly as the GitHub emulator states it above: a request
is recognised only when its raw path is exactly an emulated route path under that route's method and
any `Authorization` header is exactly `Bearer <key>` with a recognisable bearer (an RFC 6750
`b64token` of at least 8 characters, starting with a character in `[G-Zg-z\-._~+/]` other than `n`,
`r`, `t`, `u`, with at least one outside `[0-9.eE+-]`; a UUID-form key, which starts with a hex
digit, is unrecognisable, so hand the emulator a synthetic key). Every other request is ledgered and
answered with constant text only. A recognised request that repeats its bearer in the raw path, the
query or any query key or value, the recorded `content-type` header, or the body, through any depth
of percent-encoding or JSON escaping, is ledgered as the constant credential-repeat entry; any other
has it scrubbed from its ledgered fields and every not-emulated message. The bearer is never stored
or ledgered: through the wrapper's opt-in per-origin `bearerDigest`, routes see only SHA-256 of the
origin, a space, and the key, which a plan compares with the digests of the seed's rejected keys for
that origin. The state holds only those digests, so a key a request carries as its bearer, a
rejected one included, never reaches the state, a snapshot, or `/_emulate/*` (a key sent as data
elsewhere in a request is ledgered like any other text). Refusals never echo a request's own query
or body keys.

- **Request-shape latitude (`/linkedin-search`, the only accepted deviations).** Any bearer value in
  the RFC 6750 `b64token` syntax (`[A-Za-z0-9\-._~+/]+=*`) of at least 8 characters, starting with a
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
  request) is not emulated.

Anything else answers one ledgered 400 not-emulated (`{ error: { type: 'not_emulated', message } }`,
`notEmulated` in the ledger) and uses up no fault. A closed emulator answers 503; a route that
throws answers an evidence-tagged 500 with `responseError` in the ledger.

State and seeds: `searches` (`{ query, numResults, results }`, 1 to `numResults` results with the
fixtures' optional `title`, `url`, `author`, `publishedDate`, and `text`), `profiles`
(`{ url, publicIdentifier, fullName, headline, email? }`), `absentProfileUrls`, and the digests of
the rejected keys (`exaRejectedKeyDigests`, `enrichLayerRejectedKeyDigests`). Pass
`seed: { searches?, profiles?, absentProfileUrls?, exaRejectedKeys?, enrichLayerRejectedKeys? }`:
each given list replaces the default seed's (the fixture entities); rejected keys are given as keys
(recognisable bearer values) and kept only as their digests, and no seed error quotes one: every
seed error is constant text, a category and a field path (`duplicate search at searches[1]`,
`unexpected key at the seed root`). `reset()`, `seed(next)`, and `snapshot()` behave as in the
Dropbox emulator.

Faults and the control plane behave as in the Dropbox emulator (the ledger records only the
`content-type` request header); the connector maps every non-2xx answer to its action's failure
code, so a 429 fault reaches it as `linkedin_search_failed` (or `linkedin_profile_failed`,
`linkedin_email_failed`) with status 429 and no `retryAfterMs`.

**Drill knobs (tests only).** `drills: { defaultSearchWithoutText, numResultsIgnored,
profileAnswersEmptyObject, emailAnswerOmitsEmail, exaUnauthorizedAs5xx,
enrichLayerUnauthorizedAs2xx, absentProfileAs2xx }` (booleans) each make the emulator disagree with
exactly one LinkedIn search case, only to prove that case catches it.

## Evidence

`gatewayEmulatorRoutes`, `openAiEmulatorRoutes`, `anthropicEmulatorRoutes`, `codexEmulatorRoutes`,
`xAiGrokEmulatorRoutes`, `openCodeGoEmulatorRoutes`, the three subscription-usage manifests,
`emailEmulatorRoutes`, `r2EmulatorRoutes`, `fortnoxEmulatorRoutes`, `microsoftEmulatorRoutes`,
`dropboxEmulatorRoutes`, `notionEmulatorRoutes`, `todoistEmulatorRoutes`, `telegramEmulatorRoutes`,
`githubEmulatorRoutes`, `googleEmulatorRoutes`, and `linkedInSearchEmulatorRoutes` list every
emulated route with `method`, `path`, `kind`, `write`, the conformance `caseIds` it follows,
`evidence` (`verified` or `unverified`), and `observedAt`. Every response from an unverified route
of a fetch-handler emulator carries `x-emulator-evidence: unverified`; the email and R2 emulators
record evidence on each ledger entry instead, since their plain-JSON replies carry no header. The
Gateway route is `verified` (`observedAt: '2026-09-30'`): its wire shapes are checked against the
verified live recordings. Every other route (OpenAI, Anthropic, Codex, Grok, OpenCode Go, the usage
routes, email, R2, Fortnox, Microsoft, Dropbox, Notion, Todoist, Telegram, GitHub, Google, and
LinkedIn search) is unverified, like the synthetic fixtures it follows.
Each manifest route maps to its own handler; an emulator whose manifest has a route without a
handler throws when it is constructed. The Yolk repository checks these manifests: unknown case ids,
duplicate routes, connector write routes without verified evidence, verified connector write routes
whose `observedAt` is missing, unreadable, or in the future, and verified routes whose cited cases
have no verified fixture fail, as do verified connector write routes citing no cases; unverified or
stale (over 30 days) evidence and other routes citing no cases warn.

The email emulator's eight write routes are unverified connector writes. Until an owner-approved
live run against a practice mailbox verifies them, the repository lists them in a visible,
time-bounded allowlist (`scripts/emulator-evidence-pending.json`, which holds each entry's expiry
date): the check reports them as PENDING warnings until that date and fails again after it. The
R2 emulator's one write route, `PORT R2ObjectClient.put`, is held in the same list until an
owner-approved live run against a practice bucket, through a host `R2ObjectClient`
implementation, verifies it.

All Fortnox, Microsoft, Dropbox, Notion, Todoist, Telegram, GitHub, Google, and LinkedIn search
routes are currently `unverified` (no live recording yet), including four Fortnox, eleven Microsoft,
five Dropbox, two Notion, five Todoist, one Telegram, six GitHub, and fifteen Google connector write
routes (the three LinkedIn search routes are reads, so none of them needs an entry). Until an
owner-approved live run verifies them, the repository lists them in a visible, time-bounded
allowlist (`scripts/emulator-evidence-pending.json`, which holds each entry's expiry date): the
check reports them as PENDING warnings until that date and fails again after it.

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

`@yolk-sdk/emulators` is MIT. The Fortnox, Microsoft, Dropbox, Notion, Todoist, Telegram, GitHub,
and Google emulators depend on (does not vendor or bundle) the Apache-2.0
[`@emulators/core`](https://github.com/vercel-labs/emulate) package, which ships no `NOTICE` file.
