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
- Consumers: `@yolk-sdk/agent` may import this package only under `src/providers/*/conformance`;
  `@yolk-sdk/connectors` only under `src/**/conformance`.

## Design rules

- Fixtures are synthetic or scrubbed data only. Never commit credentials, cookies, customer names,
  real account identifiers, or links to private resources. `makeWireFixture` must fail on any
  secret-scan issue; scan results name locations, never secret values.
- Replay matching is method + normalized absolute URL (hash removed, sorted query). Exchanges are
  consumed once, in recorded order per key. Unknown requests fail closed with a typed
  `HttpClientError` naming method + URL only, and are still written to the ledger.
- Streamed responses preserve recorded chunk boundaries: one `Uint8Array` per chunk, lazily pulled.
- `FailAfterChunks` fails the body the way `FetchHttpClient` reports a dropped connection
  (`HttpClientError` with a `DecodeError` reason whose cause is `WireTransportFault`).
- Recorder allowlists headers and always drops credential headers; the caller must receive the
  same status, headers, and bytes as the upstream response.
- Ledger headers redact credential header values.

## Tests

`test/fixture.test.ts`, `test/replay.test.ts`, `test/record.test.ts`. Use synthetic hosts such as
`api.example.test`; never call real services.
