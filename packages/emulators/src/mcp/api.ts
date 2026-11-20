/**
 * MCP emulator route table (internal): one wire route per recorded HTTP shape (`POST /modern/mcp`,
 * `POST /legacy/mcp`, `GET /legacy/mcp` on the synthetic origin, `POST /mcp` on the Afloat origin,
 * and `POST /mcp` and `GET /mcp` on the Figma origin), each answering only the JSON-RPC methods its
 * profile's fixtures record, as manifest variants (`RPC <origin><path>#<method>`, plus each legacy
 * profile's `GET` row, and the synthetic legacy profile's `RPC <origin><path>#response:ping` row:
 * the client's answer to the recorded server ping).
 *
 * A request is admitted only when it equals a recorded request (`src/mcp/recordings.ts`) within
 * the latitude: the MCP headers (`accept`, `content-type`, `mcp-method`, `mcp-protocol-version`,
 * `mcp-name`, `last-event-id`) equal the recorded values or are absent where the recording has
 * none; `mcp-session-id` is present exactly where recorded; the body has exactly the recorded
 * keys; the id is any JSON-RPC id of the accepted form where one is recorded; and `params` equal
 * the recorded ones except for JSON key order and the `_meta` client info's name and version
 * (and, on the second page of the paged listing, the cursor, checked by issuance). Everything
 * else is refused with a constant reason. The answer is the recorded one with only the request id
 * substituted where the recording carries the recorded request id (the top-level `id` of a JSON
 * answer, or of the SSE response event's payload), the session id (minted, or the request's) in
 * the `mcp-session-id` header, and the cursor of the current generation in `nextCursor`.
 *
 * @experimental
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import type { EmulatorRouteEvidence } from '../route-evidence.ts'
import {
  isJsonObject,
  isNotEmulated,
  notEmulated,
  parseJsonText,
  streamedCommit,
  type Admission,
  type EmulatedRequest,
  type NotEmulated,
  type Planned,
  type StatefulRoute,
  type StreamedAnswer
} from '../stateful-emulator.ts'
import { mcpEmulatorAfloatFixtures } from './afloat-recordings.ts'
import { mcpEmulatorFigmaFixtures } from './figma-recordings.ts'
import {
  mcpEmulatorFixtures,
  mcpEmulatorServerPingFixtures,
  type McpRecordedExchange,
  type McpRecordedFixture,
  type McpRecordedRequest,
  type McpRecordedResponse
} from './recordings.ts'
import {
  mcpEmulatorAfloatOrigin,
  mcpEmulatorAfloatPath,
  mcpEmulatorFigmaOrigin,
  mcpEmulatorFigmaPath,
  mcpEmulatorLegacyPath,
  mcpEmulatorModernPath,
  mcpEmulatorOrigin,
  mcpEmulatorSessionCap,
  mcpEmulatorSessionPrefix,
  type McpEmulatorState,
  type McpRuntime
} from './state.ts'

/** Drill knobs (tests only): each makes the emulator disagree with exactly one case's claim. */
export type McpEmulatorDrills = {
  /** `mcp.negotiation.era` (modern): the discover answer also carries a JSON-RPC error. */
  readonly discoverCarriesErrorResponse?: boolean
  /** `mcp.modern.stateless`: the modern discover result lacks `resultType`. */
  readonly discoverWithoutResultType?: boolean
  /** `mcp.legacy.session`: minted session ids hold a space (not visible ASCII). */
  readonly sessionIdNotVisibleAscii?: boolean
  /** `mcp.transport.response-encoding` (modern): the discover answer holds its response twice. */
  readonly discoverAnsweredTwice?: boolean
  /** `mcp.tools.list`: the listing marks the write tool `readOnlyHint: true`. */
  readonly writeToolMarkedReadOnly?: boolean
  /** `mcp.tools.call-read`: the read call answers `isError: true`. */
  readonly readCallAnswersToolError?: boolean
  /** `mcp.tools.call-tool-error`: invalid arguments answer a JSON-RPC error. */
  readonly invalidCallAnswersRpcError?: boolean
  /** `mcp.errors.unknown-tool`: the absent tool answers a tool result. */
  readonly absentCallAnswersResult?: boolean
  /** `mcp.auth.rejected`: the 401 carries no `WWW-Authenticate` challenge. */
  readonly unauthorizedWithoutChallenge?: boolean
  /** `mcp.legacy.server-ping`: the client's answer to the server ping is refused 400. */
  readonly pingAnswerRejected?: boolean
}

export const mcpEmulatorDrillKnobs: ReadonlyArray<keyof McpEmulatorDrills> = [
  'discoverCarriesErrorResponse',
  'discoverWithoutResultType',
  'sessionIdNotVisibleAscii',
  'discoverAnsweredTwice',
  'writeToolMarkedReadOnly',
  'readCallAnswersToolError',
  'invalidCallAnswersRpcError',
  'absentCallAnswersResult',
  'unauthorizedWithoutChallenge',
  'pingAnswerRejected'
]

export type McpApiEnv = {
  readonly drills: Readonly<Record<keyof McpEmulatorDrills, boolean>>
  /** The digest of the reserved invalid credential on the synthetic origin. */
  readonly reservedDigest: string
  /** The digest of the reserved invalid Afloat credential's remainder on the Afloat origin. */
  readonly afloatReservedDigest: string
  /** The digest of the reserved invalid credential on the Figma origin. */
  readonly figmaReservedDigest: string
  /** Runtime data the commits advance (never in the state). */
  readonly runtime: McpRuntime
}

type McpRoute = StatefulRoute<McpEmulatorState, McpApiEnv>

type RpcId = string | number

type JsonObject = Schema.JsonObject

const fieldOf = (value: Schema.Json | undefined, key: string): Schema.Json | undefined =>
  isJsonObject(value) ? value[key] : undefined

// The recorded exchanges the routes answer, by fixture id and exchange index.

/**
 * Every copied fixture: the synthetic profiles' (the default suite's, then the opt-in server
 * ping's), then the Afloat profile's, then Figma's.
 */
const allFixtures: ReadonlyArray<McpRecordedFixture> = [
  ...mcpEmulatorFixtures,
  ...mcpEmulatorServerPingFixtures,
  ...mcpEmulatorAfloatFixtures,
  ...mcpEmulatorFigmaFixtures
]

const exchangeOf = (fixtureId: string, index: number): McpRecordedExchange => {
  const exchange = allFixtures.find(fixture => fixture.id === fixtureId)?.exchanges.at(index)

  if (exchange === undefined) {
    throw new Error(`the MCP recordings have no exchange ${index} in ${fixtureId}`)
  }

  return exchange
}

const modern = (caseId: string) => `${caseId}.modern.synthetic`

const legacy = (caseId: string) => `${caseId}.legacy.synthetic`

const afloat = (caseId: string) => `${caseId}.afloat.synthetic`

const figma = (caseId: string) => `${caseId}.figma.synthetic`

const recorded = {
  modernDiscover: exchangeOf(modern('mcp.negotiation.era'), 0),
  modernRejected: exchangeOf(modern('mcp.auth.rejected'), 0),
  modernList: exchangeOf(modern('mcp.negotiation.era'), 1),
  modernFirstPage: exchangeOf(modern('mcp.tools.list'), 1),
  modernSecondPage: exchangeOf(modern('mcp.tools.list'), 2),
  modernCallRead: exchangeOf(modern('mcp.tools.call-read'), -1),
  modernCallToolError: exchangeOf(modern('mcp.tools.call-tool-error'), -1),
  modernCallAbsent: exchangeOf(modern('mcp.errors.unknown-tool'), -1),
  legacyDiscover: exchangeOf(legacy('mcp.negotiation.era'), 0),
  legacyRejected: exchangeOf(legacy('mcp.auth.rejected'), 0),
  legacyInitialize: exchangeOf(legacy('mcp.negotiation.era'), 1),
  legacyInitialized: exchangeOf(legacy('mcp.negotiation.era'), 2),
  legacyGet: exchangeOf(legacy('mcp.negotiation.era'), 3),
  legacyList: exchangeOf(legacy('mcp.negotiation.era'), 4),
  legacyCallRead: exchangeOf(legacy('mcp.tools.call-read'), -1),
  legacyCallToolError: exchangeOf(legacy('mcp.tools.call-tool-error'), -1),
  legacyCallAbsent: exchangeOf(legacy('mcp.errors.unknown-tool'), -1),
  legacyPingInitialize: exchangeOf(legacy('mcp.legacy.server-ping'), 1),
  legacyPingAnswer: exchangeOf(legacy('mcp.legacy.server-ping'), 2),
  afloatDiscover: exchangeOf(afloat('mcp.negotiation.era'), 0),
  afloatRejected: exchangeOf(afloat('mcp.auth.rejected'), 0),
  afloatList: exchangeOf(afloat('mcp.negotiation.era'), 1),
  afloatCallRead: exchangeOf(afloat('mcp.tools.call-read'), -1),
  afloatCallToolError: exchangeOf(afloat('mcp.tools.call-tool-error'), -1),
  afloatCallAbsent: exchangeOf(afloat('mcp.errors.unknown-tool'), -1),
  figmaDiscover: exchangeOf(figma('mcp.negotiation.era'), 0),
  figmaRejected: exchangeOf(figma('mcp.auth.rejected'), 0),
  figmaInitialize: exchangeOf(figma('mcp.negotiation.era'), 1),
  figmaInitialized: exchangeOf(figma('mcp.negotiation.era'), 2),
  figmaGet: exchangeOf(figma('mcp.negotiation.era'), 3),
  figmaList: exchangeOf(figma('mcp.negotiation.era'), 4),
  figmaCallRead: exchangeOf(figma('mcp.tools.call-read'), -1),
  figmaCallToolError: exchangeOf(figma('mcp.tools.call-tool-error'), -1),
  figmaCallAbsent: exchangeOf(figma('mcp.errors.unknown-tool'), -1)
}

type RecordedKey = keyof typeof recorded

/** The cursor the paged listing records between its two pages. */
const recordedCursor = (() => {
  const cursor = fieldOf(fieldOf(recorded.modernSecondPage.request.body, 'params'), 'cursor')

  if (!Predicate.isString(cursor)) {
    throw new Error('the paged MCP listing records no cursor')
  }

  return cursor
})()

// The manifest: one row per recorded JSON-RPC method of each profile, plus the GET row.

const casesSending = (
  origin: string,
  path: string,
  sends: (request: McpRecordedRequest) => boolean
) => [
  ...new Set(
    allFixtures.flatMap(fixture =>
      fixture.endpoint === `${origin}${path}` &&
      fixture.exchanges.some(exchange => sends(exchange.request))
        ? [fixture.caseId]
        : []
    )
  )
]

const rpcMethodOf = (request: McpRecordedRequest): string | undefined => {
  const method = fieldOf(request.body, 'method')

  return Predicate.isString(method) ? method : undefined
}

const rpcRow = (origin: string, path: string, method: string): EmulatorRouteEvidence => ({
  method: 'RPC',
  path: `${origin}${path}#${method}`,
  kind: 'connector',
  write: false,
  caseIds: casesSending(
    origin,
    path,
    request => request.method === 'POST' && rpcMethodOf(request) === method
  ),
  evidence: 'unverified'
})

const modernMethods = ['server/discover', 'tools/list', 'tools/call'] as const

const legacyMethods = [
  'server/discover',
  'initialize',
  'notifications/initialized',
  'tools/list',
  'tools/call'
] as const

const modernRows = modernMethods.map(method =>
  rpcRow(mcpEmulatorOrigin, mcpEmulatorModernPath, method)
)

/** Whether a recorded request is a client-sent JSON-RPC response (no `method`, a `result`). */
const isRecordedClientResponse = (request: McpRecordedRequest): boolean =>
  request.method === 'POST' &&
  rpcMethodOf(request) === undefined &&
  isJsonObject(request.body) &&
  ('result' in request.body || 'error' in request.body)

/** The variant name of the client's answer to the recorded server ping. */
const pingAnswerVariant = 'response:ping'

/** The row of the client's answer to the server ping (the synthetic legacy profile only). */
const pingAnswerRow: EmulatorRouteEvidence = {
  method: 'RPC',
  path: `${mcpEmulatorOrigin}${mcpEmulatorLegacyPath}#${pingAnswerVariant}`,
  kind: 'connector',
  write: false,
  caseIds: casesSending(mcpEmulatorOrigin, mcpEmulatorLegacyPath, isRecordedClientResponse),
  evidence: 'unverified'
}

const legacyRows = [
  ...legacyMethods.map(method => rpcRow(mcpEmulatorOrigin, mcpEmulatorLegacyPath, method)),
  pingAnswerRow
]

/** The Afloat profile records the modern methods only (no paging, no session). */
const afloatRows = modernMethods.map(method =>
  rpcRow(mcpEmulatorAfloatOrigin, mcpEmulatorAfloatPath, method)
)

/** The Figma profile records the legacy methods (a handshake, a session, no paging, no ping). */
const figmaRows = legacyMethods.map(method =>
  rpcRow(mcpEmulatorFigmaOrigin, mcpEmulatorFigmaPath, method)
)

/** The `GET` row of a legacy profile: the client's standing event stream. */
const getRowOf = (origin: string, path: string): EmulatorRouteEvidence => ({
  method: 'GET',
  path: `${origin}${path}`,
  kind: 'connector',
  write: false,
  caseIds: casesSending(origin, path, request => request.method === 'GET'),
  evidence: 'unverified'
})

const rowOf = (path: string, method: string, origin: string = mcpEmulatorOrigin): string =>
  `${origin}${path}#${method}`

// Answers: the recorded bytes, with only the request id, session id, and cursor substituted.

const isEventStream = (headers: Readonly<Record<string, string>>): boolean =>
  headers['content-type'] === 'text/event-stream'

/** A recorded answer as status, headers, and chunks (a JSON body is one chunk; none is none). */
const answerOf = (response: McpRecordedResponse): StreamedAnswer => ({
  status: response.status,
  headers: response.headers,
  chunks: 'chunks' in response ? response.chunks : response.body === '' ? [] : [response.body]
})

const isResponseTo = (message: Schema.Json | undefined, id: RpcId): message is JsonObject =>
  isJsonObject(message) && message['id'] === id && ('result' in message || 'error' in message)

const dataPrefix = 'data: '

/**
 * `answer` with the JSON-RPC response to `recordedId` (the top-level message of a JSON answer, or
 * the payload of the SSE event that carries it) replaced by `change` of it; every other chunk,
 * line, and event (notifications, `id:` lines) stays byte for byte.
 */
const mapResponse = (
  answer: StreamedAnswer,
  recordedId: RpcId,
  change: (message: JsonObject) => Schema.Json
): StreamedAnswer => {
  const eventStream = isEventStream(answer.headers)

  const chunks = answer.chunks.map(chunk => {
    if (!eventStream) {
      const message = parseJsonText(chunk)

      return isResponseTo(message, recordedId) ? JSON.stringify(change(message)) : chunk
    }

    return chunk
      .split('\n')
      .map(line => {
        if (!line.startsWith(dataPrefix)) return line

        const message = parseJsonText(line.slice(dataPrefix.length))

        return isResponseTo(message, recordedId)
          ? `${dataPrefix}${JSON.stringify(change(message))}`
          : line
      })
      .join('\n')
  })

  return { ...answer, chunks }
}

const recordedIdOf = (exchange: McpRecordedExchange): RpcId | undefined => {
  const id = fieldOf(exchange.request.body, 'id')

  return Predicate.isString(id) || Predicate.isNumber(id) ? id : undefined
}

/** The recorded answer of `exchange` with the request's id where it carries the recorded id. */
const answerWithId = (exchange: McpRecordedExchange, id: RpcId | undefined): StreamedAnswer => {
  const answer = answerOf(exchange.response)
  const recordedId = recordedIdOf(exchange)

  // The recorded request id stays byte for byte; so does an answer that does not carry it.
  if (recordedId === undefined || id === undefined || id === recordedId) return answer

  return mapResponse(answer, recordedId, message => ({ ...message, id }))
}

/** `answer` with its `mcp-session-id` header (recorded on SSE answers) set to `session`. */
const withSession = (answer: StreamedAnswer, session: string): StreamedAnswer =>
  answer.headers['mcp-session-id'] === undefined
    ? answer
    : { ...answer, headers: { ...answer.headers, 'mcp-session-id': session } }

/** The response message of an answer to `id` with `change` applied to its `result`. */
const mapResult =
  (change: (result: JsonObject) => JsonObject) =>
  (message: JsonObject): JsonObject => {
    const result = message['result']

    return isJsonObject(result) ? { ...message, result: change(result) } : message
  }

/**
 * Where a copied recording is not in the canonical form id substitution relies on: every JSON
 * answer body, and every SSE `data:` payload, must equal `JSON.stringify(JSON.parse(text))`, and
 * every SSE data line must start with `data: `. `makeMcpEmulator` throws on any problem, so a
 * recording copied in another form (escapes such as `\u00e9` or `\/`, numbers such as `1.0`,
 * spacing) fails loudly instead of answering bytes the substitution would rewrite.
 */
export const mcpRecordingProblems = (
  fixtures: ReadonlyArray<McpRecordedFixture>
): ReadonlyArray<string> =>
  fixtures.flatMap(fixture =>
    fixture.exchanges.flatMap(({ response }, index) => {
      const where = `${fixture.id} exchange ${index}`

      const canonical = (text: string) => {
        const parsed = parseJsonText(text)

        return parsed !== undefined && JSON.stringify(parsed) === text
      }

      if (!('chunks' in response)) {
        return response.body === '' || canonical(response.body)
          ? []
          : [`${where}: the JSON body is not canonical`]
      }

      return response.chunks.flatMap((chunk, at) =>
        chunk
          .split('\n')
          .flatMap(line =>
            !line.startsWith('data') ||
            (line.startsWith(dataPrefix) && canonical(line.slice(dataPrefix.length)))
              ? []
              : [`${where} chunk ${at}: an SSE data line is not canonical`]
          )
      )
    })
  )

// Request checks: constant reasons only (the wrapper ledgers refusals as constant entries).

/** The MCP headers compared with the recording (absent where the recording has none). */
const comparedHeaders = [
  'accept',
  'content-type',
  'last-event-id',
  'mcp-method',
  'mcp-name',
  'mcp-protocol-version'
] as const

const sessionHeader = 'mcp-session-id'

/** The `mcp-*` headers a recording carries; any other (such as `mcp-param-*`) is refused. */
const recordedMcpHeaders: ReadonlySet<string> = new Set([
  'mcp-method',
  'mcp-name',
  'mcp-protocol-version',
  sessionHeader
])

/** Refuse an `mcp-*` header no recording carries (fail closed when the names are unknown). */
const unrecordedMcpHeader = (request: EmulatedRequest): NotEmulated | undefined =>
  request.headerNames === undefined ||
  request.headerNames.some(name => name.startsWith('mcp-') && !recordedMcpHeaders.has(name))
    ? notEmulated('an mcp-* header no recording carries is not emulated')
    : undefined

const headerProblem = (
  request: EmulatedRequest,
  recordedRequest: McpRecordedRequest,
  names: ReadonlyArray<string>
): NotEmulated | undefined => {
  for (const name of names) {
    if (request.header(name) !== recordedRequest.headers[name]) {
      return notEmulated(`the ${name} header must be the recorded value, or absent where none is`)
    }
  }

  if (
    (request.header(sessionHeader) === undefined) !==
    (recordedRequest.headers[sessionHeader] === undefined)
  ) {
    return notEmulated('mcp-session-id must be sent exactly where the recording sends one')
  }

  return undefined
}

/**
 * A JSON-RPC request id of the emulated form: an integer from 0 to 2^53 - 1, or 1 to 64 printable
 * ASCII characters.
 */
export const isMcpEmulatedRequestId = (id: Schema.Json | undefined): id is RpcId =>
  (Predicate.isNumber(id) && Number.isSafeInteger(id) && id >= 0) ||
  (Predicate.isString(id) && /^[\x20-\x7E]{1,64}$/.test(id))

/** Structural JSON equality, ignoring object key order. */
const jsonEqual = (left: Schema.Json, right: Schema.Json): boolean => {
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => {
        const other = right[index]

        return other !== undefined && jsonEqual(item, other)
      })
    )
  }

  if (isJsonObject(left)) {
    if (!isJsonObject(right)) return false

    const keys = Object.keys(left)

    return (
      keys.length === Object.keys(right).length &&
      keys.every(key => {
        const value = left[key]
        const other = right[key]

        return (
          Object.hasOwn(right, key) &&
          value !== undefined &&
          other !== undefined &&
          jsonEqual(value, other)
        )
      })
    )
  }

  return left === right
}

const clientInfoKey = 'io.modelcontextprotocol/clientInfo'

const isClientInfo = (value: Schema.Json | undefined): boolean =>
  isJsonObject(value) &&
  Object.keys(value).length === 2 &&
  Predicate.isString(value['name']) &&
  value['name'].length > 0 &&
  Predicate.isString(value['version']) &&
  value['version'].length > 0

/**
 * The request params normalised for comparison with `recordedParams`: the `_meta` client info
 * replaced by the recorded one (when it is any non-empty name and version), and with `cursorFree`
 * the cursor replaced by the recorded one (when it is a string; checked by issuance at plan).
 */
const normalisedParams = (
  params: Schema.Json | undefined,
  recordedParams: JsonObject,
  cursorFree: boolean
): JsonObject | NotEmulated => {
  if (!isJsonObject(params)) return notEmulated('params must be the recorded JSON object')

  const meta = params['_meta']
  const recordedMeta = recordedParams['_meta']
  let normalised: JsonObject = params

  if (isJsonObject(recordedMeta) && recordedMeta[clientInfoKey] !== undefined) {
    if (!isJsonObject(meta) || !isClientInfo(meta[clientInfoKey])) {
      return notEmulated('the _meta client info must be a non-empty name and version only')
    }

    normalised = { ...normalised, _meta: { ...meta, [clientInfoKey]: recordedMeta[clientInfoKey] } }
  }

  if (cursorFree) {
    if (!Predicate.isString(params['cursor'])) {
      return notEmulated('the second page must send the cursor the first page issued')
    }

    normalised = { ...normalised, cursor: recordedCursor }
  }

  return normalised
}

type Matched = {
  readonly key: RecordedKey
  readonly id: RpcId | undefined
  readonly cursor: string | undefined
}

/**
 * The first candidate whose recorded request the JSON-RPC POST equals within the latitude, or
 * not emulated. Every candidate records the same method; candidates differ only in their params
 * and `mcp-name` (the recorded tool calls).
 */
const matchRpc = (
  request: EmulatedRequest,
  candidates: ReadonlyArray<RecordedKey>,
  options: { readonly cursorFree?: boolean } = {}
): Matched | NotEmulated => {
  const [first] = candidates

  if (first === undefined) return notEmulated('this JSON-RPC method is not emulated here')

  const firstRequest = recorded[first].request
  const body = request.json
  const recordedBody = firstRequest.body

  if (!isJsonObject(recordedBody)) return notEmulated('this JSON-RPC method is not emulated here')

  const common =
    unrecordedMcpHeader(request) ??
    headerProblem(
      request,
      firstRequest,
      comparedHeaders.filter(name => name !== 'mcp-name')
    )

  if (common !== undefined) return common

  if (!isJsonObject(body)) {
    return notEmulated('JSON-RPC batches and non-object bodies are not emulated')
  }

  const keys = Object.keys(body)
  const recordedKeys = Object.keys(recordedBody)

  if (keys.length !== recordedKeys.length || keys.some(key => !recordedKeys.includes(key))) {
    return notEmulated('the JSON-RPC message must have exactly the recorded members')
  }

  if (body['jsonrpc'] !== '2.0') return notEmulated('jsonrpc must be "2.0"')

  const id = body['id']

  if ('id' in recordedBody && !isMcpEmulatedRequestId(id)) {
    return notEmulated(
      'the request id must be an integer from 0 to 2^53 - 1 or 1 to 64 printable ASCII characters'
    )
  }

  const cursor = options.cursorFree === true ? fieldOf(body['params'], 'cursor') : undefined

  for (const key of candidates) {
    const candidate = recorded[key].request
    const candidateBody = candidate.body

    if (!isJsonObject(candidateBody)) continue

    if (headerProblem(request, candidate, ['mcp-name']) !== undefined) continue

    const recordedParams = candidateBody['params']

    if (recordedParams !== undefined) {
      const params = isJsonObject(recordedParams)
        ? normalisedParams(body['params'], recordedParams, options.cursorFree === true)
        : notEmulated('params must be the recorded value')

      if (isNotEmulated(params)) return params

      if (!jsonEqual(params, recordedParams)) continue
    }

    return {
      key,
      id: isMcpEmulatedRequestId(id) ? id : undefined,
      cursor: Predicate.isString(cursor) ? cursor : undefined
    }
  }

  return notEmulated('params other than the recorded ones are not emulated')
}

/** Refuse any query parameter (no fixture records one). */
const noQuery = (request: EmulatedRequest): NotEmulated | undefined =>
  request.rawQuery === undefined || request.rawQuery === ''
    ? undefined
    : notEmulated('query parameters are not emulated')

const isReserved = (request: EmulatedRequest, env: McpApiEnv): boolean =>
  request.bearerDigest === env.reservedDigest

const isAfloatReserved = (request: EmulatedRequest, env: McpApiEnv): boolean =>
  request.bearerDigest === env.afloatReservedDigest

const reservedOnlyOnProbe = 'the reserved invalid credential is answered only on the era probe'

// Plans and commits.

type Admitted = Matched & {
  /** The request's `mcp-session-id` (legacy non-handshake requests). */
  readonly session: string | undefined
}

type Plan = (state: McpEmulatorState, admitted: Admitted, env: McpApiEnv) => Planned

const admission = (
  variant: string,
  admitted: Admitted,
  plan: Plan
): Admission<McpEmulatorState, McpApiEnv> => ({
  variant,
  plan: (state, context) => plan(state, admitted, context.env)
})

/** A commit that answers `answer` and writes nothing. */
const answerOnly = (answer: StreamedAnswer): Planned => streamedCommit(answer)

/**
 * A legacy profile: the synthetic legacy server or Figma, each on its own origin and path, with its
 * recorded exchanges, its manifest rows, the digest of its reserved invalid credential, and the
 * mark its sessions carry (a session is answered only on the profile that minted it).
 */
type LegacyProfile = {
  readonly origin: string
  readonly path: string
  /** How refusals name the profile (`the legacy profile`). */
  readonly label: string
  /** The `profile` its sessions carry (absent on the synthetic legacy profile). */
  readonly sessionProfile: 'figma' | undefined
  readonly reserved: (request: EmulatedRequest, env: McpApiEnv) => boolean
  readonly rows: ReadonlyArray<EmulatorRouteEvidence>
  readonly getRow: EmulatorRouteEvidence
  /**
   * The recorded server-ping handshake, when the profile records one: the `initialize` answer that
   * pings (sent under the seed's `legacyInitialize: 'server-ping'`) and the client's answer to it.
   */
  readonly serverPing?: {
    readonly initialize: RecordedKey
    readonly answer: RecordedKey
  }
  readonly keys: {
    readonly discover: RecordedKey
    readonly rejected: RecordedKey
    readonly initialize: RecordedKey
    readonly initialized: RecordedKey
    readonly get: RecordedKey
    readonly list: RecordedKey
    readonly calls: ReadonlyArray<RecordedKey>
  }
}

const sessionOf = (
  state: McpEmulatorState,
  admitted: Admitted,
  phase: 'initializing' | 'ready',
  profile: LegacyProfile
) =>
  state.sessions.find(
    session =>
      session.id === admitted.session &&
      session.phase === phase &&
      session.profile === profile.sessionProfile
  )

const unknownSession = (phase: 'initializing' | 'ready') =>
  notEmulated(
    phase === 'ready'
      ? 'a request on no ready session of this emulator is not emulated'
      : 'notifications/initialized on no initializing session of this emulator is not emulated'
  )

/** The JSON-RPC error the era drill adds to the discover answer (another id: the SDK skips it). */
const drillErrorResponse = JSON.stringify({
  jsonrpc: '2.0',
  id: 'yolk-emu-drill',
  error: { code: -32_603, message: 'Synthetic drill error.' }
})

/** The listed tools that write, which the `writeToolMarkedReadOnly` drill marks read-only. */
const writeToolNames: ReadonlySet<string> = new Set([
  'create_synthetic_note',
  'create-receipt-upload',
  'use_figma'
])

/** Drill transforms of an answer, by the recorded exchange it answers. */
const drilled = (key: RecordedKey, answer: StreamedAnswer, id: RpcId, env: McpApiEnv) => {
  const drills = env.drills

  switch (key) {
    case 'modernDiscover':
    case 'afloatDiscover': {
      let next = answer

      if (drills.discoverWithoutResultType) {
        next = mapResponse(
          next,
          id,
          mapResult(({ resultType: _resultType, ...result }) => result)
        )
      }

      if (drills.discoverCarriesErrorResponse) {
        next = {
          ...next,
          chunks: next.chunks.map(chunk => `[${drillErrorResponse},${chunk}]`)
        }
      }

      if (drills.discoverAnsweredTwice) {
        next = {
          ...next,
          headers: { ...next.headers, 'content-type': 'text/event-stream' },
          chunks: next.chunks.flatMap(chunk => [
            `event: message\ndata: ${chunk}\n\n`,
            `event: message\ndata: ${chunk}\n\n`
          ])
        }
      }

      return next
    }

    case 'modernList':
    case 'modernFirstPage':
    case 'modernSecondPage':
    case 'legacyList':
    case 'afloatList':
    case 'figmaList':
      return drills.writeToolMarkedReadOnly
        ? mapResponse(
            answer,
            id,
            mapResult(result => {
              const tools = result['tools']

              return Array.isArray(tools)
                ? {
                    ...result,
                    tools: tools.map(tool =>
                      isJsonObject(tool) && writeToolNames.has(String(tool['name']))
                        ? { ...tool, annotations: { readOnlyHint: true } }
                        : tool
                    )
                  }
                : result
            })
          )
        : answer

    case 'modernCallRead':
    case 'legacyCallRead':
    case 'afloatCallRead':
    case 'figmaCallRead':
      return drills.readCallAnswersToolError
        ? mapResponse(
            answer,
            id,
            mapResult(result => ({ ...result, isError: true }))
          )
        : answer

    case 'modernCallToolError':
    case 'legacyCallToolError':
    case 'afloatCallToolError':
    case 'figmaCallToolError':
      return drills.invalidCallAnswersRpcError
        ? mapResponse(answer, id, () => ({
            jsonrpc: '2.0',
            id,
            error: { code: -32_602, message: 'Synthetic drill: invalid arguments.' }
          }))
        : answer

    case 'modernCallAbsent':
    case 'legacyCallAbsent':
    case 'afloatCallAbsent':
    case 'figmaCallAbsent': {
      if (!drills.absentCallAnswersResult) return answer

      const result: JsonObject = {
        content: [{ type: 'text', text: 'Synthetic drill result.' }],
        isError: true
      }

      return mapResponse({ ...answer, status: 200 }, id, () => ({
        jsonrpc: '2.0',
        id,
        // A legacy result carries no `resultType`.
        result:
          key === 'legacyCallAbsent' || key === 'figmaCallAbsent'
            ? result
            : { ...result, resultType: 'complete' }
      }))
    }

    case 'legacyPingAnswer':
      return drills.pingAnswerRejected ? { status: 400, headers: {}, chunks: [] } : answer

    case 'modernRejected':
    case 'legacyRejected':
    case 'afloatRejected':
    case 'figmaRejected': {
      if (!drills.unauthorizedWithoutChallenge) return answer

      const { 'www-authenticate': _challenge, ...headers } = answer.headers

      return { ...answer, headers }
    }

    default:
      return answer
  }
}

/** The id the answer's response carries: the request's (substituted), else the recorded one. */
const responseIdOf = (key: RecordedKey, id: RpcId | undefined): RpcId | undefined =>
  id ?? recordedIdOf(recorded[key])

/** The recorded answer for `key`, with the request id substituted and any drill applied. */
const recordedAnswer = (key: RecordedKey, id: RpcId | undefined, env: McpApiEnv) => {
  const answer = answerWithId(recorded[key], id)
  const responseId = responseIdOf(key, id)

  return responseId === undefined ? answer : drilled(key, answer, responseId, env)
}

/** The cursor value issued in the current generation (the recorded one in its first). */
const cursorFor = (runtime: McpRuntime): string =>
  (runtime.cursorFirstGeneration ?? runtime.generation) === runtime.generation
    ? recordedCursor
    : `${recordedCursor}.g${runtime.generation}`

const planModernList: Plan = (state, admitted, env) => {
  if (state.modernListing === 'one-page') {
    return answerOnly(recordedAnswer('modernList', admitted.id, env))
  }

  const cursor = cursorFor(env.runtime)
  const recordedPage = recordedAnswer('modernFirstPage', admitted.id, env)
  const responseId = responseIdOf('modernFirstPage', admitted.id)

  // The recorded bytes in the generation that first issues the cursor; a minted cursor after it.
  const sent =
    cursor === recordedCursor || responseId === undefined
      ? recordedPage
      : mapResponse(
          recordedPage,
          responseId,
          mapResult(result => ({ ...result, nextCursor: cursor }))
        )

  // The cursor is issued only by the commit, so a faulted or truncated first page issues none.
  return streamedCommit(sent, () => {
    env.runtime.cursorFirstGeneration ??= env.runtime.generation
    env.runtime.issuedCursor = cursor
  }, [cursor])
}

const planModernSecondPage: Plan = (state, admitted, env) =>
  state.modernListing === 'two-pages' &&
  env.runtime.issuedCursor !== undefined &&
  admitted.cursor === env.runtime.issuedCursor
    ? answerOnly(recordedAnswer('modernSecondPage', admitted.id, env))
    : notEmulated(
        'a cursor this emulator did not issue since the last reset or seed is not emulated'
      )

const planInitialize =
  (profile: LegacyProfile): Plan =>
  (state, admitted, env) => {
    const number = env.runtime.nextSession

    if (state.sessions.length >= mcpEmulatorSessionCap || !Number.isSafeInteger(number + 1)) {
      return notEmulated('the emulator holds as many sessions as it takes')
    }

    const session = env.drills.sessionIdNotVisibleAscii
      ? `yolk-emu-session ${number}`
      : `${mcpEmulatorSessionPrefix}${number}`

    // The seed picks the recorded answer that pings, where the profile records one.
    const key =
      profile.serverPing !== undefined && state.legacyInitialize === 'server-ping'
        ? profile.serverPing.initialize
        : undefined

    const answer = withSession(
      recordedAnswer(key ?? profile.keys.initialize, admitted.id, env),
      session
    )

    const plain =
      profile.sessionProfile === undefined
        ? { id: session, phase: 'initializing' as const }
        : { id: session, phase: 'initializing' as const, profile: profile.sessionProfile }

    const minted = key === undefined ? plain : { ...plain, awaitingPingAnswer: true as const }

    // The session is minted only by the commit, so a faulted or truncated `initialize` holds none
    // and leaves the counter where it was.
    return streamedCommit(answer, () => {
      env.runtime.nextSession = number + 1
      state.sessions = [...state.sessions, minted]
    }, [session])
  }

const planInitialized =
  (profile: LegacyProfile): Plan =>
  (state, admitted, env) => {
    const session = sessionOf(state, admitted, 'initializing', profile)

    if (session === undefined) return unknownSession('initializing')

    const answer = recordedAnswer(profile.keys.initialized, undefined, env)

    return streamedCommit(answer, () => {
      state.sessions = state.sessions.map(held =>
        held.id === session.id ? { ...held, phase: 'ready' } : held
      )
    })
  }

/** A legacy answer on a ready session of `profile`: the recorded answer with the session's id. */
const planOnSession =
  (profile: LegacyProfile, key: RecordedKey): Plan =>
  (state, admitted, env) => {
    const session = sessionOf(state, admitted, 'ready', profile)

    return session === undefined
      ? unknownSession('ready')
      : answerOnly(withSession(recordedAnswer(key, admitted.id, env), session.id))
  }

/**
 * The client's answer to the recorded server ping, on a session of `profile` that awaits it (in
 * either phase: the client answers before `notifications/initialized`, but a loopback server may
 * see the two in either order): the recorded 202, and the commit clears the mark, so a second
 * answer is refused.
 */
const planPingAnswer =
  (profile: LegacyProfile, key: RecordedKey): Plan =>
  (state, admitted, env) => {
    const session = state.sessions.find(
      held =>
        held.id === admitted.session &&
        held.profile === profile.sessionProfile &&
        held.awaitingPingAnswer === true
    )

    if (session === undefined) {
      return notEmulated('an answer to no server ping this emulator awaits is not emulated')
    }

    const answer = recordedAnswer(key, undefined, env)

    // The drill refuses the answer: the session still awaits it.
    if (env.drills.pingAnswerRejected) return answerOnly(answer)

    return streamedCommit(answer, () => {
      state.sessions = state.sessions.map(held => {
        if (held.id !== session.id) return held

        const { awaitingPingAnswer: _answered, ...rest } = held

        return rest
      })
    })
  }

/**
 * The client's answer to the recorded server ping: exactly the recorded request (the MCP headers,
 * the session header, the members, `jsonrpc`, the server's ping id byte for byte, and the result),
 * or not emulated. The id is the server's, so the request-id latitude does not apply.
 */
const matchPingAnswer = (request: EmulatedRequest, key: RecordedKey): Matched | NotEmulated => {
  const recordedRequest = recorded[key].request
  const recordedBody = recordedRequest.body
  const body = request.json

  const problem =
    unrecordedMcpHeader(request) ?? headerProblem(request, recordedRequest, comparedHeaders)

  if (problem !== undefined) return problem

  if (!isJsonObject(body) || !isJsonObject(recordedBody)) {
    return notEmulated('JSON-RPC batches and non-object bodies are not emulated')
  }

  const keys = Object.keys(body)
  const recordedKeys = Object.keys(recordedBody)

  if (keys.length !== recordedKeys.length || keys.some(name => !recordedKeys.includes(name))) {
    return notEmulated('the JSON-RPC message must have exactly the recorded members')
  }

  if (!jsonEqual(body, recordedBody)) {
    return notEmulated(
      'a client response other than the recorded answer to the server ping is not emulated'
    )
  }

  return { key, id: undefined, cursor: undefined }
}

const planAnswer =
  (key: RecordedKey): Plan =>
  (_state, admitted, env) =>
    answerOnly(recordedAnswer(key, admitted.id, env))

// Routes.

const routeEvidenceOf = (
  method: string,
  path: string,
  variants: ReadonlyArray<EmulatorRouteEvidence>,
  origin: string = mcpEmulatorOrigin
) => ({
  method,
  path,
  kind: 'connector' as const,
  write: false,
  caseIds: [...new Set(variants.flatMap(variant => variant.caseIds))],
  evidence: 'unverified' as const,
  origin,
  variants
})

const admitted = (matched: Matched, request: EmulatedRequest): Admitted => ({
  ...matched,
  session: request.header(sessionHeader)
})

/** `POST /modern/mcp`: the stateless synthetic server (JSON answers, no session). */
const modernRoute: McpRoute = {
  ...routeEvidenceOf('POST', mcpEmulatorModernPath, modernRows),
  body: 'json',
  admit: (request, env) => {
    const query = noQuery(request)

    if (query !== undefined) return query

    const method = fieldOf(request.json, 'method')
    const variant = (name: string) => rowOf(mcpEmulatorModernPath, name)

    if (method === 'server/discover') {
      const matched = matchRpc(request, ['modernDiscover'])

      if (isNotEmulated(matched)) return matched

      return isReserved(request, env)
        ? admission(variant(method), admitted(matched, request), planAnswer('modernRejected'))
        : admission(variant(method), admitted(matched, request), planAnswer('modernDiscover'))
    }

    if (isReserved(request, env)) return notEmulated(reservedOnlyOnProbe)

    if (method === 'tools/list') {
      const paged = fieldOf(fieldOf(request.json, 'params'), 'cursor') !== undefined

      const matched = paged
        ? matchRpc(request, ['modernSecondPage'], { cursorFree: true })
        : matchRpc(request, ['modernList'])

      if (isNotEmulated(matched)) return matched

      return admission(
        variant(method),
        admitted(matched, request),
        paged ? planModernSecondPage : planModernList
      )
    }

    if (method === 'tools/call') {
      const matched = matchRpc(request, [
        'modernCallRead',
        'modernCallToolError',
        'modernCallAbsent'
      ])

      if (isNotEmulated(matched)) return matched

      return admission(variant(method), admitted(matched, request), planAnswer(matched.key))
    }

    return notEmulated('this JSON-RPC method is not emulated on the modern profile')
  }
}

/** `POST <path>` of a legacy profile: the initialize-based server (SSE answers, sessions). */
const legacyPostRoute = (profile: LegacyProfile): McpRoute => ({
  ...routeEvidenceOf('POST', profile.path, profile.rows, profile.origin),
  body: 'json',
  admit: (request, env) => {
    const query = noQuery(request)

    if (query !== undefined) return query

    const method = fieldOf(request.json, 'method')
    const variant = (name: string) => rowOf(profile.path, name, profile.origin)

    if (method === 'server/discover') {
      const matched = matchRpc(request, [profile.keys.discover])

      if (isNotEmulated(matched)) return matched

      return profile.reserved(request, env)
        ? admission(variant(method), admitted(matched, request), planAnswer(profile.keys.rejected))
        : admission(variant(method), admitted(matched, request), planAnswer(profile.keys.discover))
    }

    if (profile.reserved(request, env)) return notEmulated(reservedOnlyOnProbe)

    const single = (key: RecordedKey, name: string, plan: Plan) => {
      const matched = matchRpc(request, [key])

      return isNotEmulated(matched)
        ? matched
        : admission(variant(name), admitted(matched, request), plan)
    }

    if (method === 'initialize') {
      return single(profile.keys.initialize, method, planInitialize(profile))
    }

    if (method === 'notifications/initialized') {
      return single(profile.keys.initialized, method, planInitialized(profile))
    }

    if (method === 'tools/list') {
      return single(profile.keys.list, method, planOnSession(profile, profile.keys.list))
    }

    if (method === 'tools/call') {
      const matched = matchRpc(request, profile.keys.calls)

      if (isNotEmulated(matched)) return matched

      return admission(
        variant(method),
        admitted(matched, request),
        planOnSession(profile, matched.key)
      )
    }

    // A client-sent response: only the recorded answer to the server ping, where one is recorded.
    if (
      method === undefined &&
      profile.serverPing !== undefined &&
      isJsonObject(request.json) &&
      !('method' in request.json)
    ) {
      const matched = matchPingAnswer(request, profile.serverPing.answer)

      if (isNotEmulated(matched)) return matched

      return admission(
        variant(pingAnswerVariant),
        admitted(matched, request),
        planPingAnswer(profile, matched.key)
      )
    }

    return notEmulated(`this JSON-RPC method is not emulated on ${profile.label}`)
  }
})

/** `GET <path>` of a legacy profile: the client's standing event stream, answered the 405. */
const legacyGetRoute = (profile: LegacyProfile): McpRoute => ({
  ...routeEvidenceOf('GET', profile.path, [profile.getRow], profile.origin),
  body: 'none',
  admit: (request, env) => {
    const query = noQuery(request)

    if (query !== undefined) return query

    if (profile.reserved(request, env)) return notEmulated(reservedOnlyOnProbe)

    const problem =
      unrecordedMcpHeader(request) ??
      headerProblem(request, recorded[profile.keys.get].request, comparedHeaders)

    if (problem !== undefined) return problem

    return admission(
      profile.getRow.path,
      {
        key: profile.keys.get,
        id: undefined,
        cursor: undefined,
        session: request.header(sessionHeader)
      },
      planOnSession(profile, profile.keys.get)
    )
  }
})

/** The synthetic legacy server on `https://mcp.example.test/legacy/mcp`. */
const syntheticLegacyProfile: LegacyProfile = {
  origin: mcpEmulatorOrigin,
  path: mcpEmulatorLegacyPath,
  label: 'the legacy profile',
  sessionProfile: undefined,
  reserved: isReserved,
  rows: legacyRows,
  getRow: getRowOf(mcpEmulatorOrigin, mcpEmulatorLegacyPath),
  serverPing: { initialize: 'legacyPingInitialize', answer: 'legacyPingAnswer' },
  keys: {
    discover: 'legacyDiscover',
    rejected: 'legacyRejected',
    initialize: 'legacyInitialize',
    initialized: 'legacyInitialized',
    get: 'legacyGet',
    list: 'legacyList',
    calls: ['legacyCallRead', 'legacyCallToolError', 'legacyCallAbsent']
  }
}

/**
 * The Figma profile on the provider endpoint `https://mcp.figma.com/mcp` (the legacy era: a
 * handshake, sessions bound to this profile, SSE answers). Its bearer follows the plain rule, and
 * its reserved invalid credential is the public MCP one, compared through the digest for the Figma
 * origin.
 */
const figmaProfile: LegacyProfile = {
  origin: mcpEmulatorFigmaOrigin,
  path: mcpEmulatorFigmaPath,
  label: 'the Figma profile',
  sessionProfile: 'figma',
  reserved: (request, env) => request.bearerDigest === env.figmaReservedDigest,
  rows: figmaRows,
  getRow: getRowOf(mcpEmulatorFigmaOrigin, mcpEmulatorFigmaPath),
  keys: {
    discover: 'figmaDiscover',
    rejected: 'figmaRejected',
    initialize: 'figmaInitialize',
    initialized: 'figmaInitialized',
    get: 'figmaGet',
    list: 'figmaList',
    calls: ['figmaCallRead', 'figmaCallToolError', 'figmaCallAbsent']
  }
}

/**
 * `POST /mcp` on the Afloat origin: the Afloat profile (stateless `2026-07-28`, JSON answers, no
 * session, one listing page). Its bearer is `afloat_<remainder>` (the wrapper's `bearerPrefixes`),
 * so routes see the digest of the remainder.
 */
const afloatRoute: McpRoute = {
  ...routeEvidenceOf('POST', mcpEmulatorAfloatPath, afloatRows, mcpEmulatorAfloatOrigin),
  body: 'json',
  admit: (request, env) => {
    const query = noQuery(request)

    if (query !== undefined) return query

    const method = fieldOf(request.json, 'method')
    const variant = (name: string) => rowOf(mcpEmulatorAfloatPath, name, mcpEmulatorAfloatOrigin)

    if (method === 'server/discover') {
      const matched = matchRpc(request, ['afloatDiscover'])

      if (isNotEmulated(matched)) return matched

      return isAfloatReserved(request, env)
        ? admission(variant(method), admitted(matched, request), planAnswer('afloatRejected'))
        : admission(variant(method), admitted(matched, request), planAnswer('afloatDiscover'))
    }

    if (isAfloatReserved(request, env)) return notEmulated(reservedOnlyOnProbe)

    if (method === 'tools/list') {
      const matched = matchRpc(request, ['afloatList'])

      return isNotEmulated(matched)
        ? matched
        : admission(variant(method), admitted(matched, request), planAnswer('afloatList'))
    }

    if (method === 'tools/call') {
      const matched = matchRpc(request, [
        'afloatCallRead',
        'afloatCallToolError',
        'afloatCallAbsent'
      ])

      if (isNotEmulated(matched)) return matched

      return admission(variant(method), admitted(matched, request), planAnswer(matched.key))
    }

    return notEmulated('this JSON-RPC method is not emulated on the Afloat profile')
  }
}

/** The route table: one wire route per recorded HTTP shape, each with its manifest variants. */
export const mcpApiRoutes: ReadonlyArray<McpRoute> = [
  modernRoute,
  legacyPostRoute(syntheticLegacyProfile),
  legacyGetRoute(syntheticLegacyProfile),
  afloatRoute,
  legacyPostRoute(figmaProfile),
  legacyGetRoute(figmaProfile)
]
