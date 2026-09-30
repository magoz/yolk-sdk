# Emulators Package

`@yolk-sdk/emulators` is an **experimental** package of emulators for outside services and the
Effect `HttpClient` routing that points code at them.

## Subpaths

| Subpath                       | Source                  | Role                                                                     |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------------ |
| `@yolk-sdk/emulators/router`  | `src/router.ts`         | `EmulatorRoute`, `EmulatedHttpClient.layer`, `InProcessHttpClient.layer` |
| `@yolk-sdk/emulators/gateway` | `src/gateway.ts`        | Vercel AI Gateway fetch-handler emulator and its route evidence manifest |
| `@yolk-sdk/emulators/node`    | `src/node.ts`           | `serveFetchHandler` / `startFetchHandlerServer` on `127.0.0.1`           |
| (internal)                    | `src/route-evidence.ts` | `EmulatorRouteEvidence` type and the evidence header name; re-exported   |

There is no root export or barrel.

## Boundaries

- Dependencies: `effect` only. `src` never imports `@yolk-sdk/*`, React, or Next
  (`scripts/check-package-boundaries.ts` enforces this). Tests may import `@yolk-sdk/agent` and
  `@yolk-sdk/conformance` (workspace devDependencies).
- `node:` builtins are allowed only in `src/node.ts` (also enforced).
- `router` is Effect code; `gateway` is a plain Web fetch handler (no Effect runtime needed, no
  Node builtins); `node` is the only Node boundary.
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
  (`127.0.0.0/8`, `::1`, `localhost`) without credentials, query, or hash.
- Wire shapes come from the recorded (currently synthetic) conformance fixtures, copied as data,
  never imported. Each emulated route lists the conformance case ids it follows in its manifest
  (`gatewayEmulatorRoutes`). Keep the manifest and the handler's route table in sync.
- Evidence policy: unknown routes fail closed (404 JSON, written to the ledger); unverified
  routes answer but carry `x-emulator-evidence: unverified`, are tagged in the ledger, and are
  listed by the evidence check; evidence older than 30 days warns; connector write routes need
  `verified` evidence (the check fails otherwise).
- Control-plane routes live under `/_emulate/*`. Control inputs (faults, turns) decode strictly
  (unknown keys rejected); the JS API throws `GatewayEmulatorInputInvalid` for invalid input.
- Emulator bodies are pull-driven (one chunk per pull) and the ledger counts chunks handed over;
  chunk faults that cannot take effect answer 500 and are not consumed, never a silent no-op.
- Credential headers are never recorded; the bearer value is never checked or stored.
- The Node server binds to `127.0.0.1` only, writes body chunks as they arrive (honoring
  backpressure), and destroys the socket when a body stream errors.
- Synthetic data only: model ids, texts, and hosts must be synthetic.

## Tests

`test/router.test.ts`, `test/gateway.test.ts`, `test/node.test.ts`, and
`test/gateway-conformance.test.ts` (the Gateway conformance cases in-process and over a loopback
socket, a disagreement drill, and faults through the real provider). Loopback sockets only; never
call real services.
