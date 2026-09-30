# @yolk-sdk/emulators

> **EXPERIMENTAL.** This package is new and its API may change in any canary release, beyond the
> usual canary instability.

Emulators for outside services, for tests and local development. A route table sends an Effect
`HttpClient` to an emulator instead of the real service. Two emulators speak the OpenAI-compatible
Chat Completions wire: the Vercel AI Gateway and OpenAI itself. Emulators never import other `@yolk-sdk/*` code:
their wire shapes follow recorded conformance fixtures, and each emulated route names the
conformance cases behind it.

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Install

```bash
pnpm add -D @yolk-sdk/emulators@canary effect@4.0.0-rc.115
```

## Subpaths

There is no root export. Import an explicit subpath:

| Subpath                       | Purpose                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@yolk-sdk/emulators/router`  | `EmulatorRoute`, `EmulatedHttpClient.layer`, `InProcessHttpClient.layer` (Effect; no Node builtins)         |
| `@yolk-sdk/emulators/gateway` | `makeGatewayEmulator`, `gatewayEmulatorRoutes`, fault and scripted-turn schemas (plain fetch handler)       |
| `@yolk-sdk/emulators/openai`  | `makeOpenAiEmulator`, `openAiEmulatorRoutes`, fault and scripted-turn schemas (plain fetch handler)         |
| `@yolk-sdk/emulators/node`    | `serveFetchHandler` (scoped Effect) and `startFetchHandlerServer` (Promise): serve a handler on `127.0.0.1` |

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
`POST /v1/chat/completions`. Each call has its own state.

Defaults (no script):

- `knownModels` defaults to a small synthetic-safe list including `openai/gpt-4.1-nano` and
  `deepseek/deepseek-v3.2`; `reasoningModels` defaults to the DeepSeek id.
- `stream: true` streams `chat.completion.chunk` server-sent events: several text deltas, a finish
  chunk, a usage chunk when `stream_options.include_usage` is set, and `data: [DONE]`.
  `stream: false` returns one `chat.completion` JSON body.
- A reasoning model asked for reasoning (`reasoning_effort`, or `thinking: { type: 'enabled' }`)
  streams `delta.reasoning_content` before the text.
- A request with `tools` gets one tool call whose arguments are synthesized from the tool's JSON
  Schema (required string properties get non-empty synthetic values), streamed as several
  `delta.tool_calls[].function.arguments` fragments, finishing with `tool_calls`.
- An unknown model gets the Gateway error envelope `{ error: { message, type, code } }` with
  status 400 and code `model_not_found`.
- A missing `Authorization: Bearer <non-empty>` header gets a 401 envelope. The token is never
  checked or stored.
- Unknown routes get a 404 JSON error (fail closed) and are written to the ledger.

`script.enqueue(turn)` queues a turn for the next chat request, sent exactly as given:

- a completion: `{ text?, reasoning?, reasoningField?, order?, toolCalls?, usage?, finishReason? }`
  where each tool call is `{ name, argumentFragments }`, `usage: null` drops the usage chunk, and
  `order: 'text-first'` sends reasoning after the text;
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

A chunk fault that cannot take effect answers 500 instead of silently doing nothing. If the
emulator cannot build a planned response, it answers an evidence-tagged 500, the ledger records
500 with `responseError`, and the matching fault is not used up.

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
`https://api.openai.com`. It shares the Gateway emulator's Chat Completions core, so framing,
tool-call fragments, JSON mode, faults, scripted turns, the ledger, and the control plane behave
the same. What differs:

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

## Evidence

`gatewayEmulatorRoutes` and `openAiEmulatorRoutes` list every emulated route with `method`, `path`,
`kind`, `write`, the conformance `caseIds` it follows, `evidence` (`verified` or `unverified`), and
`observedAt`. Every response from an unverified route carries `x-emulator-evidence: unverified`.
Each manifest route maps to its own handler; an emulator whose manifest has a route without a
handler throws when it is constructed. The Yolk repository checks these manifests: unknown case ids,
duplicate routes, connector write routes without verified evidence, verified connector write routes
whose `observedAt` is missing, unreadable, or in the future, and verified routes whose cited cases
have no verified fixture fail, as do verified connector write routes citing no cases; unverified or
stale (over 30 days) evidence and other routes citing no cases warn.

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
