# MCP Package

`@yolk-sdk/mcp` is the top-level package for Model Context Protocol client/server APIs.

## Subpaths

| Subpath                     | Source                   | Role                                                       |
| --------------------------- | ------------------------ | ---------------------------------------------------------- |
| `@yolk-sdk/mcp/client`      | `src/client`             | Official full-core client plus Effect/Yolk tool adapters   |
| `@yolk-sdk/mcp/client/node` | `src/client/node.ts`     | Official stdio transport plus NodeServices wrappers        |
| `@yolk-sdk/mcp/conformance` | `src/conformance`        | Experimental MCP conformance cases, target, and fixtures   |
| `@yolk-sdk/mcp/core`        | `src/core.ts`            | Official MCP v2 wire schemas                               |
| `@yolk-sdk/mcp/protocol`    | `src/client/protocol.ts` | Yolk JSON-RPC/MCP adapter helpers                          |
| `@yolk-sdk/mcp/server`      | `src/server`             | Official full-core server plus Yolk tool-server primitives |
| `@yolk-sdk/mcp/server/node` | `src/server/node.ts`     | Official dual-era stdio server entrypoint                  |

## Boundaries

- MCP is external protocol infrastructure, not agent-core.
- App auth, persisted config, credential storage, policy, and product catalogs stay outside this package. Generic MCP OAuth protocol helpers may be re-exported from the official SDK.
- Keep NodeServices convenience wrappers behind `@yolk-sdk/mcp/client/node`; local client core stays in `@yolk-sdk/mcp/client`.
- Client/server may use `@yolk-sdk/agent/protocol` for generic tool/content adapters; agent loop/providers remain MCP-agnostic.
- Package architecture constraints live in `patterns/PACKAGE_ARCHITECTURE.md`.

## Client/server rules

- Effect/Yolk remote tool helpers use the official MCP v2 client over an Effect `HttpClient` fetch bridge; tests inject fake clients and apps provide runtime layers.
- Official `Client` defaults remain unchanged; callers must select `versionNegotiation: { mode: 'auto' }` or pin `2026-07-28` to use the modern protocol.
- Full-core server HTTP uses `createMcpHandler`; modern stdio uses `serveStdio` from the Node subpath. Both preserve legacy serving unless explicitly rejected.
- Remote MCP requires `https:` by default; `http://localhost` is dev-policy gated.
- Local stdio client core uses Effect platform process/stream APIs, not raw `node:child_process`; Node wrappers only provide `NodeServices.layer`.
- Local stdio receives explicit env only, uses `extendEnv: false`, ignores stderr, validates `initialize`, and matches responses by JSON-RPC id.
- Decode wire JSON in two steps: JSON string → unknown (`Schema.fromJsonString(Schema.Unknown)`) → protocol schema.
- Server `handleHttpRequest` maps JSON parse errors to `-32700`; invalid JSON-RPC/request params to `-32600`.
- Server stdio runner uses Effect `Stdio`; hosts provide the platform layer.
- Preserve discovered MCP `title`, input/output schemas, and annotations when adapting tools.
- `mcpToolToToolDef` passes a present plain-JSON-object `outputSchema` through as declaration-only `ToolDef.outputSchema` (never sent to providers) and omits any other value instead of failing the listing. It never sets `callableBy`; exposure is host policy.
- Preserve MCP `structuredContent`, `isError`, and supported content blocks when adapting tool results.
- Server maps protocol documents to MCP resource blocks with encoded `file:///...` URIs.
- Export normal tool results/content; agent loop/providers stay MCP-agnostic.

## Conformance cases

- `src/conformance/` owns the generic MCP cases (`mcpConformanceCases`, nine `read` cases),
  `McpConformanceTarget`, `McpConformanceConfig`, the observing `HttpClient`, the era filter
  (`selectMcpConformanceCases`), and the synthetic fixtures. Only this directory may import
  `@yolk-sdk/conformance/*` (`scripts/check-package-boundaries.ts`); client and server code never
  do.
- Cases run the REAL client operations (`listRemoteMcpServerTools`, `callRemoteMcpServerTool`) and
  observe the wire through `makeMcpObservingHttpClient`. Its guarantees are exactly these, and
  nothing more:
  - it never keeps `authorization` or any other credential-named header (allowlisted MCP headers
    only);
  - it never keeps the URL query or fragment (origin and path only);
  - it never keeps a raw `mcp-session-id` header value (only `McpObservedSession` evidence: an
    equality class such as `session#1`, through a SHA-256 digest, and whether it is visible ASCII);
  - request and response bodies are kept exactly as received. They may reflect anything a server
    echoes, credentials and session ids included: sensitive, in memory only, never logged or
    persisted. There is no body, URL-path or header-value redaction (it corrupted evidence);
    persisted or printed output is the live runner's job (its redacting IO and staging guards).
    It never sends a request of its own; with a `callGate` it may refuse to forward a `tools/call`.
    Never add a case-side request or a product name; provider targets and seeds live with the
    provider.
- Mismatch messages and `expected`/`actual` details carry only structural facts (methods,
  statuses, counts, positions such as `page 2 tool 1`, codes, enums, host-supplied seeds), never
  response body text or the target URL. A client failure a case re-raises is reported as the
  client words it (an `McpError` message can quote a server body); the runner sanitizes it
  (`sanitizeConformanceMessage`).
- `mcp.modern.*` and `mcp.legacy.*` ids apply to one era (`mcpConformanceCaseEra`); other ids
  apply to both. Era-specific cases also refuse the other era with a `precondition:` mismatch.
- Call safety is a FAIL-CLOSED ALLOWLIST (`call-gate.ts`), never a blocklist. The four calling
  cases run `callRemoteMcpServerTool` through an observer with a `callGate` (`absent` for
  `mcp.modern.stateless` and `mcp.errors.unknown-tool`, `read-only` for the two call cases). The
  `tools/call` is forwarded ONLY when every exchange of that operation is fully understood, the
  operation's own listing is complete (every page answered and parsed, the last without
  `nextCursor`), and that listing proves the call safe. Uncertainty refuses: a 202 answer to a
  request, a message on a GET, an unparseable body, an unterminated stream, two responses for one
  id, an unknown shape, or an era probe whose 2xx answer holds anything but its own response,
  notifications and error responses (after the probe window closes, the rest of the probe stream
  reaches the client's protocol `onmessage`). A refusal is answered locally with a transport
  failure and recorded with its `refused` reason. A refusal before any forwarded `tools/call`
  fails the precondition with zero forwarded calls (drills assert this); a refused client retry
  after a forwarded call (a `HeaderMismatch` retry or an input-required re-send) is reported as
  such, never as zero forwarded calls. Preflight listings
  (`requireReadOnlyTool`, `requireAbsent` over every answer carrying `result.tools`) are only
  friendly early failures; safety comes from the gate. Never weaken the gate into a blocklist.
- Fixtures are synthetic only (`https://mcp.example.test/{modern,legacy}/mcp`, session ids
  `yolk-synthetic-session-NNNN`). They keep the exchange order and the exact JSON-RPC ids and
  `_meta` envelope of the pinned SDK, and they never record `authorization`. The auth case sends
  the public reserved invalid credential (`Bearer yolk-conformance-invalid-credential-0000`). A
  pinned SDK upgrade that changes ids, headers or order shows up in the replay request-equality
  test. The sixteen fixtures are copied as data into `packages/emulators/src/mcp/recordings.ts`
  (the `@yolk-sdk/emulators/mcp` emulator); `packages/emulators/test/mcp.test.ts` fails when the
  copy drifts, so a fixture change updates that copy in the same change.
- Real-code facts the cases pin (pinned `@modelcontextprotocol/client` 2.0.0; trust the SDK source
  over the design and keep the `cases.ts` header in sync):
  - `listTools(undefined)` follows `nextCursor` (stopping silently on a repeated cursor), lists
    nothing without `capabilities.tools`, and on modern connections drops tools with an invalid
    `x-mcp-header`. Listed and resolved tools must correspond one to one.
  - The tool schema keeps only the five annotation keys and keeps `outputSchema` as received; the
    legacy schema rejects a listing whose `inputSchema` or `outputSchema` root is not
    `type: "object"` (SDK servers wrap non-object output roots for legacy clients).
  - Auto era negotiation: a discover result invalid for the client's loose discover dispatch
    schema (checked with core's exported `DiscoverResultSchema`, see `isValidDiscoverResult`; it
    ignores `resultType` and catches a bad `ttlMs` or `cacheScope`) or without `2026-07-28` falls
    back to legacy; `-32022` listing `2026-07-28` retries once; `-32022` listing only other
    modern versions is fatal; other JSON-RPC errors and other 4xx fall back; 401, 403 and 5xx
    abort.
  - SSE: the cases and the gate never mirror the SSE grammar by hand. They use the same
    `eventsource-parser` the client resolves: a direct dependency declared with the client's own
    range (`^3.0.0`), so a package manager resolves one copy; in this repository a parity test in
    `gate.test.ts` verifies the two resolve the same copy (3.0.8). Residual: a consumer whose
    package manager does not dedupe could install two copies, which the parity test cannot see.
    `makeEffectFetch` buffers the whole body, so `TextDecoderStream` gets one byte chunk and emits
    up to two text chunks: the streaming decode, and at flush the decode of an incomplete trailing
    UTF-8 sequence (U+FFFD). Each is a separate parser `feed`. The observer keeps those chunks
    (`responseFeeds`) and `sse.ts` feeds them one by one, with no parser flush, as the client
    does (a parity test compares with the real `TextDecoderStream` + `EventSourceParserStream`
    pipeline). Parser facts the client relies on: the first feed drops the literal characters
    `ï»¿` (char codes 239, 187, 191; a real BOM is already removed by the decoder); a CR at the
    end of a feed stays pending, so the flush chunk (U+FFFD, no line break) never ends that line;
    an unterminated final event is never dispatched (no flush). `_handleSseStream` then reads only events with non-empty
    data and no `event:` or `event: message` (priming and other events are skipped);
    notifications after the response are harmless; an SSE answer that never ends fails only at
    `timeoutMs`.
  - Parsing: the SDK reads answers with `JSON.parse` (`1e400` is `Infinity`, accepted in loose
    positions); the cases and the observer read them the same way (`json.ts`).
  - Delivery: a request is resolved from any stream, its POST answer or a message on the standing
    GET (after a 202, or a SEP-1699 `last-event-id` resumption after a priming event and a closed
    POST stream). The cases do not accept GET delivery (unverified in their wire texts); the call
    gate treats it as uncertainty.
  - `callTool` sends a call for any name and enforces no annotation, and
    `callRemoteMcpServerTool` lists again on its own connection right before calling: only that
    listing can prove a call safe.
  - `mcp-name` is `encodeMcpParamValue(name)` (internal `param-value.ts`): the name unchanged when
    it is a safe plain-ASCII field value, else `=?base64?<base64 of UTF-8>?=` for an empty name, a
    character outside 0x20 to 0x7E other than tab (non-ASCII), leading or trailing whitespace
    (padded), or a value already shaped like the sentinel.

## Tests

- Client transport/protocol tests live under `test/client`.
- Server protocol tests and stdio fixtures live under `test/server`.
- Conformance tests live under `test/conformance`. `replay.test.ts` covers every case through the
  real client, request equality with the fixtures, and the SSE truncate fault. `drills.test.ts`
  holds the disagreement drills (at least one per case) and passing variants of real SDK behaviour
  (legacy fallbacks, the corrective probe retry, priming and non-message SSE events, an encoded
  `mcp-name`, stripped annotation keys) and header values that collide with wire values.
  `gate.test.ts` holds the call-gate refusals (standing-GET delivery, priming then GET replay, a
  `1e400` listing, an incomplete listing, a `readOnlyHint` downgrade or removal, a `ï»¿`-prefixed
  unsafe listing followed by a safe one for both gate kinds, a probe stream carrying a
  `tools/list`-shaped tail), each with zero forwarded calls; the refused `HeaderMismatch` retry
  (one forwarded call, reported as a retry); the `JSON.parse`, dispatch-schema and terminal-CR
  edge cases; the `eventsource-parser` copy parity test; the decoder-and-parser parity with the
  real pipeline; and the decoder-flush regressions through the real client.
  `observer.test.ts` covers the header allowlist, session evidence and bodies kept as received.
  `in-process.test.ts` runs the cases against `makeMcpToolServer` and states which cases do not
  apply.
