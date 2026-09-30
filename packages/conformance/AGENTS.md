# Conformance Package

`@yolk-sdk/conformance` is an **experimental** Effect-only toolkit for wire fixtures: record real
HTTP exchanges, replay them offline (fail closed), and inject wire faults. Conformance case
definitions and runners are not part of this package yet.

## Subpaths

| Subpath                         | Source                 | Role                                                                           |
| ------------------------------- | ---------------------- | ------------------------------------------------------------------------------ |
| `@yolk-sdk/conformance/fixture` | `src/fixture.ts`       | Fixture/exchange schemas and types, decode, staleness, `scanFixtureForSecrets` |
| `@yolk-sdk/conformance/replay`  | `src/replay.ts`        | Replay `HttpClient` layer, `ReplayLedger`, `WireFault`                         |
| `@yolk-sdk/conformance/record`  | `src/record.ts`        | Recording wrapper over a host `HttpClient`, `WireRecorder`, `makeWireFixture`  |
| (internal)                      | `src/wire-internal.ts` | Shared header/URL/body helpers; not exported                                   |

There is no root export or barrel.

## Boundaries

- Dependencies: `effect` only. No `@yolk-sdk/*`, `node:` builtins, React, or Next
  (`scripts/check-package-boundaries.ts` enforces this).
- Never construct a network client or perform network I/O. Recording wraps an `HttpClient` the host
  provides; replay is fully offline.
- Runtime-portable Web APIs only (`Response`, `ReadableStream`, `TextEncoder`/`TextDecoder`, `URL`).
- Effect-native: no try/catch, no raw `JSON.parse` (use `Schema.fromJsonString`), no `process.env`,
  no top-level side effects.
- Consumers: see the conformance import rule in `patterns/PACKAGE_ARCHITECTURE.md` (Dependency
  Direction).

## Design rules

- Fixtures are synthetic or scrubbed data only. Never commit credentials, cookies, customer names,
  real account identifiers, or links to private resources. `makeWireFixture` must fail on any
  secret-scan issue; scan results name locations, never secret values. The scan covers metadata,
  URLs, headers, request/response bodies (JSON field scan and form-parameter scan), each chunk, and
  the reassembled stream (JSON field scan per SSE `data:` payload). Credential field names are
  singular; plural/numeric usage fields such as `max_tokens` must stay unflagged.
- Recording is lossless: `body` (valid UTF-8) or `bodyBase64`; stream `chunks` entries are strings
  when valid UTF-8 on their own (empty chunks `""`), else `{ base64 }`. Decode each chunk standalone
  with a fatal decoder; never carry decoder state across chunks.
- Replay matching is method + normalized absolute URL (hash removed, sorted query). Exchanges are
  consumed once, in recorded order per key. Unknown requests fail closed with a typed
  `HttpClientError` naming method + URL only, and are still written to the ledger. Faults never
  answer unknown or exhausted requests (`StatusOnAttempt` needs an unconsumed matching exchange).
- Streamed responses replay the exact recorded bytes: one `Uint8Array` per chunk (including empty
  ones), each produced only on pull.
- Chunk faults that cannot take effect fail the request (`WireReplayInvalid` cause, ledger outcome
  `invalid`, no fault tag); never a silent no-op. The reason is a `TransportError`, so retrying
  clients may retry past it; tests through retrying clients assert no `invalid` ledger outcome.
- `HoldAfterChunks` keeps the release fiber and interrupts it when the body is cancelled.
- SSE scanning normalizes CRLF and bare CR line endings before splitting events.
- `FailAfterChunks` fails the body the way `FetchHttpClient` reports a dropped connection
  (`HttpClientError` with a `DecodeError` reason whose cause is `WireTransportFault`).
- Recorder allowlists headers and always drops credential headers; the caller must receive the
  same status, headers, and bytes as the upstream response. `isCredentialHeaderName` (in
  `wire-internal.ts`) is the single list for the scan, recorder drops, and ledger redaction.
- Recorder entries use monotonic ids: a request pending at `drain` is reported there and later
  completion is dropped, never settling another entry.
- Ledger headers redact credential header values.

## Tests

`test/fixture.test.ts`, `test/replay.test.ts`, `test/record.test.ts`. Use synthetic hosts such as
`api.example.test`; never call real services.
