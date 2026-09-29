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
Each exchange has a request (method, absolute URL, allowlisted headers, JSON body) and a response
that is either a whole `body` string or streamed `chunks` with the original network chunk
boundaries.

**Fixtures must contain synthetic or scrubbed data only.** Never commit credentials, cookies,
customer names, or real account identifiers. Run `scanFixtureForSecrets` (or build fixtures with
`makeWireFixture`, which fails on any finding) before committing. The scan flags credential
headers, bearer tokens, common API-key prefixes, JWTs, private keys, credential query parameters,
and credential JSON fields; it reports locations, never the secret itself. The scan is a safety
net, not a guarantee: review fixtures before publishing them.

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
  as `unmatched`.
- Streamed responses emit exactly one `Uint8Array` per recorded chunk, pulled lazily.
- `ReplayLedger` records every request: method, URL, headers with credentials redacted, body text
  and parsed JSON, attempt number per method + URL, how it was answered, and any fault tag.

Faults (`WireFault.*`) accept an optional `match: { method?, url? }`; `url` matches exactly after
normalization, or as a prefix when it ends with `*`:

| Fault                 | Effect                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `StatusOnAttempt`     | Answer attempt N with a status/headers/body instead of consuming the recording (500-then-success, 429 + retry). |
| `FailAfterChunks`     | Emit N chunks, then fail the body stream like a dropped connection under `FetchHttpClient`.                     |
| `TruncateAfterChunks` | Emit N chunks, then end the body cleanly (for example without a final event).                                   |
| `HoldAfterChunks`     | Emit N chunks, run `release`, then continue (observe progressive delivery).                                     |

Chunk faults apply to streamed responses and take an optional 1-based `attempt`.

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
`authorization`, `cookie`, and `set-cookie` are always dropped. `text/event-stream` responses are
teed chunk by chunk without changing what the caller receives. `drain` fails if a request failed or
a body was not read to the end.

Only record against accounts and data you are allowed to publish, and keep live recording out of CI.
