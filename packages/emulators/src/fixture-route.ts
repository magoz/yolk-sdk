/**
 * Fixture-only route core (internal; not a package export).
 *
 * The owner rule for every route added after the model-route emulators (the four OpenCode Go
 * routes and the Claude, Codex, and Grok subscription-usage routes): response behaviour comes only
 * from the committed conformance fixtures.
 *
 * - A request that matches a recorded request's shape (within the documented request-shape
 *   latitude below) gets that recording's response, copied as data (`*-recordings.ts`; never an
 *   SDK import).
 * - Everything else answers one ledgered 400 not-emulated: unknown routes, other methods, missing
 *   or invalid credentials, missing or other headers and query parameters, unknown models, other
 *   request shapes (non-streamed modes, tools, reasoning, other message kinds, extra fields).
 * - Test controls, as far as the other emulators allow them: the shared kernel faults (`status`,
 *   `error-after-chunks`, `truncate-after-chunks`) and scripted error turns; a route with a
 *   replaceable JSON body (the usage routes) also takes a scripted `{ usage }` body (or a default
 *   override) whose JSON shape (object keys and value kinds) equals the recording's. Fault and
 *   scripted-error statuses must be 400-599, so no control can produce a success status or
 *   a body other than the recorded one (or a prefix of it cut by the truncation faults).
 *
 * Request-shape latitude (accepted, harmless): any credential value (never checked or stored);
 * extra request headers; key order; every string value except the discriminators `model`, `role`,
 * `type`, and `phase` (which must equal the recording); any positive integer where the recording
 * has a number (the output-token limit). Array lengths, object keys, booleans (`stream`, `store`,
 * `include_usage`, `parallel_tool_calls`, `additionalProperties`), the recorded `accept` value,
 * the `content-type` media type, and the query string (exactly, byte for byte; a bare `?` counts as no query) must equal the
 * recording. Route-specific header values (for example Grok's `x-grok-client-version`) are
 * documented by the route that declares them.
 *
 * Runtime-portable Web APIs only; no Node builtins and no SDK imports.
 */
import { Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import {
  EmulatorErrorAfterChunksFault,
  EmulatorScriptedError,
  EmulatorStatusFault,
  EmulatorTruncateAfterChunksFault,
  isJsonObject,
  jsonResponse,
  makeEmulatorKernel,
  parseJson,
  readText,
  stringField,
  type EmulatorApi,
  type KernelLedgerEntry
} from './emulator-kernel.ts'
import {
  emulatorRouteKey,
  type EmulatorEvidence,
  type EmulatorRouteEvidence
} from './route-evidence.ts'

/** One committed fixture exchange, copied as data. */
export type FixtureRecording = {
  readonly fixtureId: string
  readonly caseId: string
  readonly request: {
    readonly method: string
    readonly path: string
    /** The recorded query string (with `?`), or empty. */
    readonly query: string
    /** The recorded (non-credential) request headers, lower-case. */
    readonly headers: Readonly<Record<string, string>>
    readonly body?: Schema.Json
  }
  readonly response: {
    readonly status: number
    readonly headers: Readonly<Record<string, string>>
    /** Whether the fixture recorded network chunks (a stream) or one body. */
    readonly streamed: boolean
    /** Network chunks as recorded; a body is one chunk. */
    readonly chunks: ReadonlyArray<string>
  }
}

// Fault and scripted-error statuses on fixture-only routes: errors only (400-599), so no control
// answers a success that no fixture records. One range check, so a rejection names the range
// actually accepted (400-599 holds no 204, 205, or 3xx, which the shared schema excludes).
const FixtureRouteErrorStatus = Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 }))

const FixtureRouteStatusFault = Schema.Struct({
  ...EmulatorStatusFault.fields,
  status: FixtureRouteErrorStatus
})

const FixtureRouteScriptedError = Schema.Struct({
  error: Schema.Struct({
    ...EmulatorScriptedError.fields.error.fields,
    status: FixtureRouteErrorStatus
  })
})

/**
 * Faults: the shared kernel kinds only, with `status` limited to 400-599. `status` without a
 * `body` answers an emulator-fault body (`{ error: { type: 'emulator_fault', message } }`), never
 * a guessed provider envelope.
 */
export const FixtureRouteFault = Schema.Union([
  FixtureRouteStatusFault,
  EmulatorErrorAfterChunksFault,
  EmulatorTruncateAfterChunksFault
])

export type FixtureRouteFault = typeof FixtureRouteFault.Type

export type FixtureRouteFaultKind = FixtureRouteFault['kind']

/** A scripted replacement body (replaceable-body routes only), shape-checked against the recording. */
export type FixtureRouteScriptedBody = { readonly usage: Schema.Json }

/** A scripted turn: an error response, or (replaceable-body routes only) a replacement body. */
export type FixtureRouteScriptedTurn = EmulatorScriptedError | FixtureRouteScriptedBody

export type FixtureRouteLedgerEntry = {
  /** 1-based arrival order since the last ledger clear or reset. */
  readonly seq: number
  readonly method: string
  readonly path: string
  /** The request's query string (with `?`), when it has one. */
  readonly query?: string
  /** Parsed JSON request body, when it was valid JSON. */
  readonly body?: Schema.Json
  readonly model?: string
  /** Which credential header carried a non-empty value (the value is never recorded). */
  readonly credentialHeader?: 'authorization' | 'x-api-key'
  /** Values of the non-credential headers the route records (lower-case names). */
  readonly headers: Readonly<Record<string, string>>
  /** The fixture id whose recorded response answered the request. */
  readonly recording?: string
  /** Why the request was answered 400 not-emulated. */
  readonly notEmulated?: string
  /** Kind of the fault that shaped the response. */
  readonly fault?: FixtureRouteFaultKind
  /** Why a matching fault could not take effect (the response was a 500 emulator error). */
  readonly faultError?: string
  /** Set when the emulator could not build the planned response (answered 500). */
  readonly responseError?: string
  /** Set when a scripted turn answered the request. */
  readonly scripted?: 'usage' | 'error'
  /** Evidence of the matched route; `unknown-route` for requests on no route. */
  readonly evidence: EmulatorEvidence | 'unknown-route'
  readonly status: number
  /** Body chunks handed to the transport so far (each produced when pulled). */
  readonly bodyChunks: number
}

export type FixtureRouteEmulator = EmulatorApi<
  FixtureRouteScriptedTurn,
  FixtureRouteFault,
  FixtureRouteLedgerEntry
>

/** A header every request must carry (non-empty and, when set, accepted by `accepts`). */
export type FixtureRouteHeaderRule = {
  /** Lower-case header name. */
  readonly name: string
  /** Keep the value in the ledger (never for credential or account headers). */
  readonly record: boolean
  readonly accepts?: (value: string) => boolean
}

export type FixtureRouteConfig = {
  readonly method: 'GET' | 'POST'
  readonly path: string
  /** Route evidence manifest; must list exactly this route. */
  readonly routes: ReadonlyArray<EmulatorRouteEvidence>
  /** The recordings this route answers from (at least one), tried in order. */
  readonly recordings: ReadonlyArray<FixtureRecording>
  /** The credential header the SDK sends: a non-empty Bearer, or a non-empty `x-api-key`. */
  readonly credential: 'bearer' | 'x-api-key'
  /** Headers the SDK sends besides the credential and the recorded ones, required in order. */
  readonly headers: ReadonlyArray<FixtureRouteHeaderRule>
  /**
   * Replaceable JSON body (usage routes): enables the scripted `{ usage }` turn, and
   * `defaultBody` replaces the recorded body; both must have the recorded body's JSON shape.
   */
  readonly replaceableBody?: { readonly defaultBody: Schema.Json | undefined }
  /** Builds the error thrown by the JS API (and at construction) for invalid input. */
  readonly inputInvalid: (input: 'fault' | 'turn', reason: string) => Error
}

/** The one answer for everything no fixture records. */
export const notEmulatedResponse = (reason: string): Response =>
  jsonResponse(400, { error: { type: 'not_emulated', message: `Not emulated: ${reason}` } })

const faultBody = (status: number): Schema.Json => ({
  error: { type: 'emulator_fault', message: `Emulator fault: status ${status}.` }
})

const discriminators: ReadonlyArray<string> = ['model', 'role', 'type', 'phase']

const kindOf = (value: Schema.Json): string => {
  if (value === null) return 'null'

  if (Array.isArray(value)) return 'array'

  if (Predicate.isString(value)) return 'string'

  if (Predicate.isNumber(value)) return 'number'

  return Predicate.isBoolean(value) ? 'boolean' : 'object'
}

/**
 * Where `actual` leaves the recorded request shape (the documented latitude applied), or
 * undefined when it matches.
 */
export const recordedRequestMismatch = (
  actual: Schema.Json | undefined,
  recorded: Schema.Json,
  path = '$',
  key = ''
): string | undefined => {
  if (actual === undefined) return `${path} is missing`

  if (isJsonObject(recorded)) {
    if (!isJsonObject(actual)) return `${path} is not an object`

    const recordedKeys = Object.keys(recorded).sort()
    const actualKeys = Object.keys(actual).sort()

    const extra = actualKeys.filter(name => !recordedKeys.includes(name))
    const missing = recordedKeys.filter(name => !actualKeys.includes(name))

    if (extra.length > 0) return `${path} has unrecorded field(s) ${extra.join(', ')}`

    if (missing.length > 0) return `${path} lacks recorded field(s) ${missing.join(', ')}`

    for (const name of recordedKeys) {
      const field = recorded[name]

      if (field === undefined) continue

      const mismatch = recordedRequestMismatch(actual[name], field, `${path}.${name}`, name)

      if (mismatch !== undefined) return mismatch
    }

    return undefined
  }

  if (Array.isArray(recorded)) {
    if (!Array.isArray(actual)) return `${path} is not an array`

    if (actual.length !== recorded.length) {
      return `${path} has ${actual.length} item(s), the recording ${recorded.length}`
    }

    for (const [index, item] of recorded.entries()) {
      const mismatch = recordedRequestMismatch(actual[index], item, `${path}[${index}]`, key)

      if (mismatch !== undefined) return mismatch
    }

    return undefined
  }

  if (kindOf(actual) !== kindOf(recorded)) return `${path} is not a ${kindOf(recorded)}`

  if (Predicate.isString(recorded)) {
    return discriminators.includes(key) && actual !== recorded
      ? `${path} is not the recorded ${key}`
      : undefined
  }

  if (Predicate.isNumber(recorded)) {
    return Predicate.isNumber(actual) && Number.isSafeInteger(actual) && actual > 0
      ? undefined
      : `${path} is not a positive integer`
  }

  return actual === recorded ? undefined : `${path} is not the recorded value`
}

/** Where `actual` leaves the recorded JSON shape (object keys and value kinds), or undefined. */
export const recordedBodyMismatch = (
  actual: Schema.Json,
  recorded: Schema.Json,
  path = '$'
): string | undefined => {
  if (isJsonObject(recorded)) {
    if (!isJsonObject(actual)) return `${path} is not an object`

    const recordedKeys = Object.keys(recorded).sort()

    if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(recordedKeys)) {
      return `${path} does not have the recorded fields ${recordedKeys.join(', ')}`
    }

    for (const name of recordedKeys) {
      const actualField = actual[name]
      const recordedField = recorded[name]

      if (actualField === undefined || recordedField === undefined) continue

      const mismatch = recordedBodyMismatch(actualField, recordedField, `${path}.${name}`)

      if (mismatch !== undefined) return mismatch
    }

    return undefined
  }

  if (Array.isArray(recorded)) {
    if (!Array.isArray(actual) || actual.length !== recorded.length) {
      return `${path} is not a ${recorded.length}-item array`
    }

    for (const [index, item] of recorded.entries()) {
      const actualItem = actual[index]

      if (actualItem === undefined) return `${path}[${index}] is missing`

      const mismatch = recordedBodyMismatch(actualItem, item, `${path}[${index}]`)

      if (mismatch !== undefined) return mismatch
    }

    return undefined
  }

  return kindOf(actual) === kindOf(recorded) ? undefined : `${path} is not a ${kindOf(recorded)}`
}

// A non-empty bearer credential. The value is never checked or stored.
const bearerPattern = /^bearer\s+\S+/i

const mediaType = (value: string | null): string | undefined =>
  value?.split(';')[0]?.trim().toLowerCase()

type MutableLedgerEntry = KernelLedgerEntry<FixtureRouteFaultKind> & {
  query?: string
  body?: Schema.Json
  model?: string
  credentialHeader?: 'authorization' | 'x-api-key'
  headers: Record<string, string>
  recording?: string
  notEmulated?: string
  scripted?: 'usage' | 'error'
}

/**
 * Create a fixture-only route. Each call has independent ledger, fault, and script state. Throws
 * `inputInvalid('turn', ...)` when a replaceable body's `defaultBody` does not have the recorded
 * shape.
 *
 * Precedence per request: the credential, the header rules in order, the recorded headers and
 * query, the recorded request shape (one of `recordings`); a request failing any of these answers
 * 400 not-emulated and uses up no fault or turn. Then the first matching fault if it is a `status`
 * fault, then the next scripted turn, then the recorded response; a first matching body fault then
 * shapes the body.
 */
export const makeFixtureRouteEmulator = (config: FixtureRouteConfig): FixtureRouteEmulator => {
  const [primary] = config.recordings

  if (primary === undefined) {
    throw config.inputInvalid('turn', 'a fixture route needs at least one recording')
  }

  const recordedBody =
    config.replaceableBody === undefined ? undefined : parseJson(primary.response.chunks.join(''))

  const bodyMismatch = (value: Schema.Json): string | undefined =>
    recordedBody === undefined
      ? 'this route has no replaceable body'
      : recordedBodyMismatch(value, recordedBody)

  const defaultBody = config.replaceableBody?.defaultBody

  if (defaultBody !== undefined) {
    const mismatch = bodyMismatch(defaultBody)

    if (mismatch !== undefined) {
      throw config.inputInvalid(
        'turn',
        `the default body must have the recorded shape: ${mismatch}`
      )
    }
  }

  const ScriptedBody = Schema.Struct({
    usage: Schema.Json.check(
      Schema.makeFilter(value => {
        const mismatch = bodyMismatch(value)

        return mismatch === undefined ? true : `must have the recorded shape: ${mismatch}`
      })
    )
  })

  const turnSchema: Schema.Decoder<FixtureRouteScriptedTurn> =
    config.replaceableBody === undefined
      ? FixtureRouteScriptedError
      : Schema.Union([FixtureRouteScriptedError, ScriptedBody])

  const models = config.recordings.flatMap(recording => {
    const model = stringField(recording.request.body, 'model')

    return model === undefined ? [] : [model]
  })

  const kernel = makeEmulatorKernel({
    routes: config.routes,
    faultSchema: FixtureRouteFault,
    turnSchema,
    newEntry: (base): MutableLedgerEntry => ({ ...base, headers: {} }),
    snapshotEntry: (entry): FixtureRouteLedgerEntry => ({
      ...entry,
      headers: { ...entry.headers }
    }),
    unknownRoute: entry => {
      entry.notEmulated = 'no recorded route for this method and path'

      return notEmulatedResponse(entry.notEmulated)
    },
    stateFields: () => ({ knownModels: [...new Set(models)] }),
    inputInvalid: config.inputInvalid
  })

  const recordingMismatch = (
    recording: FixtureRecording,
    request: Request,
    url: URL,
    text: string,
    json: Schema.Json | undefined
  ): string | undefined => {
    for (const [name, value] of Object.entries(recording.request.headers)) {
      const actual = request.headers.get(name)

      const matches =
        name === 'content-type' ? mediaType(actual) === mediaType(value) : actual === value

      if (!matches) return `the ${name} header is not the recorded ${value}`
    }

    if (url.search !== recording.request.query) {
      return recording.request.query.length === 0
        ? 'the recording has no query parameters'
        : `the query is not the recorded ${recording.request.query}`
    }

    if (recording.request.body === undefined) {
      return text.length === 0 ? undefined : 'the recording has no request body'
    }

    if (json === undefined) return 'the request body is not JSON'

    return recordedRequestMismatch(json, recording.request.body)
  }

  const admit = async (
    request: Request,
    entry: MutableLedgerEntry
  ): Promise<{ readonly recording: FixtureRecording } | { readonly reason: string }> => {
    const credential =
      config.credential === 'bearer'
        ? bearerPattern.test(request.headers.get('authorization') ?? '')
        : (request.headers.get('x-api-key') ?? '').trim().length > 0

    if (!credential) {
      return {
        reason:
          config.credential === 'bearer'
            ? 'a non-empty Authorization: Bearer credential is required'
            : 'a non-empty x-api-key credential is required'
      }
    }

    entry.credentialHeader = config.credential === 'bearer' ? 'authorization' : 'x-api-key'

    for (const rule of config.headers) {
      const value = (request.headers.get(rule.name) ?? '').trim()

      if (value.length === 0 || (rule.accepts !== undefined && !rule.accepts(value))) {
        return { reason: `the ${rule.name} header is missing or not the one the SDK sends` }
      }
    }

    const url = new URL(request.url)
    const text = (await readText(request)) ?? ''

    const json = config.method === 'POST' ? parseJson(text) : undefined

    if (json !== undefined) entry.body = json

    const model = stringField(json, 'model')

    if (model !== undefined) entry.model = model

    const reasons: Array<string> = []

    for (const recording of config.recordings) {
      const reason = recordingMismatch(recording, request, url, text, json)

      if (reason === undefined) return { recording }

      reasons.push(config.recordings.length === 1 ? reason : `${recording.caseId}: ${reason}`)
    }

    return { reason: reasons.join('; ') }
  }

  const handle = async (
    request: Request,
    entry: MutableLedgerEntry,
    path: string
  ): Promise<Response> => {
    for (const rule of config.headers) {
      const value = request.headers.get(rule.name)

      if (rule.record && value !== null) entry.headers[rule.name] = value
    }

    const search = new URL(request.url).search

    if (search.length > 0) entry.query = search

    const admitted = await admit(request, entry)

    if ('reason' in admitted) {
      entry.notEmulated = admitted.reason
      entry.status = 400

      return notEmulatedResponse(admitted.reason)
    }

    const recording = admitted.recording
    const fault = kernel.takeFault(path, entry.model)

    if (fault !== undefined && fault.fault.kind === 'status') {
      return kernel.respondWithStatusFault(entry, fault, fault.fault, faultBody)
    }

    const turn = kernel.nextTurn()

    if (turn !== undefined && 'error' in turn) {
      entry.scripted = 'error'

      return kernel.respondWithScriptedError(entry, turn.error, fault)
    }

    const body = turn === undefined ? defaultBody : turn.usage

    if (turn !== undefined) entry.scripted = 'usage'

    entry.recording = recording.fixtureId

    return kernel.respondWithBody(
      entry,
      recording.response.status,
      { ...recording.response.headers },
      body === undefined ? recording.response.chunks : [JSON.stringify(body)],
      fault
    )
  }

  // Every manifest route maps to its own handler; construction throws `EmulatorRouteUnmapped`
  // when a manifest route has no handler (or a handler has no manifest route).
  return kernel.serve(new Map([[emulatorRouteKey(config.method, config.path), handle]]))
}
