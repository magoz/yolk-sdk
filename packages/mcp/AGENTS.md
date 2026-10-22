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
- Server `handleHttpRequest` lets no tool call outlive its Effect: tools run with the caller's context, whose scope (a host's request layer) closes on return, and the SDK fills SSE answers after returning the `Response` (always for 2025-era requests; for `2026-07-28` once a handler sends a related message). So an SSE answer is read to its end and re-answered with the same status, headers and events (a read failure answers 500 `-32603`), and tool calls run as fibers of a request-scoped `FiberSet` that interrupts and awaits any still running (a cancelled call's finalizers) before return. Only `subscriptions/listen` is returned unread: it runs no tool, and its stream ends only when the per-request handler closes, so it answers the acknowledgement plus `complete`. It is identified by `Mcp-Method` plus the SDK's own era routing (`isLegacyRequest` on a body clone, only when that header claims listen): the SDK checks `Mcp-Method` against the body only on requests it routes as modern, and a 2025-era request may carry any. Only the SDK branch is scoped; the header-less JSON path keeps the caller's scope. Tool Effects run with the SDK's `ctx.mcpReq.signal`, so cancelling an SDK-routed request (on Streamable HTTP, a closed response stream) interrupts the tool; the header-less JSON path runs tools inside the caller's Effect, whose interruption the host owns. Tests: `test/server/server.test.ts` (scoped resource incl. a 2025-era request claiming listen, cancellation finalizers in both eras, listen, 202 notification).
- Server stdio runner uses Effect `Stdio`; hosts provide the platform layer.
- Preserve discovered MCP `title`, input/output schemas, and annotations when adapting tools.
- `mcpToolToToolDef` passes a present plain-JSON-object `outputSchema` through as declaration-only `ToolDef.outputSchema` (never sent to providers) and omits any other value instead of failing the listing. Exposure is host policy: it sets `callableBy`/`discovery`/`loading` only from its `exposure` option (`McpToolExposureResolver`: a `ToolExposure` value or `(tool, serverName) => ToolExposure`), which the listing functions take as `McpClientOptions.exposure`; without it none is set. `resolveTools` keeps the fail-closed rules. Tests: `test/client/tool-exposure.test.ts`.
- Preserve MCP `structuredContent`, `isError`, and supported content blocks when adapting tool results.
- Form elicitation (MRTR, `src/client/elicitation.ts`) is host-owned and durable: never a blocking
  callback. `McpClientOptions.elicitation` is the only opt-in; it is declared as per-request `_meta`
  client capabilities on modern connections only (merged over `sdk.capabilities`; capabilities a
  `configureClient` registers are not merged), never in a legacy `initialize`, and never by
  `callRemoteMcpServerTool`. `callRemoteMcpServerToolResumable` answers `McpToolCallOutcome`
  (`Complete` | `InputRequired`). The pause (`McpInputRequired`) carries its binding
  (`mcpToolName`, `argumentsDigest` over canonical JSON) and the listed tool definition;
  `resumeRemoteMcpServerToolCall` refuses another tool or other arguments (`mismatched_resume`),
  lists nothing, and is re-sent as a new request on a new connection (distinct JSON-RPC ids are
  not promised). The SDK's `callTool` rejects an `input_required` answer for a tool with an
  `outputSchema` (it validates the pause as output, from `toolDefinition` or its response cache,
  which a host `responseCacheStore` keeps across connections), so every resumable call passes
  `toolDefinition` without `outputSchema` (the listed or paused definition, else a minimal one, so
  the cache is never read), compiles the output schema before calling, and validates complete
  results itself (`assertStructuredOutput`); a carried definition that is not a valid tool fails
  `malformed` (never a silent minimal fallback), and with `toolDefinition` set the SDK makes no
  `HEADER_MISMATCH` re-list-and-retry. The carried definition is `name`, `inputSchema` and
  `outputSchema` only: the fields the pinned SDK reads from `toolDefinition` (it removes
  `execution` from 2026 listings and has no task runtime). `maxInputRequiredBytes` is validated
  before connecting and bounds two parts separately: the server-provided pause (after the body is
  buffered, without the tool definition) and the listed definition (before the call, so an
  oversized definition fails `too_large` with nothing sent). The pause is decoded from the raw `input_required` response, captured by wrapping the transport's `send` (to learn the `tools/call` JSON-RPC id) and `onmessage` after connect, restored afterwards (`captureCallResponse`): only this invocation's first `tools/call` id is tracked, and the response kept is the first whose id matches under the SDK's `Number(id)` coercion (the one `_onresponse` resolves with); a matched id that is not identical to the sent one fails `malformed`, because the SDK's codec drops a non-string `requestState` and turns non-object `inputRequests` into `{}`; a malformed raw envelope, or none with the id, fails `malformed`. Format checks are linear syntax validators (RFC 3339 with offset-aware leap seconds, RFC 3986 absolute URI with the `IPv6address` grammar, pragmatic dot-atom mailbox), never `URL`/`Date.UTC` parsing. Accepted content is checked against the whole 2026-07-28 form-schema subset (see `toMcpInputResponses`).
  Form mode only; legacy server-initiated elicitation is unsupported (`McpInputRequiredError`
  `unsupported_era`). Tests: `test/client/elicitation.test.ts`.
- Server maps protocol documents to MCP resource blocks with encoded `file:///...` URIs.
- Export normal tool results/content; agent loop/providers stay MCP-agnostic.

## Conformance cases

- `src/conformance/` owns the generic MCP cases (`mcpConformanceCases`, nine `read` cases; plus
  the opt-in `mcpElicitationDeclarationCase` and its `mcpConformanceElicitationFixtures`, kept out
  of the default suite, the emulator copies and the provider fixtures because the declaration is a
  host opt-in),
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
  `elicitation-declaration.test.ts` replays the opt-in elicitation case on both eras (exact
  requests), drills a rejected listing, and runs it in-process.
