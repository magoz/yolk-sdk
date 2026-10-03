/**
 * MCP conformance cases for `@yolk-sdk/conformance/runner`.
 *
 * Each case checks one wire claim `@yolk-sdk/mcp/client` relies on, by running the REAL client
 * operations (`listRemoteMcpServerTools`, `callRemoteMcpServerTool`: the official v2 SDK client
 * over the Effect `HttpClient` bridge) against the `McpConformanceTarget`, with the host's
 * `HttpClient` wrapped by the observing client (`makeMcpObservingHttpClient`). The cases send no
 * request of their own. The same cases run against replayed fixtures, an emulator, yolk's own
 * `makeMcpToolServer().handleHttpRequest` in-process, or a live server.
 *
 * Every case is a `read`. Safety of the four calling cases (`mcp.modern.stateless`,
 * `mcp.errors.unknown-tool`, `mcp.tools.call-read`, `mcp.tools.call-tool-error`) comes from the
 * observer's fail-closed call gate (`call-gate.ts`): the operation's `tools/call` is forwarded ONLY
 * when every exchange of that operation is fully understood, its own listing is complete, and that
 * listing proves the call safe (the absent tool is not listed; the read tool is marked
 * `readOnlyHint: true`). Anything else, uncertainty included, refuses; a refusal before any
 * forwarded call fails the case's precondition with zero forwarded calls, and a refused client
 * retry after a forwarded call is reported as a retry. Earlier preflight listings stay as friendly
 * early failures.
 *
 * Answers are read with `JSON.parse` semantics (`json.ts`), as the SDK reads them, so an
 * out-of-range number such as `1e400` is a value, not "not JSON".
 *
 * Mismatch messages and their `expected`/`actual` details carry only structural facts (methods,
 * statuses, counts, positions, codes, enums, host-supplied seeds), never response body text or the
 * target URL. A client failure a case re-raises is reported as the client words it (an
 * `McpError` message can quote a server body), and the runner sanitizes it
 * (`sanitizeConformanceMessage`).
 *
 * None is observed live yet (`observed` absent = unverified); sub-claims no live run has settled
 * are marked "(unverified: ...)" in their `wire`. `mcp.modern.*` and `mcp.legacy.*` cases apply to
 * one era only: pass them through `selectMcpConformanceCases`.
 *
 * Pinned real-code facts the cases follow (`@modelcontextprotocol/client` 2.0.0):
 *
 * - Era negotiation (`negotiateEra`, auto mode): 401 and 403 abort; 5xx aborts; a discover result
 *   valid for the client's loose discover dispatch schema (it ignores `resultType`, and catches a
 *   bad `ttlMs` or `cacheScope`) and listing `2026-07-28` selects modern; any other discover
 *   result (an invalid one, such as one without `capabilities`, or one with no mutually supported
 *   modern version) falls back to legacy; a JSON-RPC error falls back to legacy,
 *   except `-32022` (UnsupportedProtocolVersion) whose `data.supported` lists `2026-07-28` (one
 *   corrective retry of the probe) or lists only other modern versions (fatal).
 * - SSE (`_handleSseStream` over `EventSourceParserStream`, which has no flush): the cases read
 *   event streams with the same `eventsource-parser` the client resolves (`sse.ts`; verified
 *   in-repo by a parity test), fed the chunks `TextDecoderStream` emits for the one buffered byte
 *   chunk: the streaming decode, then the flush (U+FFFD for an incomplete trailing sequence), as
 *   separate feeds. So the first feed drops the literal characters `ï»¿`, a CR at the end of a
 *   feed stays pending, and an unterminated final event is never dispatched; only events with non-empty data and no `event:` field or
 *   `event: message` are read; priming events (`id: X` with empty data, which the official server
 *   sends when it has an event store) and other event types are skipped.
 * - The era probe is not only an era selector: after the probe window closes, the rest of its
 *   stream reaches the protocol `onmessage`, so the call gate accepts a 2xx probe answer only when
 *   it holds nothing but the probe's own response, notifications and error responses.
 * - `callTool` retries a call after a modern `HeaderMismatch` error (after re-listing), and the
 *   input-required driver can re-send it.
 * - Resumption (SEP-1699): after a priming event, a POST stream that ends without its response is
 *   resumed by a GET with `last-event-id`, and the SDK accepts the response delivered there. The
 *   cases do NOT accept that delivery (the call gate treats any GET-delivered message as
 *   uncertainty); their wire texts mark it "(unverified: ...)".
 * - `listTools(undefined)` follows `nextCursor` (stopping silently on a repeated cursor), lists
 *   nothing without `capabilities.tools`, and on modern connections drops tools with an invalid
 *   `x-mcp-header`. The tool schema keeps only the five annotation keys (`title`, `readOnlyHint`,
 *   `destructiveHint`, `idempotentHint`, `openWorldHint`), keeps `outputSchema` as received, and in
 *   the legacy era rejects the listing when an `inputSchema` or `outputSchema` root is not
 *   `type: "object"` (SDK servers wrap non-object output roots for legacy clients).
 * - `mcp-name` is the tool name through `encodeMcpParamValue` (`=?base64?...?=` for non-ASCII,
 *   padded or sentinel-shaped names).
 * - Delivery: the transport resolves a request from ANY stream: its POST answer, or a message on
 *   the standing GET (for example after the POST is answered 202). `callTool` sends a call for any
 *   name and enforces no annotation, and `callRemoteMcpServerTool` lists again on its own
 *   connection right before calling, so only that listing can prove a call safe.
 *
 * Not covered: `DELETE` (the client never sends it), `ping`, resources, prompts and logging
 * (never called), and URL policy, stdio and timeouts (unit tests).
 *
 * @experimental
 */
import { Cause, Effect, Equal, Exit, Option, Predicate } from 'effect'
import { HttpClient } from 'effect/http'
import {
  ConformanceMismatch,
  defineConformanceCase,
  expectConformance,
  expectEqual,
  type ConformanceCase
} from '@yolk-sdk/conformance/case'
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/client'
import { DiscoverResultSchema } from '@modelcontextprotocol/core'
import {
  callRemoteMcpServerTool,
  listRemoteMcpServerTools,
  type McpClientOptions,
  type McpResolvedTool
} from '../client/client.ts'
import type { McpRemoteServerConfig } from '../client/config.ts'
import type { McpError } from '../client/errors.ts'
import { latestMcpProtocolVersion } from '../client/protocol.ts'
import { mcpAuthRejectedLegacyFixture, mcpAuthRejectedModernFixture } from './auth-rejected.ts'
import { mcpCallReadLegacyFixture, mcpCallReadModernFixture } from './call-read.ts'
import { mcpCallToolErrorLegacyFixture, mcpCallToolErrorModernFixture } from './call-tool-error.ts'
import { mcpLegacySessionFixture } from './legacy-session.ts'
import { mcpModernStatelessFixture } from './modern-stateless.ts'
import {
  mcpNegotiationEraLegacyFixture,
  mcpNegotiationEraModernFixture
} from './negotiation-era.ts'
import {
  makeMcpObservingHttpClient,
  mcpResponseFeeds,
  rawListedToolNames,
  type McpObservedExchange,
  type McpObservingOptions
} from './observe.ts'
import {
  mcpResponseEncodingLegacyFixture,
  mcpResponseEncodingModernFixture
} from './response-encoding.ts'
import { encodeMcpParamValue } from './param-value.ts'
import { parseWireJson, type Json, type JsonObject } from './json.ts'
import { sseMessagePayloads } from './sse.ts'
import {
  McpConformanceConfig,
  McpConformanceTarget,
  mcpConformanceDefaultAbsentToolName,
  mcpConformanceDefaultInvalidCredentialHeaders,
  type McpConformanceSeedKey,
  type McpConformanceTargetSettings
} from './target.ts'
import { mcpToolsListLegacyFixture, mcpToolsListModernFixture } from './tools-list.ts'
import { mcpUnknownToolLegacyFixture, mcpUnknownToolModernFixture } from './unknown-tool.ts'

export type McpConformanceError = ConformanceMismatch | McpError

/** What every MCP conformance case requires from the host. */
export type McpConformanceRequirements =
  | HttpClient.HttpClient
  | McpConformanceTarget
  | McpConformanceConfig

export type McpConformanceCase = ConformanceCase<McpConformanceError, McpConformanceRequirements>

/** The `toolCallId` the call cases give the client (it never reaches the wire). */
const toolCallId = 'yolk-conformance-call'

const protocolVersionKey = 'io.modelcontextprotocol/protocolVersion'

const envelopeKeys = [
  protocolVersionKey,
  'io.modelcontextprotocol/clientInfo',
  'io.modelcontextprotocol/clientCapabilities'
]

/** The JSON-RPC code of UnsupportedProtocolVersion, which the probe classifier treats specially. */
const unsupportedProtocolVersionCode = -32_022

/** The annotation keys the SDK's tool schema keeps (it strips every other key). */
const modeledAnnotationKeys = [
  'title',
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint'
]

const mismatch = (message: string) => new ConformanceMismatch({ message })

const requireSeed = <K extends McpConformanceSeedKey>(key: K) =>
  Effect.gen(function* () {
    const seeds = yield* McpConformanceConfig
    const value = seeds[key]

    if (value === undefined) {
      return yield* mismatch(`precondition: McpConformanceConfig.${key} is not configured`)
    }

    return value
  })

const requireEra = (
  target: McpConformanceTargetSettings,
  era: McpConformanceTargetSettings['era']
) =>
  target.era === era
    ? Effect.void
    : Effect.fail(
        mismatch(`precondition: this case needs a ${era} target (see selectMcpConformanceCases)`)
      )

const remoteConfig = (
  target: McpConformanceTargetSettings,
  headers: Readonly<Record<string, string>> = target.headers
): McpRemoteServerConfig => ({ name: target.name, type: 'remote', url: target.url, headers })

const clientOptions = (target: McpConformanceTargetSettings): McpClientOptions => ({
  timeoutMs: target.timeoutMs
})

const invalidCredentialHeaders = (target: McpConformanceTargetSettings) =>
  target.invalidCredentialHeaders ?? mcpConformanceDefaultInvalidCredentialHeaders

/** Origin and path of a URL, the form the observer records. */
const urlKey = (url: string): string => {
  if (!URL.canParse(url)) {
    return url
  }

  const parsed = new URL(url)

  return `${parsed.origin}${parsed.pathname}`
}

/**
 * Run a client operation with the host's `HttpClient` wrapped by the observer, keeping its exit so
 * a case can explain a failure from the wire.
 */
const observe = <A, R>(effect: Effect.Effect<A, McpError, R>, options: McpObservingOptions = {}) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const observer = yield* makeMcpObservingHttpClient(http, options)

    const exit = yield* Effect.exit(
      effect.pipe(Effect.provideService(HttpClient.HttpClient, observer.client))
    )

    return { exit, exchanges: yield* observer.exchanges }
  })

const mcpErrorOf = <A>(exit: Exit.Exit<A, McpError>): McpError | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

// JSON-RPC views of observed exchanges.

const isRecord = (value: Json | undefined): value is JsonObject => Predicate.isObject(value)

const field = (value: Json | undefined, key: string): Json | undefined =>
  isRecord(value) ? value[key] : undefined

const rpcMethod = (exchange: McpObservedExchange): string | undefined => {
  const method = field(exchange.requestBody, 'method')

  return Predicate.isString(method) ? method : undefined
}

const rpcId = (exchange: McpObservedExchange): string | number | undefined => {
  const id = field(exchange.requestBody, 'id')

  return Predicate.isString(id) || Predicate.isNumber(id) ? id : undefined
}

const rpcParams = (exchange: McpObservedExchange): JsonObject | undefined => {
  const params = field(exchange.requestBody, 'params')

  return isRecord(params) ? params : undefined
}

const parseJson = parseWireJson

/** The JSON-RPC messages an answer holds (a JSON body, or the JSON message events of SSE). */
const answerMessages = (exchange: McpObservedExchange): ReadonlyArray<Json> => {
  const body = exchange.responseBody

  if (body === undefined || body.length === 0) {
    return []
  }

  if (exchange.mediaType === 'text/event-stream') {
    return sseMessagePayloads(mcpResponseFeeds(exchange)).flatMap(payload =>
      Option.toArray(parseJson(payload))
    )
  }

  return Option.match(parseJson(body), {
    onNone: () => [],
    onSome: (value): ReadonlyArray<Json> => (Array.isArray(value) ? value : [value])
  })
}

const isResponseTo = (message: Json | undefined, id: string | number | undefined): boolean =>
  isRecord(message) &&
  id !== undefined &&
  message['id'] === id &&
  ('result' in message || 'error' in message)

/** The JSON-RPC response to the exchange's request, when its answer holds one. */
const answerTo = (exchange: McpObservedExchange | undefined): JsonObject | undefined => {
  if (exchange === undefined) {
    return undefined
  }

  const id = rpcId(exchange)
  const found = answerMessages(exchange).find(message => isResponseTo(message, id))

  return isRecord(found) ? found : undefined
}

/**
 * The `result` member of the response: `none` when the response has no `result` member,
 * `invalid` when it has one that is not an object (for example `null`), else the object.
 */
type ResultMember =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'object'; readonly value: JsonObject }

const resultMemberOf = (exchange: McpObservedExchange | undefined): ResultMember => {
  const answer = answerTo(exchange)

  if (answer === undefined || !('result' in answer)) {
    return { kind: 'none' }
  }

  const result = answer['result']

  return isRecord(result) ? { kind: 'object', value: result } : { kind: 'invalid' }
}

const resultOf = (exchange: McpObservedExchange | undefined): JsonObject | undefined => {
  const member = resultMemberOf(exchange)

  return member.kind === 'object' ? member.value : undefined
}

const errorOf = (exchange: McpObservedExchange | undefined): JsonObject | undefined => {
  const error = field(answerTo(exchange), 'error')

  return isRecord(error) ? error : undefined
}

const byMethod = (exchanges: ReadonlyArray<McpObservedExchange>, method: string) =>
  exchanges.filter(exchange => rpcMethod(exchange) === method)

/** `METHOD rpc-method` of an exchange, for messages (never a header or body value). */
const labelOf = (exchange: McpObservedExchange): string =>
  `${exchange.method} ${rpcMethod(exchange) ?? '(no JSON-RPC method)'}`

/** Fail when the response to `exchange` has a `result` member that is not an object. */
const expectValidResult = (exchange: McpObservedExchange) =>
  expectConformance(
    resultMemberOf(exchange).kind !== 'invalid',
    `expected the result of ${labelOf(exchange)} to be an object`
  )

const toolName = (tool: Json): string | undefined => {
  const name = field(tool, 'name')

  return Predicate.isString(name) ? name : undefined
}

/**
 * The precondition of the call cases, checked through the real listing before any tools/call:
 * the listing marks the tool `readOnlyHint: true`. Returns the resolved tool.
 */
const requireReadOnlyTool = (target: McpConformanceTargetSettings, name: string) =>
  Effect.gen(function* () {
    const tools = yield* listRemoteMcpServerTools(remoteConfig(target), clientOptions(target))
    const tool = tools.find(candidate => candidate.mcpToolName === name)

    if (tool === undefined) {
      return yield* mismatch('precondition: the listing does not contain readTool')
    }

    if (tool.annotations?.['readOnlyHint'] !== true) {
      return yield* mismatch('precondition: the listing does not mark readTool readOnlyHint: true')
    }

    return tool
  })

const absentToolPrecondition = 'precondition: the listing contains absentToolName'

/**
 * Fail the precondition, before any tools/call, when a raw wire listing (before the SDK filters
 * anything) names `name`.
 */
const requireAbsent = (exchanges: ReadonlyArray<McpObservedExchange>, name: string) =>
  rawListedToolNames(exchanges).includes(name)
    ? Effect.fail(mismatch(absentToolPrecondition))
    : Effect.void

/**
 * Fail when the call gate refused to forward a tools/call of the operation (see `call-gate.ts`).
 * When no tools/call was forwarded before the refusal, the operation's own listing did not prove
 * the call safe, or something on the wire was not fully understood: a precondition failure with
 * zero forwarded calls. When a forwarded tools/call precedes the refusal, the client retried the
 * call (after a `HeaderMismatch` error, or to fulfil an input request) and the gate refused the
 * retry: one call WAS forwarded, so that is reported distinctly, not as a precondition.
 */
const expectNotRefused = (exchanges: ReadonlyArray<McpObservedExchange>) => {
  const index = exchanges.findIndex(exchange => exchange.refused !== undefined)
  const refused = exchanges[index]?.refused

  if (refused === undefined) {
    return Effect.void
  }

  const forwardedBefore = exchanges
    .slice(0, index)
    .some(exchange => rpcMethod(exchange) === 'tools/call')

  return Effect.fail(
    mismatch(
      forwardedBefore
        ? `expected one tools/call per operation: the client retried tools/call after a forwarded call, and the observer refused the retry (${refused})`
        : `precondition: the call operation's own wire evidence does not prove the call safe (${refused}); the observer did not forward tools/call`
    )
  )
}

// The era probe, classified as the pinned SDK's auto negotiation classifies it.

type ProbeVerdict =
  | 'unanswered'
  | 'refused'
  | 'server-error'
  | 'modern'
  | 'legacy'
  | 'corrective'
  | 'unsupported'

/** The JSON-RPC error in a probe answer (whatever its id: the SDK reads an HTTP error body whole). */
const probeError = (probe: McpObservedExchange): JsonObject | undefined => {
  const found = answerMessages(probe).find(
    message => isRecord(message) && isRecord(message['error'])
  )

  const error = field(found, 'error')

  return isRecord(error) && Predicate.isNumber(error['code']) ? error : undefined
}

const stringList = (value: Json | undefined): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every(Predicate.isString)
    ? value.filter(Predicate.isString)
    : undefined

/** `classifyRpcError`: only -32022 with a usable `data.supported` is special. */
const classifyProbeError = (error: JsonObject): ProbeVerdict => {
  if (error['code'] !== unsupportedProtocolVersionCode) {
    return 'legacy'
  }

  const supported = stringList(field(error['data'], 'supported'))

  if (supported === undefined || supported.length === 0) {
    return 'legacy'
  }

  if (supported.includes(latestMcpProtocolVersion)) {
    return 'corrective'
  }

  return supported.some(version => version >= latestMcpProtocolVersion) ? 'unsupported' : 'legacy'
}

/**
 * Whether a discover result passes the pinned client's validation. `classifyResult` validates it
 * with `codecForVersion("2026-07-28").validateResult("server/discover", ...)`, which uses the
 * loose post-lift DISPATCH schema (`dispatchResultSchemas["server/discover"]`, a `liftedResult`
 * in `@modelcontextprotocol/client` 2.0.0 `dist/src-D_zzAWoS.mjs:3127`): it does not read
 * `resultType` at all; `ttlMs` and `cacheScope` fall back to defaults (`.catch`); it requires
 * `supportedVersions: string[]` and `capabilities` (`ServerCapabilities2026Schema`, which strips
 * `tasks`); `instructions` is an optional string. An invalid result falls back to legacy. That
 * schema is not exported, so this uses the exported `DiscoverResultSchema` of
 * `@modelcontextprotocol/core` 2.0.0 (`dist/auth-CUe6YdwF.mjs:369`), which requires the same
 * fields with the same capability shapes and is loose elsewhere, after leaving out
 * `capabilities.tasks` (stripped, never validated, by the client).
 */
const isValidDiscoverResult = (result: JsonObject | undefined): boolean => {
  if (result === undefined) {
    return false
  }

  const capabilities = result['capabilities']

  const withoutTasks = isRecord(capabilities)
    ? Object.fromEntries(Object.entries(capabilities).filter(([key]) => key !== 'tasks'))
    : capabilities

  return DiscoverResultSchema.safeParse({ ...result, capabilities: withoutTasks }).success
}

/** `classifyProbeOutcome` for one observed probe (the client speaks only `2026-07-28`). */
const classifyProbe = (probe: McpObservedExchange): ProbeVerdict => {
  const status = probe.status

  if (status === undefined) {
    return 'unanswered'
  }

  if (status === 401 || status === 403) {
    return 'refused'
  }

  if (status >= 500) {
    return 'server-error'
  }

  const error = probeError(probe)

  if (error !== undefined) {
    return classifyProbeError(error)
  }

  const result = resultOf(probe)
  const supported = stringList(field(result, 'supportedVersions'))

  // A 2xx discover result that is invalid for the client's 2026 codec or lacks its modern
  // version, and any other 4xx answer, fall back to legacy (`classifyResult`).
  return status < 300 &&
    isValidDiscoverResult(result) &&
    supported?.includes(latestMcpProtocolVersion) === true
    ? 'modern'
    : 'legacy'
}

/** Why a final probe verdict cannot select an era, or `undefined` when it selects one. */
const verdictFailure = (verdict: ProbeVerdict): string | undefined => {
  switch (verdict) {
    case 'refused':
      return 'expected the era probe to be accepted (401/403: check the target credential)'
    case 'server-error':
      return 'expected the era probe never to be answered 5xx'
    case 'unsupported':
      return 'expected the era probe not to answer UnsupportedProtocolVersion (-32022) listing only modern versions this client does not speak'
    case 'corrective':
      return 'expected the corrective probe retry to settle the era'
    case 'unanswered':
      return 'expected the era probe to be answered'
    case 'modern':
    case 'legacy':
      return undefined
  }
}

export const mcpNegotiationEraCase: McpConformanceCase = defineConformanceCase({
  id: 'mcp.negotiation.era',
  title: 'the era probe selects the target era and is never answered 5xx',
  safety: 'read',
  docs: 'The client (official SDK, `versionNegotiation: { mode: "auto" }`) opens every operation with POST `server/discover` carrying the `_meta` envelope (`io.modelcontextprotocol/protocolVersion`, `clientInfo`, `clientCapabilities`) and the `mcp-protocol-version: 2026-07-28` and `mcp-method` headers. The SDK classifies the answer (`classifyProbeOutcome`): 401, 403 and 5xx abort; a discover result that is valid for its 2026 codec schema and lists `2026-07-28` selects modern; any other discover result (an invalid one, for example without `capabilities`, or one with no mutually supported modern version) falls back to legacy; a JSON-RPC error, or a 4xx without one, falls back to legacy, except -32022 UnsupportedProtocolVersion, whose `data.supported` either lists `2026-07-28` (one corrective retry of the probe) or lists only other modern versions (fatal).',
  wire: 'The first request to the target URL is POST `server/discover` with the three `_meta` envelope keys, `mcp-protocol-version: 2026-07-28` and `mcp-method: server/discover`. Classified as the SDK classifies it, the final probe answer selects `target.era`: modern (a 2xx discover result valid for the pinned 2026 schema whose `supportedVersions` lists `2026-07-28`, which must equal `target.protocolVersion`) or legacy (an invalid discover result or one without that version, a JSON-RPC error other than a modern -32022, or a 4xx other than 401/403). It is never a 5xx, 401 or 403, never a -32022 listing only other modern versions, and at most one corrective -32022 precedes it. The client then proceeds in that era (the next request is an enveloped tools/list, or `initialize`).',
  fixtures: [mcpNegotiationEraModernFixture.id, mcpNegotiationEraLegacyFixture.id],
  run: Effect.gen(function* () {
    const target = yield* McpConformanceTarget

    const { exit, exchanges } = yield* observe(
      listRemoteMcpServerTools(remoteConfig(target), clientOptions(target))
    )

    const probeCount = exchanges.findIndex(exchange => rpcMethod(exchange) !== 'server/discover')
    const probes = exchanges.slice(0, probeCount === -1 ? exchanges.length : probeCount)
    const [probe] = probes
    const last = probes.at(-1)
    const next = exchanges[probes.length]

    if (probe === undefined || last === undefined) {
      return Exit.isFailure(exit)
        ? yield* exit
        : yield* mismatch('expected the client to send the era probe')
    }

    // An unanswered probe (a timeout or a dropped connection) is the client's failure: report it.
    if (last.status === undefined && Exit.isFailure(exit)) {
      return yield* exit
    }

    yield* expectConformance(
      probe.method === 'POST' && probe.url === urlKey(target.url),
      'expected the first request to be POST server/discover to the target URL'
    )

    for (const sent of probes) {
      const meta = field(rpcParams(sent), '_meta')

      yield* expectConformance(
        envelopeKeys.every(key => field(meta, key) !== undefined) &&
          field(meta, protocolVersionKey) === latestMcpProtocolVersion,
        'expected the era probe to carry the _meta envelope for 2026-07-28'
      )
      yield* expectEqual(
        [
          sent.requestHeaders['mcp-protocol-version'] ?? null,
          sent.requestHeaders['mcp-method'] ?? null
        ],
        [latestMcpProtocolVersion, 'server/discover'],
        'expected the era probe headers mcp-protocol-version: 2026-07-28 and mcp-method: server/discover'
      )
    }

    const verdicts = probes.map(classifyProbe)
    const final = verdicts.at(-1) ?? 'unanswered'

    yield* expectConformance(
      verdicts.slice(0, -1).every(verdict => verdict === 'corrective') && verdicts.length <= 2,
      'expected at most one corrective probe retry before the era is settled'
    )

    const message = verdictFailure(final)

    if (message !== undefined) {
      return yield* mismatch(message)
    }

    yield* expectEqual(
      final,
      target.era,
      `expected the era probe answer to select the ${target.era} era`
    )

    if (final === 'modern') {
      yield* expectEqual(
        latestMcpProtocolVersion,
        target.protocolVersion,
        'expected the modern version the probe selects to equal target.protocolVersion'
      )
    }

    const nextEra =
      next === undefined
        ? 'none'
        : rpcMethod(next) === 'initialize'
          ? 'legacy'
          : field(field(rpcParams(next), '_meta'), protocolVersionKey) === target.protocolVersion
            ? 'modern'
            : 'neither'

    yield* expectEqual(
      nextEra,
      target.era,
      `expected the client to continue in the ${target.era} era after the probe`
    )

    if (Exit.isFailure(exit)) {
      return yield* exit
    }
  })
})

export const mcpModernStatelessCase: McpConformanceCase = defineConformanceCase({
  id: 'mcp.modern.stateless',
  title: 'modern requests carry the routing headers, answers carry no session, results complete',
  safety: 'read',
  docs: 'In the modern era the client is stateless: it builds one SDK client per operation, sends the `_meta` envelope and mirrors it into `mcp-protocol-version` and `mcp-method` headers on every request (and `mcp-name`, the tool name through `encodeMcpParamValue`, on tools/call), and never reads or echoes a session id. The modern codec requires `resultType: "complete"` on results.',
  wire: 'Over a listing and, once that raw wire listing confirms `absentToolName` is absent (a precondition), a tools/call of it, forwarded only when the call gate holds positive evidence from the call operation\'s own complete listing (precondition otherwise, with zero forwarded calls) (its answer is checked by `mcp.errors.unknown-tool`): no answer carries `mcp-session-id`. Every request is a POST whose body carries the `_meta` envelope for `target.protocolVersion`, with `mcp-protocol-version: 2026-07-28` and `mcp-method` equal to the body method; tools/call also carries `mcp-name` equal to `encodeMcpParamValue(name)`. Every JSON-RPC `result` is an object carrying `resultType: "complete"`. The call either succeeds or fails only with the server\'s JSON-RPC error (`McpError` `cause: "protocol"`).',
  fixtures: [mcpModernStatelessFixture.id],
  run: Effect.gen(function* () {
    const target = yield* McpConformanceTarget
    const seeds = yield* McpConformanceConfig
    const absentToolName = seeds.absentToolName ?? mcpConformanceDefaultAbsentToolName

    yield* requireEra(target, 'modern')

    const listing = yield* observe(
      listRemoteMcpServerTools(remoteConfig(target), clientOptions(target))
    )

    if (Exit.isFailure(listing.exit)) {
      return yield* listing.exit
    }

    yield* requireAbsent(listing.exchanges, absentToolName)

    const call = yield* observe(
      callRemoteMcpServerTool({
        config: remoteConfig(target),
        mcpToolName: absentToolName,
        toolCallId,
        params: {},
        options: clientOptions(target)
      }),
      { callGate: { kind: 'absent', name: absentToolName } }
    )

    yield* expectNotRefused(call.exchanges)

    const exchanges = [...listing.exchanges, ...call.exchanges]
    const calls = byMethod(exchanges, 'tools/call')

    yield* expectConformance(calls.length === 1, 'expected the client to send one tools/call')

    for (const exchange of exchanges) {
      const label = labelOf(exchange)
      const method = rpcMethod(exchange)
      const headers = exchange.requestHeaders

      yield* expectConformance(
        exchange.responseSession === undefined,
        `expected no mcp-session-id on the answer to ${label}`
      )
      yield* expectConformance(
        exchange.method === 'POST' && method !== undefined,
        `expected every modern request to be a JSON-RPC POST (${label})`
      )
      yield* expectConformance(
        field(field(rpcParams(exchange), '_meta'), protocolVersionKey) === target.protocolVersion,
        `expected the _meta envelope for ${target.protocolVersion} on ${label}`
      )
      yield* expectConformance(
        headers['mcp-protocol-version'] === target.protocolVersion,
        `expected mcp-protocol-version: ${target.protocolVersion} on ${label}`
      )
      yield* expectConformance(
        headers['mcp-method'] === method,
        `expected mcp-method to equal the body method on ${label}`
      )

      if (method === 'tools/call') {
        const name = field(rpcParams(exchange), 'name')

        yield* expectConformance(
          Predicate.isString(name) && headers['mcp-name'] === encodeMcpParamValue(name),
          'expected mcp-name to equal the encoded tool name on tools/call'
        )
      }

      yield* expectValidResult(exchange)

      const result = resultOf(exchange)

      if (result !== undefined) {
        yield* expectConformance(
          result['resultType'] === 'complete',
          `expected resultType: "complete" on the result of ${label}`
        )
      }
    }

    const error = mcpErrorOf(call.exit)

    if (
      Exit.isFailure(call.exit) &&
      !(error?.cause === 'protocol' && errorOf(calls[0]) !== undefined)
    ) {
      return yield* call.exit
    }
  })
})

export const mcpLegacySessionCase: McpConformanceCase = defineConformanceCase({
  id: 'mcp.legacy.session',
  title: 'the legacy handshake issues a usable session and acknowledges initialized with 202',
  safety: 'read',
  docs: 'In the legacy era the client (`StreamableHTTPClientTransport`) sends `initialize` with protocolVersion `2025-11-25`, reads the `mcp-session-id` answer header, sends `notifications/initialized` (a 202 makes it open a standing GET event stream; 405 is accepted), and echoes the session id and `mcp-protocol-version` on every later request.',
  wire: '`initialize` answers a `protocolVersion` the SDK supports (and equal to `target.protocolVersion`) with `capabilities.tools`. Any issued `mcp-session-id` is visible ASCII, is echoed on every later request, and is accepted (the listing succeeds). `notifications/initialized` gets 202 with an empty body. The standing `GET`, when answered before the client closes, gets 405 or an event stream (unverified: which, live).',
  fixtures: [mcpLegacySessionFixture.id],
  run: Effect.gen(function* () {
    const target = yield* McpConformanceTarget

    yield* requireEra(target, 'legacy')

    const { exit, exchanges } = yield* observe(
      listRemoteMcpServerTools(remoteConfig(target), clientOptions(target))
    )

    const initializeIndex = exchanges.findIndex(exchange => rpcMethod(exchange) === 'initialize')
    const initialize = exchanges[initializeIndex]

    if (initialize === undefined) {
      return Exit.isFailure(exit)
        ? yield* exit
        : yield* mismatch('expected the client to send initialize')
    }

    const result = resultOf(initialize)
    const protocolVersion = field(result, 'protocolVersion')

    yield* expectConformance(
      Predicate.isString(protocolVersion) && SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion),
      'expected initialize to answer a protocolVersion the SDK supports',
      { expected: [...SUPPORTED_PROTOCOL_VERSIONS] }
    )
    yield* expectConformance(
      protocolVersion === target.protocolVersion,
      'expected initialize to answer target.protocolVersion'
    )
    yield* expectConformance(
      isRecord(field(field(result, 'capabilities'), 'tools')),
      'expected initialize to answer capabilities.tools'
    )

    const session = initialize.responseSession

    yield* expectConformance(
      session === undefined || session.visibleAscii,
      'expected the issued mcp-session-id to be visible ASCII'
    )

    for (const later of exchanges.slice(initializeIndex + 1)) {
      yield* expectConformance(
        later.requestSession?.id === session?.id,
        session === undefined
          ? `expected no mcp-session-id on ${labelOf(later)} (none was issued)`
          : `expected the issued session id echoed on ${labelOf(later)}`
      )
    }

    const [initialized] = byMethod(exchanges, 'notifications/initialized')

    yield* expectConformance(
      initialized !== undefined,
      'expected the client to send notifications/initialized'
    )
    yield* expectEqual(
      [initialized?.status ?? null, initialized?.responseBody?.length ?? null],
      [202, 0],
      'expected notifications/initialized to get 202 with an empty body ([status, body length])'
    )

    for (const get of exchanges.filter(exchange => exchange.method === 'GET')) {
      yield* expectConformance(
        get.status === undefined ||
          get.status === 405 ||
          (get.status === 200 && get.mediaType === 'text/event-stream'),
        'expected the standing GET to get 405 or an event stream',
        { actual: get.status ?? null }
      )
    }

    if (Exit.isFailure(exit)) {
      return yield* exit
    }
  })
})

export const mcpResponseEncodingCase: McpConformanceCase = defineConformanceCase({
  id: 'mcp.transport.response-encoding',
  title: 'answers are JSON or a finite SSE stream holding the response once; 202 has no body',
  safety: 'read',
  docs: 'The client dispatches on `content-type`: `application/json` holds the response; `text/event-stream` is read event by event (`_handleSseStream` over `EventSourceParserStream`, which dispatches only completed events and has no flush, so an unterminated final event is never read), skipping events with empty data (priming events) and events whose `event:` is neither absent nor `message`, and ignoring notifications before or after the response. The Effect fetch bridge (`makeEffectFetch`) buffers the whole body, so an SSE answer to a POST must END, or the call only fails at the request timeout. A 202 body is discarded.',
  wire: 'Over a listing, every 2xx answer to a JSON-RPC request is `application/json` or `text/event-stream`. A JSON answer holds the response with the request id. An SSE answer ends (the client reads it to the end) and, among the events the client reads (completed, non-empty data, no `event:` or `event: message`; an unterminated final block is not an event), holds the response with the request id exactly once, every one of them JSON; priming events, other event types, and notifications before or after the response are allowed (unverified: that live servers send any). A 202 has an empty body. Each response arrives on its own POST answer (unverified: SEP-1699 resumption, where the server primes, closes the POST stream and delivers the response on a `last-event-id` GET, is not accepted, although the SDK accepts it).',
  fixtures: [mcpResponseEncodingModernFixture.id, mcpResponseEncodingLegacyFixture.id],
  run: Effect.gen(function* () {
    const target = yield* McpConformanceTarget

    const { exit, exchanges } = yield* observe(
      listRemoteMcpServerTools(remoteConfig(target), clientOptions(target))
    )

    for (const exchange of exchanges) {
      const label = labelOf(exchange)
      const status = exchange.status

      if (status === 202) {
        yield* expectConformance(
          exchange.responseBody === '',
          `expected 202 with no body (${label})`,
          { actual: exchange.responseBody?.length ?? null }
        )
      }

      const id = rpcId(exchange)

      if (id === undefined || status === undefined || status < 200 || status >= 300) {
        continue
      }

      yield* expectConformance(
        exchange.mediaType === 'application/json' || exchange.mediaType === 'text/event-stream',
        `expected the answer to ${label} to be application/json or text/event-stream`
      )

      if (exchange.responseBody === undefined) {
        // The answer never ended (the client then fails at its timeout): report that failure.
        return Exit.isFailure(exit)
          ? yield* exit
          : yield* mismatch(`expected the answer to ${label} to end`)
      }

      if (exchange.mediaType === 'text/event-stream') {
        const messages = sseMessagePayloads(mcpResponseFeeds(exchange)).map(payload =>
          Option.getOrUndefined(parseJson(payload))
        )

        yield* expectConformance(
          messages.every(message => message !== undefined),
          `expected every message event of the answer to ${label} to be JSON`
        )
        yield* expectEqual(
          messages.filter(message => isResponseTo(message, id)).length,
          1,
          `expected the event stream answering ${label} to hold its response once`
        )
      } else {
        yield* expectConformance(
          answerTo(exchange) !== undefined,
          `expected the JSON answer to ${label} to hold the response with the request id`
        )
      }
    }

    if (Exit.isFailure(exit)) {
      return yield* exit
    }
  })
})

type WireTool = {
  readonly name: string
  /** Where the tool was listed (`page 2 tool 1`), the only way messages name it. */
  readonly position: string
  readonly value: JsonObject
}

/** The modeled annotation keys of an annotations value (the SDK strips every other key). */
const modeledAnnotations = (annotations: unknown): JsonObject | undefined => {
  if (!Predicate.isObject(annotations)) {
    return undefined
  }

  return Object.fromEntries(
    modeledAnnotationKeys.flatMap(key => {
      const value = annotations[key]

      return Predicate.isString(value) || Predicate.isBoolean(value) ? [[key, value]] : []
    })
  )
}

export const mcpToolsListCase: McpConformanceCase = defineConformanceCase({
  id: 'mcp.tools.list',
  title:
    'the listing advertises tools, pages cleanly, and every tool reaches the adapter one to one',
  safety: 'read',
  docs: '`listRemoteMcpServerTools` calls the SDK `listTools(undefined)`, which returns an empty listing WITHOUT a request when the server does not advertise `capabilities.tools`, follows `nextCursor` across pages (it stops silently on a repeated cursor and fails after `listMaxPages`, default 64), and on modern connections silently drops tools whose `x-mcp-header` declarations are invalid. The SDK tool schema keeps only the five annotation keys (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) and keeps `outputSchema` as received; in the legacy era it rejects the whole listing when an `inputSchema` or `outputSchema` root is not `type: "object"` (SDK servers wrap non-object output roots for legacy clients). `decodeToolsListResult` and `mcpToolToToolDef` then adapt each tool (`<server>_<sanitizeMcpName(tool)>`), and `listMcpTools` rejects duplicate adapted names.',
  wire: 'The server advertises `capabilities.tools` (in the discover result, or the `initialize` result). Every tools/list page holds tools with a non-empty `name` and an object `inputSchema` with `type: "object"` (legacy: an `outputSchema`, when present, also has `type: "object"`). Any `nextCursor` is followed: each page after the first sends the previous cursor, no cursor repeats, and the last page has none (paging allowed). Listed tools and `McpResolvedTool`s correspond one to one (as many resolved as listed; none silently dropped), with `title`, `outputSchema` and the modeled annotation keys unchanged (other annotation keys are stripped by the SDK and not compared). Adapted names stay unique after `sanitizeMcpName`. `expectedTools` are listed, and no `notReadOnly` tool has `readOnlyHint: true`. Every page arrives on its own POST answer (unverified: SEP-1699 resumption on a `last-event-id` GET, which the SDK accepts, is not accepted).',
  fixtures: [mcpToolsListModernFixture.id, mcpToolsListLegacyFixture.id],
  run: Effect.gen(function* () {
    const target = yield* McpConformanceTarget
    const seeds = yield* McpConformanceConfig

    const { exit, exchanges } = yield* observe(
      listRemoteMcpServerTools(remoteConfig(target), clientOptions(target))
    )

    const handshakeMethod = target.era === 'modern' ? 'server/discover' : 'initialize'
    const handshake = byMethod(exchanges, handshakeMethod).at(-1)

    // No handshake result (refused, 5xx, unanswered): report the client's failure first.
    if (Exit.isFailure(exit) && resultOf(handshake) === undefined) {
      return yield* exit
    }

    yield* expectConformance(
      isRecord(field(field(resultOf(handshake), 'capabilities'), 'tools')),
      `expected the ${target.era === 'modern' ? 'discover' : 'initialize'} result to advertise capabilities.tools (without it the client lists nothing)`
    )

    const pages = byMethod(exchanges, 'tools/list')

    if (pages.length === 0) {
      return Exit.isFailure(exit)
        ? yield* exit
        : yield* mismatch('expected the client to send tools/list')
    }

    const cursors: Array<string> = []
    const tools: Array<WireTool> = []

    for (const [index, page] of pages.entries()) {
      const result = resultOf(page)
      const listed = field(result, 'tools')

      if (!Array.isArray(listed)) {
        // An unanswered page is the client's failure (for example a timeout): report that.
        return Exit.isFailure(exit)
          ? yield* exit
          : yield* mismatch(`expected tools/list page ${index + 1} to answer a tools array`)
      }

      const sentCursor = field(rpcParams(page), 'cursor')

      yield* expectConformance(
        sentCursor === (index === 0 ? undefined : cursors[index - 1]),
        `expected tools/list page ${index + 1} to send the previous page's cursor`
      )

      const nextCursor = field(result, 'nextCursor')

      if (Predicate.isString(nextCursor)) {
        yield* expectConformance(
          !cursors.includes(nextCursor),
          `expected no repeated cursor (page ${index + 1} repeats an earlier nextCursor)`
        )
        cursors.push(nextCursor)
      }

      for (const [toolIndex, tool] of listed.entries()) {
        const name = toolName(tool)
        const position = `page ${index + 1} tool ${toolIndex + 1}`

        if (name === undefined || name.length === 0 || !isRecord(tool)) {
          return yield* mismatch(`expected every tool to have a name (${position})`)
        }

        yield* expectConformance(
          field(tool['inputSchema'], 'type') === 'object',
          `expected an object inputSchema with type: "object" (${position})`
        )

        if (target.era === 'legacy' && tool['outputSchema'] !== undefined) {
          yield* expectConformance(
            field(tool['outputSchema'], 'type') === 'object',
            `expected an outputSchema with type: "object", which the legacy client requires (${position})`
          )
        }

        tools.push({ name, position, value: tool })
      }
    }

    yield* expectConformance(
      field(resultOf(pages.at(-1)), 'nextCursor') === undefined,
      'expected the last tools/list page to have no nextCursor'
    )

    if (Exit.isFailure(exit)) {
      return yield* exit
    }

    const resolved: ReadonlyArray<McpResolvedTool> = exit.value
    const unmatched = [...resolved]
    const dropped: Array<string> = []

    for (const tool of tools) {
      const index = unmatched.findIndex(candidate => candidate.mcpToolName === tool.name)
      const adapted = unmatched[index]

      if (adapted === undefined) {
        dropped.push(tool.position)
        continue
      }

      unmatched.splice(index, 1)

      yield* expectConformance(
        Equal.equals(adapted.title, tool.value['title']) &&
          Equal.equals(adapted.outputSchema, tool.value['outputSchema']) &&
          Equal.equals(
            modeledAnnotations(adapted.annotations),
            modeledAnnotations(tool.value['annotations'])
          ),
        `expected title, outputSchema and the modeled annotations to reach McpResolvedTool unchanged (${tool.position})`
      )
    }

    yield* expectConformance(
      dropped.length === 0 && unmatched.length === 0,
      `expected listed tools and McpResolvedTools to correspond one to one (listed ${tools.length}, resolved ${resolved.length}; silently dropped: ${dropped.join(', ') || 'none'})`
    )

    const adaptedNames = resolved.map(tool => tool.def.name)

    yield* expectConformance(
      new Set(adaptedNames).size === adaptedNames.length,
      'expected adapted tool names to stay unique after sanitizeMcpName'
    )

    const names = tools.map(tool => tool.name)
    const missing = (seeds.expectedTools ?? []).filter(name => !names.includes(name))

    yield* expectEqual(missing, [], 'expected every expectedTools name in the listing')

    const markedReadOnly = (seeds.notReadOnly ?? []).filter(name =>
      tools.some(
        tool => tool.name === name && field(tool.value['annotations'], 'readOnlyHint') === true
      )
    )

    yield* expectEqual(
      markedReadOnly,
      [],
      'expected no notReadOnly tool to be marked readOnlyHint: true'
    )
  })
})

export const mcpCallReadCase: McpConformanceCase = defineConformanceCase({
  id: 'mcp.tools.call-read',
  title: 'the read tool answers a tool result that decodes and passes output validation',
  safety: 'read',
  docs: '`callRemoteMcpServerTool` lists tools and calls on one connection; the SDK validates `structuredContent` against the listed `outputSchema` (and requires it when the tool has one), then `decodeToolCallResult` and `toolCallResultToToolResult` map the answer to a `ToolResult`.',
  wire: "Precondition, checked through the real listing before any tools/call, and again by the call gate on the call operation's own complete, fully understood listing (zero forwarded calls otherwise): the listing marks `readTool` `readOnlyHint: true`. Calling `readTool` with its seeded arguments answers a JSON-RPC `result` object (not an error, not a non-object result) that decodes as `ToolCallResult` with `isError` absent or false and maps to a `ToolResult`. When the tool has an `outputSchema`, `structuredContent` is present and passes SDK validation.",
  fixtures: [mcpCallReadModernFixture.id, mcpCallReadLegacyFixture.id],
  run: Effect.gen(function* () {
    const target = yield* McpConformanceTarget
    const readTool = yield* requireSeed('readTool')
    const listed = yield* requireReadOnlyTool(target, readTool.name)

    const { exit, exchanges } = yield* observe(
      callRemoteMcpServerTool({
        config: remoteConfig(target),
        mcpToolName: readTool.name,
        toolCallId,
        params: readTool.arguments,
        options: clientOptions(target)
      }),
      { callGate: { kind: 'read-only', name: readTool.name } }
    )

    yield* expectNotRefused(exchanges)

    const [call] = byMethod(exchanges, 'tools/call')

    yield* expectConformance(
      errorOf(call) === undefined,
      'expected the read call to answer a result, not a JSON-RPC error'
    )

    if (call !== undefined) {
      yield* expectValidResult(call)
    }

    if (Exit.isFailure(exit)) {
      return yield* exit
    }

    yield* expectConformance(
      field(resultOf(call), 'isError') !== true && exit.value.isError !== true,
      'expected the read call result to have isError absent or false'
    )

    if (listed.outputSchema !== undefined) {
      yield* expectConformance(
        exit.value.structuredContent !== undefined,
        'expected structuredContent from a tool with an outputSchema'
      )
    }
  })
})

/** True when a tool result has at least one non-empty text content block. */
const hasTextContent = (result: JsonObject | undefined): boolean => {
  const content = field(result, 'content')

  return (
    Array.isArray(content) &&
    content.some(block => {
      const text = field(block, 'text')

      return field(block, 'type') === 'text' && Predicate.isString(text) && text.length > 0
    })
  )
}

export const mcpCallToolErrorCase: McpConformanceCase = defineConformanceCase({
  id: 'mcp.tools.call-tool-error',
  title: 'invalid arguments answer a tool result with isError, not a JSON-RPC error',
  safety: 'read',
  docs: 'A tool result with `isError: true` reaches the model as `ToolResult.isError` with its text, so the model can correct its arguments; a JSON-RPC error instead fails the whole call as `McpError` (`cause: "protocol"`).',
  wire: "Precondition, checked through the real listing before any tools/call, and again by the call gate on the call operation's own complete, fully understood listing (zero forwarded calls otherwise): the listing marks `readTool` `readOnlyHint: true`. Calling `readTool` with `invalidArguments` answers a JSON-RPC `result` object (not an error; unverified: some servers answer -32602) with `isError: true` and at least one non-empty text content block, which maps to a `ToolResult` with `isError: true`.",
  fixtures: [mcpCallToolErrorModernFixture.id, mcpCallToolErrorLegacyFixture.id],
  run: Effect.gen(function* () {
    const target = yield* McpConformanceTarget
    const readTool = yield* requireSeed('readTool')
    const invalidArguments = yield* requireSeed('invalidArguments')

    yield* requireReadOnlyTool(target, readTool.name)

    const { exit, exchanges } = yield* observe(
      callRemoteMcpServerTool({
        config: remoteConfig(target),
        mcpToolName: readTool.name,
        toolCallId,
        params: invalidArguments,
        options: clientOptions(target)
      }),
      { callGate: { kind: 'read-only', name: readTool.name } }
    )

    yield* expectNotRefused(exchanges)

    const [call] = byMethod(exchanges, 'tools/call')
    const error = errorOf(call)

    yield* expectConformance(
      error === undefined,
      'expected invalid arguments to answer a tool result with isError: true, not a JSON-RPC error',
      { actual: Predicate.isNumber(error?.['code']) ? error['code'] : null }
    )

    if (call !== undefined) {
      yield* expectValidResult(call)
    }

    if (Exit.isFailure(exit)) {
      return yield* exit
    }

    const result = resultOf(call)

    yield* expectConformance(
      result?.['isError'] === true && exit.value.isError === true,
      'expected the tool result for invalid arguments to have isError: true'
    )
    yield* expectConformance(
      hasTextContent(result),
      'expected the tool error result to carry text content'
    )
  })
})

export const mcpUnknownToolCase: McpConformanceCase = defineConformanceCase({
  id: 'mcp.errors.unknown-tool',
  title: 'calling an absent tool answers a JSON-RPC error with the request id, never 5xx',
  safety: 'read',
  docs: 'A JSON-RPC error answer to tools/call fails the call as `McpError` with `cause: "protocol"` (`sdkFailureCause` maps the SDK `ProtocolError`). On modern requests the SDK also routes a 400 whose body is a JSON-RPC error for the request id as that protocol error. Any other non-2xx fails as an `SdkError` whose message carries the body (`Error POSTing to endpoint: <body>`); `sdkFailureCause` maps it to `protocol` when that message mentions JSON, parse or content type (a JSON-RPC body usually does) and to `transport` otherwise, so the cause alone does not tell a JSON-RPC error from an HTTP failure: the case checks the status and the request id itself.',
  wire: 'Precondition, checked on the raw wire listing (before the SDK filters anything) before any tools/call: no listing names `absentToolName`. The call is forwarded only when the call gate holds positive evidence from the call operation\'s own complete, fully understood listing that the name is absent; otherwise the precondition fails with zero forwarded calls. `tools/call` of it gets a JSON-RPC error carrying the request id: HTTP 200, or for modern targets HTTP 400 with the JSON-RPC body. Never a 5xx and never a `result` member. The call surfaces as `McpError` with `cause: "protocol"`.',
  fixtures: [mcpUnknownToolModernFixture.id, mcpUnknownToolLegacyFixture.id],
  run: Effect.gen(function* () {
    const target = yield* McpConformanceTarget
    const seeds = yield* McpConformanceConfig
    const absentToolName = seeds.absentToolName ?? mcpConformanceDefaultAbsentToolName

    const listing = yield* observe(
      listRemoteMcpServerTools(remoteConfig(target), clientOptions(target))
    )

    if (Exit.isFailure(listing.exit)) {
      return yield* listing.exit
    }

    yield* requireAbsent(listing.exchanges, absentToolName)

    const { exit, exchanges } = yield* observe(
      callRemoteMcpServerTool({
        config: remoteConfig(target),
        mcpToolName: absentToolName,
        toolCallId,
        params: {},
        options: clientOptions(target)
      }),
      { callGate: { kind: 'absent', name: absentToolName } }
    )

    yield* expectNotRefused(exchanges)

    const [call] = byMethod(exchanges, 'tools/call')

    if (call === undefined) {
      return Exit.isFailure(exit)
        ? yield* exit
        : yield* mismatch('expected the client to send tools/call')
    }

    const allowed = target.era === 'modern' ? [200, 400] : [200]

    yield* expectConformance(
      call.status !== undefined && allowed.includes(call.status),
      `expected tools/call of an absent tool to be answered HTTP ${allowed.join(' or ')}, never 5xx`,
      { actual: call.status ?? null }
    )
    yield* expectConformance(
      resultMemberOf(call).kind === 'none',
      'expected tools/call of an absent tool not to answer a result'
    )
    yield* expectConformance(
      errorOf(call) !== undefined,
      'expected tools/call of an absent tool to answer a JSON-RPC error with the request id'
    )

    const error = mcpErrorOf(exit)

    yield* expectEqual(
      error?.cause ?? (Exit.isSuccess(exit) ? 'succeeded' : 'other failure'),
      'protocol',
      'expected the call to fail as McpError with cause "protocol"'
    )
  })
})

/**
 * Header names that carry credentials (the shared conformance list's names and segments). The
 * auth case drops them from `target.headers` before merging the invalid credential headers.
 */
const isCredentialHeaderName = (name: string): boolean => {
  const lower = name.toLowerCase()

  return (
    ['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'api-key'].includes(lower) ||
    /(api[-_]?key|secret|password|cookie|authorization)/.test(lower) ||
    /(^|[-_])(token|key|auth)([-_]|$)/.test(lower)
  )
}

/** `target.headers` without credential headers, with the invalid credential headers merged over. */
const rejectedHeaders = (target: McpConformanceTargetSettings) => {
  const invalid = invalidCredentialHeaders(target)
  const replaced = Object.keys(invalid).map(name => name.toLowerCase())

  return {
    ...Object.fromEntries(
      Object.entries(target.headers).filter(
        ([name]) => !isCredentialHeaderName(name) && !replaced.includes(name.toLowerCase())
      )
    ),
    ...invalid
  }
}

/** A `Bearer` challenge anywhere in a `WWW-Authenticate` value (RFC 9110 allows several). */
const hasBearerChallenge = (value: string | undefined) =>
  value !== undefined && /(?:^|,)\s*bearer(?:\s|,|$)/i.test(value)

export const mcpAuthRejectedCase: McpConformanceCase = defineConformanceCase({
  id: 'mcp.auth.rejected',
  title: 'an invalid credential is answered 401 with a Bearer challenge on the first request',
  safety: 'read',
  docs: 'The client has no `authProvider`: it sends the static configured headers and never runs OAuth. The SDK era probe classifies 401 and 403 as fatal (`classifyHttpError`), so the operation fails before any listing as `McpError` with `cause: "transport"`.',
  wire: 'The first request, sent with the non-credential `target.headers` and `target.invalidCredentialHeaders` merged over them (default `Authorization: Bearer yolk-conformance-invalid-credential-0000`), gets HTTP 401 (not 200, 403 or 5xx) with a `Bearer` challenge in `WWW-Authenticate` (in any position, any letter case; unverified: whether it carries `resource_metadata`). No tools/list is sent and the listing fails as `McpError` with `cause: "transport"`.',
  fixtures: [mcpAuthRejectedModernFixture.id, mcpAuthRejectedLegacyFixture.id],
  run: Effect.gen(function* () {
    const target = yield* McpConformanceTarget

    const { exit, exchanges } = yield* observe(
      listRemoteMcpServerTools(remoteConfig(target, rejectedHeaders(target)), clientOptions(target))
    )

    const [first] = exchanges

    yield* expectEqual(
      first?.status ?? null,
      401,
      'expected the first request with the invalid credential to get 401'
    )
    yield* expectConformance(
      hasBearerChallenge(first?.responseHeaders?.['www-authenticate']),
      'expected the 401 to carry a WWW-Authenticate: Bearer challenge'
    )
    yield* expectEqual(
      byMethod(exchanges, 'tools/list').length,
      0,
      'expected no tools/list after the 401'
    )

    const error = mcpErrorOf(exit)

    yield* expectEqual(
      error?.cause ?? (Exit.isSuccess(exit) ? 'succeeded' : 'other failure'),
      'transport',
      'expected the listing to fail as McpError with cause "transport"'
    )
  })
})

/** Every MCP conformance case, in fixture order. */
export const mcpConformanceCases: ReadonlyArray<McpConformanceCase> = [
  mcpNegotiationEraCase,
  mcpModernStatelessCase,
  mcpLegacySessionCase,
  mcpResponseEncodingCase,
  mcpToolsListCase,
  mcpCallReadCase,
  mcpCallToolErrorCase,
  mcpUnknownToolCase,
  mcpAuthRejectedCase
]
