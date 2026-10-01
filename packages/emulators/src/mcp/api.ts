/**
 * MCP emulator route table (internal): one wire route per recorded HTTP shape (`POST /modern/mcp`,
 * `POST /legacy/mcp`, `GET /legacy/mcp`), each answering only the JSON-RPC methods its profile's
 * fixtures record, as manifest variants (`RPC <origin><path>#<method>`, plus the `GET` row).
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
import {
  mcpEmulatorFixtures,
  type McpRecordedExchange,
  type McpRecordedFixture,
  type McpRecordedRequest,
  type McpRecordedResponse
} from './recordings.ts'
import {
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
  'unauthorizedWithoutChallenge'
]

export type McpApiEnv = {
  readonly drills: Readonly<Record<keyof McpEmulatorDrills, boolean>>
  /** The digest of the reserved invalid credential on the emulated origin. */
  readonly reservedDigest: string
  /** Runtime data the commits advance (never in the state). */
  readonly runtime: McpRuntime
}

type McpRoute = StatefulRoute<McpEmulatorState, McpApiEnv>

type RpcId = string | number

type JsonObject = Schema.JsonObject

const fieldOf = (value: Schema.Json | undefined, key: string): Schema.Json | undefined =>
  isJsonObject(value) ? value[key] : undefined

// The recorded exchanges the routes answer, by fixture id and exchange index.

const exchangeOf = (fixtureId: string, index: number): McpRecordedExchange => {
  const exchange = mcpEmulatorFixtures
    .find(fixture => fixture.id === fixtureId)
    ?.exchanges.at(index)

  if (exchange === undefined) {
    throw new Error(`the MCP recordings have no exchange ${index} in ${fixtureId}`)
  }

  return exchange
}

const modern = (caseId: string) => `${caseId}.modern.synthetic`

const legacy = (caseId: string) => `${caseId}.legacy.synthetic`

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
  legacyCallAbsent: exchangeOf(legacy('mcp.errors.unknown-tool'), -1)
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

const casesSending = (path: string, sends: (request: McpRecordedRequest) => boolean) => [
  ...new Set(
    mcpEmulatorFixtures.flatMap(fixture =>
      fixture.endpoint === `${mcpEmulatorOrigin}${path}` &&
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

const rpcRow = (path: string, method: string): EmulatorRouteEvidence => ({
  method: 'RPC',
  path: `${mcpEmulatorOrigin}${path}#${method}`,
  kind: 'connector',
  write: false,
  caseIds: casesSending(
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

const modernRows = modernMethods.map(method => rpcRow(mcpEmulatorModernPath, method))

const legacyRows = legacyMethods.map(method => rpcRow(mcpEmulatorLegacyPath, method))

const getRow: EmulatorRouteEvidence = {
  method: 'GET',
  path: `${mcpEmulatorOrigin}${mcpEmulatorLegacyPath}`,
  kind: 'connector',
  write: false,
  caseIds: casesSending(mcpEmulatorLegacyPath, request => request.method === 'GET'),
  evidence: 'unverified'
}

const rowOf = (path: string, method: string): string => `${mcpEmulatorOrigin}${path}#${method}`

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

const sessionOf = (state: McpEmulatorState, admitted: Admitted, phase: 'initializing' | 'ready') =>
  state.sessions.find(session => session.id === admitted.session && session.phase === phase)

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

/** Drill transforms of an answer, by the recorded exchange it answers. */
const drilled = (key: RecordedKey, answer: StreamedAnswer, id: RpcId, env: McpApiEnv) => {
  const drills = env.drills

  switch (key) {
    case 'modernDiscover': {
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
                      isJsonObject(tool) && tool['name'] === 'create_synthetic_note'
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
      return drills.readCallAnswersToolError
        ? mapResponse(
            answer,
            id,
            mapResult(result => ({ ...result, isError: true }))
          )
        : answer

    case 'modernCallToolError':
    case 'legacyCallToolError':
      return drills.invalidCallAnswersRpcError
        ? mapResponse(answer, id, () => ({
            jsonrpc: '2.0',
            id,
            error: { code: -32_602, message: 'Invalid arguments: noteId must be a string.' }
          }))
        : answer

    case 'modernCallAbsent':
    case 'legacyCallAbsent': {
      if (!drills.absentCallAnswersResult) return answer

      const result: JsonObject = {
        content: [{ type: 'text', text: 'Synthetic drill result.' }],
        isError: true
      }

      return mapResponse({ ...answer, status: 200 }, id, () => ({
        jsonrpc: '2.0',
        id,
        result: key === 'modernCallAbsent' ? { ...result, resultType: 'complete' } : result
      }))
    }

    case 'modernRejected':
    case 'legacyRejected': {
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

const planInitialize: Plan = (state, admitted, env) => {
  const number = env.runtime.nextSession

  if (state.sessions.length >= mcpEmulatorSessionCap || !Number.isSafeInteger(number + 1)) {
    return notEmulated('the emulator holds as many sessions as it takes')
  }

  const session = env.drills.sessionIdNotVisibleAscii
    ? `yolk-emu-session ${number}`
    : `${mcpEmulatorSessionPrefix}${number}`

  const answer = withSession(recordedAnswer('legacyInitialize', admitted.id, env), session)

  // The session is minted only by the commit, so a faulted or truncated `initialize` holds none
  // and leaves the counter where it was.
  return streamedCommit(answer, () => {
    env.runtime.nextSession = number + 1
    state.sessions = [...state.sessions, { id: session, phase: 'initializing' }]
  }, [session])
}

const planInitialized: Plan = (state, admitted, env) => {
  const session = sessionOf(state, admitted, 'initializing')

  if (session === undefined) return unknownSession('initializing')

  const answer = recordedAnswer('legacyInitialized', undefined, env)

  return streamedCommit(answer, () => {
    state.sessions = state.sessions.map(held =>
      held.id === session.id ? { id: held.id, phase: 'ready' } : held
    )
  })
}

/** A legacy answer on a ready session: the recorded answer with the session's id. */
const planOnSession =
  (key: RecordedKey): Plan =>
  (state, admitted, env) => {
    const session = sessionOf(state, admitted, 'ready')

    return session === undefined
      ? unknownSession('ready')
      : answerOnly(withSession(recordedAnswer(key, admitted.id, env), session.id))
  }

const planAnswer =
  (key: RecordedKey): Plan =>
  (_state, admitted, env) =>
    answerOnly(recordedAnswer(key, admitted.id, env))

// Routes.

const routeEvidenceOf = (
  method: string,
  path: string,
  variants: ReadonlyArray<EmulatorRouteEvidence>
) => ({
  method,
  path,
  kind: 'connector' as const,
  write: false,
  caseIds: [...new Set(variants.flatMap(variant => variant.caseIds))],
  evidence: 'unverified' as const,
  origin: mcpEmulatorOrigin,
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

/** `POST /legacy/mcp`: the initialize-based synthetic server (SSE answers, sessions). */
const legacyRoute: McpRoute = {
  ...routeEvidenceOf('POST', mcpEmulatorLegacyPath, legacyRows),
  body: 'json',
  admit: (request, env) => {
    const query = noQuery(request)

    if (query !== undefined) return query

    const method = fieldOf(request.json, 'method')
    const variant = (name: string) => rowOf(mcpEmulatorLegacyPath, name)

    if (method === 'server/discover') {
      const matched = matchRpc(request, ['legacyDiscover'])

      if (isNotEmulated(matched)) return matched

      return isReserved(request, env)
        ? admission(variant(method), admitted(matched, request), planAnswer('legacyRejected'))
        : admission(variant(method), admitted(matched, request), planAnswer('legacyDiscover'))
    }

    if (isReserved(request, env)) return notEmulated(reservedOnlyOnProbe)

    const single = (key: RecordedKey, name: string, plan: Plan) => {
      const matched = matchRpc(request, [key])

      return isNotEmulated(matched)
        ? matched
        : admission(variant(name), admitted(matched, request), plan)
    }

    if (method === 'initialize') return single('legacyInitialize', method, planInitialize)

    if (method === 'notifications/initialized') {
      return single('legacyInitialized', method, planInitialized)
    }

    if (method === 'tools/list') return single('legacyList', method, planOnSession('legacyList'))

    if (method === 'tools/call') {
      const matched = matchRpc(request, [
        'legacyCallRead',
        'legacyCallToolError',
        'legacyCallAbsent'
      ])

      if (isNotEmulated(matched)) return matched

      return admission(variant(method), admitted(matched, request), planOnSession(matched.key))
    }

    return notEmulated('this JSON-RPC method is not emulated on the legacy profile')
  }
}

/** `GET /legacy/mcp`: the client's standing event stream, answered the recorded 405. */
const legacyGetRoute: McpRoute = {
  ...routeEvidenceOf('GET', mcpEmulatorLegacyPath, [getRow]),
  body: 'none',
  admit: (request, env) => {
    const query = noQuery(request)

    if (query !== undefined) return query

    if (isReserved(request, env)) return notEmulated(reservedOnlyOnProbe)

    const problem =
      unrecordedMcpHeader(request) ??
      headerProblem(request, recorded.legacyGet.request, comparedHeaders)

    if (problem !== undefined) return problem

    return admission(
      getRow.path,
      {
        key: 'legacyGet',
        id: undefined,
        cursor: undefined,
        session: request.header(sessionHeader)
      },
      planOnSession('legacyGet')
    )
  }
}

/** The route table: one wire route per recorded HTTP shape, each with its manifest variants. */
export const mcpApiRoutes: ReadonlyArray<McpRoute> = [modernRoute, legacyRoute, legacyGetRoute]
