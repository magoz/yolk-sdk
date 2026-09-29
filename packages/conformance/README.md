# @yolk-sdk/conformance

> **EXPERIMENTAL.** This package is new and its API may change in any canary release, beyond the
> usual canary instability.

A small Effect-only toolkit for recording real HTTP exchanges with outside services, replaying them
in tests (offline, fail closed), and injecting wire faults such as mid-stream drops, truncation,
and rate-limit responses.

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Install

```bash
pnpm add -D @yolk-sdk/conformance@canary effect@4.0.0-rc.115
```

## Subpaths

There is no root export. Import an explicit subpath:

| Subpath                         | Purpose                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `@yolk-sdk/conformance/fixture` | `WireFixture` / `WireExchange` schemas and types, `decodeWireFixture`, staleness helpers, `scanFixtureForSecrets` |
| `@yolk-sdk/conformance/replay`  | `ReplayHttpClient.layer`, `makeReplayHttpClient`, `ReplayLedger`, `WireFault`                                     |
| `@yolk-sdk/conformance/record`  | `WireRecorder.layer`, `makeRecordingHttpClient`, `makeWireFixture`                                                |

## Fixtures

A `WireFixture` is plain data: an id, a `caseId`, `evidence` (`verified` for a live recording,
`unverified` for a synthetic placeholder), a `recordedAt` date (`YYYY-MM-DD`), a synthetic
`account` label, the `endpoint`, optional `model` / `note`, and a non-empty list of exchanges.
Each exchange has a request (method, absolute URL, allowlisted headers, JSON or text body) and a
response recorded losslessly in exactly one of three shapes:

- `body`: the whole body as a string, when it is valid UTF-8.
- `bodyBase64`: the whole body's exact bytes in base64, for anything else (for example a PDF).
- `chunks`: streamed network chunks with their original boundaries. Each entry is a string when
  that chunk is valid UTF-8 on its own (empty chunks are `""`), or `{ base64 }` holding its exact
  bytes (for example half of a multi-byte character). Plain strings stay the common, readable case.

**Fixtures must contain synthetic or scrubbed data only.** Never commit credentials, cookies,
customer names, or real account identifiers. Run `scanFixtureForSecrets` (or build fixtures with
`makeWireFixture`, which fails on any finding) before committing. The scan flags credential
headers (including `x-*-token` / `x-*-key` style names), bearer tokens, common API-key prefixes,
JWTs, private keys, credential query and form parameters, and non-empty string credential JSON
fields (`access_token`, `client_secret`, `password`, `api_key`, `token`, ...; numeric usage
counters such as `max_tokens` are not flagged). It covers metadata strings, URLs, headers, request
bodies, response bodies (including decodable `bodyBase64` text), each chunk, and the reassembled
stream, so a secret split across chunks is still found; JSON bodies and SSE `data:` payloads get
the credential-field scan. It reports locations, never the secret itself. The scan is a safety net,
not a guarantee: review fixtures before publishing them.

`fixtureAgeDays(fixture, now)` and `isFixtureStale(fixture, now, maxAgeDays = 30)` help hosts
decide when a recording should be refreshed.

## Replay

```ts
import { Effect } from 'effect'
import { HttpClient } from 'effect/unstable/http'
import { ReplayHttpClient, ReplayLedger, WireFault } from '@yolk-sdk/conformance/replay'

const program = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient
  // ... run the code under test against `client` ...
  const entries = yield* (yield* ReplayLedger).entries
  return entries
}).pipe(
  Effect.provide(
    ReplayHttpClient.layer([myFixture], {
      faults: [WireFault.StatusOnAttempt({ attempt: 1, status: 500 })]
    })
  )
)
```

- Requests match by method and normalized absolute URL (hash removed, query parameters sorted).
- Each recorded exchange is consumed once, in recorded order among exchanges with the same method
  and URL, so create → update → read-back flows and repeated requests replay deterministically.
- A request with no remaining match fails closed with an `HttpClientError` (`TransportError`)
  whose message names the method and URL, never headers or body. It is still written to the ledger
  as `unmatched`. Faults never answer such requests.
- Replay emits exactly the recorded bytes: one `Uint8Array` per recorded chunk (including empty
  ones), each produced only when the consumer pulls it; `bodyBase64` replays as the original bytes.
- `ReplayLedger.entries` records every request: method, URL, headers with credentials redacted,
  body text and parsed JSON, attempt number per method + URL, how it was answered (`matched`,
  `injected`, `unmatched`, or `invalid`), and the tag of any fault that applied.
  `ReplayLedger.remaining` lists recorded exchanges not consumed yet.

Faults (`WireFault.*`) accept an optional `match: { method?, url? }`; `url` matches exactly after
normalization, or as a prefix when it ends with `*`:

| Fault                 | Effect                                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StatusOnAttempt`     | Answer attempt N with a status/headers/body instead of consuming the recording (500-then-success, 429 + retry). Fires only when an unconsumed recorded exchange exists for the method + URL. |
| `FailAfterChunks`     | Emit N chunks, then fail the body stream like a dropped connection under `FetchHttpClient`.                                                                                                  |
| `TruncateAfterChunks` | Emit N chunks, then end the body cleanly (for example without a final event).                                                                                                                |
| `HoldAfterChunks`     | Emit N chunks, run `release`, then continue (observe progressive delivery).                                                                                                                  |

Chunk faults take an optional 1-based `attempt`. A chunk fault that cannot take effect fails the
request with an `HttpClientError` whose cause is `WireReplayInvalid` (ledger outcome `invalid`, no
fault tag, exchange left unconsumed) instead of silently doing nothing: any chunk fault matched
against a whole-body response, `TruncateAfterChunks` / `HoldAfterChunks` with `chunks` at or beyond
the recorded chunk count, or `FailAfterChunks` with `chunks` beyond it.

## Record

This package **never performs network I/O itself**. For live recording, the host supplies the real
`HttpClient` and the recorder wraps it:

```ts
import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { makeWireFixture, WireRecorder } from '@yolk-sdk/conformance/record'

const recording = WireRecorder.layer().pipe(Layer.provide(FetchHttpClient.layer))

const fixture = Effect.gen(function* () {
  // ... run the real client code once ...
  const exchanges = yield* (yield* WireRecorder).drain
  return yield* makeWireFixture({
    id: 'example.case',
    caseId: 'example.case',
    evidence: 'verified',
    recordedAt: '2026-01-01',
    account: 'synthetic',
    endpoint: 'https://api.example.test/v1/chat',
    exchanges
  })
})
```

The recorder keeps only allowlisted headers (request: `content-type`, `accept`; response:
`content-type`, `retry-after`, `retry-after-ms`, and rate-limit headers). Credential headers such as
`authorization`, `cookie`, `set-cookie`, and token/key-bearing names such as `x-auth-token`,
`private-token`, or `x-*-key` are always dropped. `text/event-stream` responses are teed chunk by
chunk without changing what the caller receives; each network chunk is recorded standalone (text
when valid UTF-8, otherwise `{ base64 }`). Other bodies are recorded as `body` or `bodyBase64`.
`drain` fails with `WireRecordingIncomplete` if a request failed or a body was not read to the end.
A request still pending at `drain` time is reported by that drain and then dropped: if it finishes
later, it never appears in, or overwrites an entry of, a later drain.

Only record against accounts and data you are allowed to publish, and keep live recording out of CI.
