# Conformance Package

`@yolk-sdk/conformance` is an **experimental** Effect-only toolkit for wire fixtures: record real
HTTP exchanges, replay them offline (fail closed), and inject wire faults. It also defines
conformance cases (one wire claim each) and the runner that gates them by safety and reports.

## Subpaths

| Subpath                         | Source                 | Role                                                                           |
| ------------------------------- | ---------------------- | ------------------------------------------------------------------------------ |
| `@yolk-sdk/conformance/fixture` | `src/fixture.ts`       | Wire and port fixture schemas, decode, staleness, secret scans, port redaction |
| `@yolk-sdk/conformance/replay`  | `src/replay.ts`        | Replay `HttpClient` layer, `ReplayLedger`, `WireFault`                         |
| `@yolk-sdk/conformance/record`  | `src/record.ts`        | Recording wrapper over a host `HttpClient`, `WireRecorder`, `makeWireFixture`  |
| `@yolk-sdk/conformance/case`    | `src/case.ts`          | `ConformanceCase`, `defineConformanceCase`, safety, assertion helpers          |
| `@yolk-sdk/conformance/runner`  | `src/runner.ts`        | `runConformance`, safety policy, warnings, report + plain-text format          |
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
- `PortFixture` is the minimal non-HTTP fixture: one call through a host port (`id`, `port`,
  `method`, a credential-free JSON `request`, exactly one of `response` or `failure`
  (`expected` = value-level failure, `error` = typed error), optional `observed` and `note`). No
  `observed` means synthetic (`unverified`, no date); `observed.date` makes it `verified` and ages
  it. Record requests through `redactPortPayload` (drops `credential(s)` and every credential field
  name at any depth); `scanPortFixtureForSecrets` flags the token patterns, credential fields, and
  any non-null `credential(s)` field. Replaying port fixtures belongs to the port owner (for
  example the connectors email bridge), not this package. `WireFixture` and HTTP replay are
  unchanged.
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

## Cases and runner

- A case is a pure Effect program proving one wire claim; it names only its requirements so the
  same case runs against replay, in-process/local emulators, or a live practice account. Case
  metadata (`id`, `safety`, `docs`, `wire`, `observed`, `fixtures`) is plain data.
- `defineConformanceCase` throws `ConformanceCaseInvalid` for invalid metadata (programmer error at
  module load, like `makeTool`); ids are dotted lower-case.
- `ConformanceMismatch` is model-free: `message` plus optional JSON `expected` / `actual`.
  `expectEqual` takes JSON values and compares with `Equal.equals`.
- Safety policy (`conformanceSkipReason`) is the core rule and is unit-tested per cell: non-live
  targets run everything; live runs `read`, runs `write-reversible` only with
  `allowWrites: 'reversible'` (else `writes-not-allowed`), and runs `write-irreversible` only for
  exact ids in `allowIrreversible` (else `manual-only`), independent of `allowWrites`. Never weaken
  a live default: `allowWrites` defaults to `none`.
- Skipped cases never build their layer. Running cases call `options.layer(case)` inside the
  per-case exit boundary (`Effect.suspend`) and build it with a fresh memo map
  (`Effect.provide(layer, { local: true })`), so state allocated at build time never leaks between
  cases. Services captured in a shared `Layer.succeed` value or provided by the caller's
  environment stay shared; document that limit wherever isolation is promised.
- Each case runs under `Effect.exit`; failures, layer build failures, throwing layer factories,
  and defects become `failed` results. Interrupt-only causes re-interrupt the run instead of
  becoming results.
- Reports carry only an identifier-like, non-credential-shaped error `_tag` and a message.
  `ConformanceMismatch` messages keep the case-authored text with credential patterns redacted;
  every other message is sanitized best-effort by `sanitizeConformanceMessage` (credential patterns
  and credential header lines redacted, JSON spans elided, whitespace collapsed, capped at 300).
  Hosts should still keep secrets out of error messages. Never copy request bodies, headers, or
  mismatch details into reports.
- Credential patterns live once in `wire-internal.ts`; the fixture secret scan and the report
  sanitizer both use them. Change them there, never in a copy.
- The runner's `fixtures` accept `WireFixture`s and `PortFixture`s (`ConformanceFixture`); both use
  `conformanceFixtureEvidence` for the unverified/stale warnings.
- Live targets omit all fixture-level warnings (`unverified-fixture`, `stale-fixture`,
  `missing-fixture`) because fixtures are not used live; elsewhere they need supplied fixtures.
  Case warnings (`unverified-case`, `stale-observation`) always apply. `formatConformanceReport`
  output is plain text without ANSI colors.
- `runConformance` has a public overload inferring the case union `C` (layer must provide
  `ConformanceCaseRequirements<C>`) over a single-`<E, R>` implementation signature; keep them in
  sync.

## Tests

`test/fixture.test.ts`, `test/port-fixture.test.ts`, `test/replay.test.ts`, `test/record.test.ts`,
`test/case.test.ts`, `test/runner.test.ts`. Use synthetic hosts such as
`api.example.test`; never call real services.
