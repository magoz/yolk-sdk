/**
 * Shared emulator kernel (internal; not a package export).
 *
 * The wire-independent half of every fetch-handler emulator: fault and scripted-turn state, the
 * request ledger, pull-driven bodies with chunk faults, evidence tagging, route binding, and the
 * `/_emulate/*` control plane. Each wire core (`chat-completions.ts`, `messages.ts`) supplies its
 * route handlers, fault and turn schemas, ledger entry shape, and error bodies.
 *
 * Also holds small wire-independent helpers both cores use: JSON field access, synthetic values
 * for a tool's JSON Schema, fragment splitting, and a rough token estimate.
 *
 * Runtime-portable Web APIs only (`Request`, `Response`, `ReadableStream`, `TextEncoder`, `URL`);
 * no Node builtins and no SDK imports.
 */
import { Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { EmulatorHeaderRecord, EmulatorResponseStatus } from './emulator-http.ts'
import {
  bindRouteHandlers,
  emulatorEvidenceHeader,
  type EmulatorEvidence,
  type EmulatorRouteEvidence
} from './route-evidence.ts'

export const ChunkCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const FaultCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** Optional fault filter; an omitted field matches every request. `path` ending in `*` is a prefix. */
export const EmulatorFaultMatch = Schema.Struct({
  path: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String)
})

export type EmulatorFaultMatch = typeof EmulatorFaultMatch.Type

/** Fields every fault kind carries. */
export const emulatorFaultFields = {
  match: Schema.optionalKey(EmulatorFaultMatch),
  /** How many matching requests the fault answers. Omitted: every matching request. */
  count: Schema.optionalKey(FaultCount)
}

/** Answer with this status, headers, and body instead of the planned response. */
export const EmulatorStatusFault = Schema.Struct({
  kind: Schema.Literal('status'),
  status: EmulatorResponseStatus,
  headers: Schema.optionalKey(EmulatorHeaderRecord),
  body: Schema.optionalKey(Schema.Json),
  ...emulatorFaultFields
})

/** Send `chunks` body chunks, then error the body stream (a dropped connection). */
export const EmulatorErrorAfterChunksFault = Schema.Struct({
  kind: Schema.Literal('error-after-chunks'),
  chunks: ChunkCount,
  ...emulatorFaultFields
})

/** Send `chunks` body chunks, then close the body cleanly (a truncated response). */
export const EmulatorTruncateAfterChunksFault = Schema.Struct({
  kind: Schema.Literal('truncate-after-chunks'),
  chunks: ChunkCount,
  ...emulatorFaultFields
})

/** A scripted error response: status, body (a string is sent as is), and optional headers. */
export const EmulatorScriptedError = Schema.Struct({
  error: Schema.Struct({
    status: EmulatorResponseStatus,
    body: Schema.Json,
    headers: Schema.optionalKey(EmulatorHeaderRecord)
  })
})

export type EmulatorScriptedError = typeof EmulatorScriptedError.Type

/** What the kernel needs from every fault: its kind and optional filter and count. */
export type KernelFault = {
  readonly kind: string
  readonly match?: EmulatorFaultMatch | undefined
  readonly count?: number | undefined
}

type BodyChunkFault =
  | typeof EmulatorErrorAfterChunksFault.Type
  | typeof EmulatorTruncateAfterChunksFault.Type

export type EmulatorFaultState<Fault> = {
  readonly id: number
  readonly fault: Fault
  /** Remaining matching requests; `undefined` for an unlimited fault. */
  readonly remaining: number | undefined
  readonly applied: number
}

type MutableFaultState<Fault> = {
  readonly id: number
  readonly fault: Fault
  remaining: number | undefined
  applied: number
}

export type EmulatorRouteCoverage = EmulatorRouteEvidence & {
  /** Ledger requests answered by this route since the last ledger clear or reset. */
  readonly requests: number
}

export type EmulatorCoverage = {
  readonly routes: ReadonlyArray<EmulatorRouteCoverage>
  /** Ledger requests to unknown routes (failed closed). */
  readonly unknownRouteRequests: number
}

/** Fields an emulator lists first in `/_emulate/state`. */
export type EmulatorStateFields = {
  readonly knownModels: ReadonlyArray<string>
  /** Only for emulators that emulate streamed reasoning. */
  readonly reasoningModels?: ReadonlyArray<string>
}

/** The ledger fields the kernel owns; each wire core extends it with its request fields. */
export type KernelLedgerEntry<FaultKind extends string> = {
  seq: number
  method: string
  path: string
  fault?: FaultKind
  faultError?: string
  responseError?: string
  evidence: EmulatorEvidence | 'unknown-route'
  status: number
  bodyChunks: number
}

/** The public shape of every emulator built on the kernel. */
export type EmulatorApi<Turn, Fault, Entry> = {
  /** The fetch handler (emulated API plus the `/_emulate/*` control plane). Never rejects. */
  readonly fetch: (request: Request) => Promise<Response>
  readonly ledger: {
    readonly entries: () => ReadonlyArray<Entry>
    readonly clear: () => void
  }
  /** Clear the ledger, faults, and scripted turns. */
  readonly reset: () => void
  readonly faults: {
    /** Add a fault; throws the emulator's input-invalid error for an invalid fault. */
    readonly add: (fault: Fault) => EmulatorFaultState<Fault>
    readonly list: () => ReadonlyArray<EmulatorFaultState<Fault>>
    readonly clear: () => void
  }
  readonly script: {
    /** Queue a turn for the next emulated request; throws for an invalid turn. */
    readonly enqueue: (turn: Turn) => void
    readonly pending: () => number
    readonly clear: () => void
  }
  readonly coverage: () => EmulatorCoverage
}

export type EmulatorKernelConfig<
  Fault extends KernelFault,
  Turn,
  Entry extends KernelLedgerEntry<Fault['kind']>,
  Snapshot
> = {
  /** Route evidence manifest; `serve` needs exactly one handler per route. */
  readonly routes: ReadonlyArray<EmulatorRouteEvidence>
  /** Fault schema (decoded strictly). */
  readonly faultSchema: Schema.Decoder<Fault>
  /** Scripted-turn schema (decoded strictly). */
  readonly turnSchema: Schema.Decoder<Turn>
  /** Adds the wire core's own ledger fields to a fresh kernel entry. */
  readonly newEntry: (base: KernelLedgerEntry<Fault['kind']>) => Entry
  /** Copies an entry for the ledger API (never shares mutable state). */
  readonly snapshotEntry: (entry: Entry) => Snapshot
  /**
   * Response for an unknown emulated route (fails closed, still written to the ledger with the
   * status it answers); the core may add its own ledger fields to `entry`.
   */
  readonly unknownRoute: (entry: Entry) => Response
  /** Fields listed first in `/_emulate/state`. */
  readonly stateFields: () => EmulatorStateFields
  /** Builds the error thrown by the JS API (`faults.add`, `script.enqueue`) for invalid input. */
  readonly inputInvalid: (input: 'fault' | 'turn', reason: string) => Error
}

export type EmulatorRouteHandler<Entry> = (
  request: Request,
  entry: Entry,
  path: string
) => Promise<Response>

// Control inputs are strict: an unknown key (a typo, or an `error` turn with a bad field) is
// rejected instead of silently decoding as a different, all-optional shape.
const strict = { onExcessProperty: 'error' } as const

const decodeJsonText = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))

const issueMessage = (issue: Schema.SchemaError['issue']): string =>
  new Schema.SchemaError(issue).message

export const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  value !== null && value !== undefined && Predicate.isObject(value) && !Array.isArray(value)

export const jsonField = (value: Schema.Json | undefined, key: string): Schema.Json | undefined =>
  isJsonObject(value) ? value[key] : undefined

export const stringField = (value: Schema.Json | undefined, key: string): string | undefined => {
  const field = jsonField(value, key)

  return Predicate.isString(field) ? field : undefined
}

const textEncoder = new TextEncoder()

/** A JSON response; `body` is any JSON-serializable value (ledger snapshots, fault states, envelopes). */
export const jsonResponse = (
  status: number,
  body: unknown,
  headers: HeadersInit = {}
): Response => {
  const responseHeaders = new Headers(headers)

  responseHeaders.set('content-type', 'application/json')

  return new Response(JSON.stringify(body), { status, headers: responseHeaders })
}

/** An emulator (not emulated-service) error: control-plane problems and unbuildable responses. */
export const controlError = (
  status: number,
  message: string,
  headers: HeadersInit = {}
): Response => jsonResponse(status, { error: { message, type: 'emulator_error' } }, headers)

/** A scripted or fault body: a string is sent as is, anything else as JSON. */
export const bodyText = (body: Schema.Json): string =>
  Predicate.isString(body) ? body : JSON.stringify(body)

/** Headers for a scripted or fault body, with a `content-type` matching the body when unset. */
const bodyHeaders = (headers: Readonly<Record<string, string>> | undefined, body: Schema.Json) => {
  const result = new Headers(headers ?? {})

  if (!result.has('content-type')) {
    result.set('content-type', Predicate.isString(body) ? 'text/plain' : 'application/json')
  }

  return result
}

export const readText = (request: Request): Promise<string | undefined> =>
  request.text().then(
    text => text,
    () => undefined
  )

export const parseJson = (text: string): Schema.Json | undefined => {
  const result = decodeJsonText(text)

  return Result.isSuccess(result) ? result.success : undefined
}

const pathMatches = (pattern: string, path: string): boolean =>
  pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : pattern === path

const faultMatches = (fault: KernelFault, path: string, model: string | undefined): boolean =>
  (fault.match?.path === undefined || pathMatches(fault.match.path, path)) &&
  (fault.match?.model === undefined || fault.match.model === model)

const isBodyChunkFault = (fault: KernelFault): fault is BodyChunkFault =>
  fault.kind === 'error-after-chunks' || fault.kind === 'truncate-after-chunks'

const chunkFaultProblem = (fault: BodyChunkFault, chunks: number): string | undefined => {
  const applies =
    fault.kind === 'error-after-chunks' ? fault.chunks <= chunks : fault.chunks < chunks

  return applies
    ? undefined
    : `${fault.kind} after ${fault.chunks} chunk(s) cannot apply to a response with ${chunks} chunk(s)`
}

/**
 * Strictly pull-driven body: chunk `k` is produced only when the consumer
 * pulls it, and `entry.bodyChunks` counts the chunks handed over. The fault
 * (already validated against the chunk count) applies when the consumer pulls
 * past `fault.chunks` chunks.
 */
const chunkedBody = (
  chunks: ReadonlyArray<string>,
  fault: BodyChunkFault | undefined,
  entry: { bodyChunks: number }
): ReadableStream<Uint8Array> => {
  let next = 0

  return new ReadableStream<Uint8Array>(
    {
      pull: controller => {
        if (fault !== undefined && next === fault.chunks) {
          if (fault.kind === 'error-after-chunks') {
            controller.error(new Error(`synthetic mid-stream failure after ${next} chunk(s)`))
          } else {
            controller.close()
          }

          return
        }

        const chunk = chunks[next]

        if (chunk === undefined) {
          controller.close()

          return
        }

        next += 1
        entry.bodyChunks += 1
        controller.enqueue(textEncoder.encode(chunk))
      }
    },
    { highWaterMark: 0 }
  )
}

const withEvidence = (response: Response, evidence: EmulatorEvidence): Response => {
  if (evidence === 'unverified') {
    response.headers.set(emulatorEvidenceHeader, 'unverified')
  }

  return response
}

const maxSchemaDepth = 8

/**
 * A synthetic value for a JSON Schema: required object properties only,
 * non-empty strings (or the first `enum` / `const` value), the minimum for
 * numbers, `true` for booleans, and `minItems` synthetic items for arrays.
 */
export const synthesizeValue = (
  schema: Schema.Json | undefined,
  name: string,
  depth: number
): Schema.Json => {
  const constant = jsonField(schema, 'const')

  if (constant !== undefined) {
    return constant
  }

  const choices = jsonField(schema, 'enum')

  if (Array.isArray(choices) && choices.length > 0) {
    return choices[0] ?? null
  }

  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const options = jsonField(schema, key)

    if (Array.isArray(options) && options.length > 0) {
      const preferred = options.find(option => stringField(option, 'type') !== 'null')

      return synthesizeValue(preferred ?? options[0], name, depth + 1)
    }
  }

  const declared = jsonField(schema, 'type')

  const type = Array.isArray(declared)
    ? declared.find(entry => Predicate.isString(entry) && entry !== 'null')
    : declared

  if (depth > maxSchemaDepth) {
    return null
  }

  switch (type) {
    case 'object': {
      const properties = jsonField(schema, 'properties')
      const required = jsonField(schema, 'required')
      const value: Record<string, Schema.Json> = {}

      for (const key of Array.isArray(required) ? required : []) {
        if (Predicate.isString(key)) {
          value[key] = synthesizeValue(jsonField(properties, key), key, depth + 1)
        }
      }

      return value
    }

    case 'array': {
      const minItems = jsonField(schema, 'minItems')
      const count = Predicate.isNumber(minItems) && minItems > 0 ? Math.min(minItems, 3) : 0

      return Array.from({ length: count }, () =>
        synthesizeValue(jsonField(schema, 'items'), name, depth + 1)
      )
    }

    case 'integer':
    case 'number': {
      const minimum = jsonField(schema, 'minimum')

      return Predicate.isNumber(minimum) ? minimum : 1
    }

    case 'boolean':
      return true
    case 'null':
      return null
    default:
      return `synthetic ${name}`
  }
}

/** Split text into up to `parts` non-empty fragments (at least one). */
export const splitFragments = (text: string, parts: number): ReadonlyArray<string> => {
  if (text.length <= 1) {
    return [text]
  }

  const size = Math.ceil(text.length / Math.min(parts, text.length))
  const fragments: Array<string> = []

  for (let index = 0; index < text.length; index += size) {
    fragments.push(text.slice(index, index + size))
  }

  return fragments
}

/** A rough synthetic token count (about four characters per token, at least one). */
export const approximateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4))

/**
 * Create the kernel of an emulator. Each call has independent ledger, fault,
 * and script state. Handlers use the returned helpers, then `serve` binds
 * them to the manifest (throwing `EmulatorRouteUnmapped` on a mismatch) and
 * returns the emulator API.
 */
export const makeEmulatorKernel = <
  Fault extends KernelFault,
  Turn,
  Entry extends KernelLedgerEntry<Fault['kind']>,
  Snapshot
>(
  config: EmulatorKernelConfig<Fault, Turn, Entry, Snapshot>
) => {
  const decodeFault = Schema.decodeUnknownResult(config.faultSchema, strict)

  const decodeFaultList = Schema.decodeUnknownResult(
    Schema.Union([config.faultSchema, Schema.Struct({ faults: Schema.Array(config.faultSchema) })]),
    strict
  )

  const decodeTurn = Schema.decodeUnknownResult(config.turnSchema, strict)

  const decodeTurnList = Schema.decodeUnknownResult(
    Schema.Union([Schema.Struct({ turns: Schema.Array(config.turnSchema) }), config.turnSchema]),
    strict
  )

  let entries: Array<Entry> = []
  let faultStates: Array<MutableFaultState<Fault>> = []
  let turns: Array<Turn> = []
  let nextSeq = 1
  let nextFaultId = 1

  const snapshotFault = (state: MutableFaultState<Fault>): EmulatorFaultState<Fault> => ({
    ...state
  })

  const clearLedger = () => {
    entries = []
    nextSeq = 1
  }

  const addFault = (input: unknown): EmulatorFaultState<Fault> | string => {
    const decoded = decodeFault(input)

    if (Result.isFailure(decoded)) {
      return issueMessage(decoded.failure.issue)
    }

    const state: MutableFaultState<Fault> = {
      id: nextFaultId++,
      fault: decoded.success,
      remaining: decoded.success.count,
      applied: 0
    }

    faultStates.push(state)

    return snapshotFault(state)
  }

  const enqueueTurn = (input: unknown): string | undefined => {
    const decoded = decodeTurn(input)

    if (Result.isFailure(decoded)) {
      return issueMessage(decoded.failure.issue)
    }

    turns.push(decoded.success)

    return undefined
  }

  /** The first matching fault with uses left, in insertion order (not yet consumed). */
  const takeFault = (
    path: string,
    model: string | undefined
  ): MutableFaultState<Fault> | undefined =>
    faultStates.find(
      state =>
        (state.remaining === undefined || state.remaining > 0) &&
        faultMatches(state.fault, path, model)
    )

  /** Use up one application of a fault and record its kind in the ledger entry. */
  const consumeFault = (state: MutableFaultState<Fault>, entry: Entry) => {
    state.applied += 1
    entry.fault = state.fault.kind

    if (state.remaining !== undefined) {
      state.remaining -= 1
    }
  }

  /** The next scripted turn, used up when its request arrives. */
  const nextTurn = (): Turn | undefined => turns.shift()

  const coverage = (): EmulatorCoverage => ({
    routes: config.routes.map(route => ({
      ...route,
      requests: entries.filter(
        entry =>
          entry.evidence !== 'unknown-route' &&
          entry.method === route.method &&
          entry.path === route.path
      ).length
    })),
    unknownRouteRequests: entries.filter(entry => entry.evidence === 'unknown-route').length
  })

  /**
   * Answer with a pull-driven body. A matching `error-after-chunks` or
   * `truncate-after-chunks` fault shapes it; one that cannot take effect
   * answers 500 and is not consumed. Other fault kinds are left to the caller.
   */
  const respondWithBody = (
    entry: Entry,
    status: number,
    headers: HeadersInit,
    chunks: ReadonlyArray<string>,
    fault: MutableFaultState<Fault> | undefined
  ): Response => {
    const chunkFault =
      fault === undefined || !isBodyChunkFault(fault.fault) ? undefined : fault.fault

    if (chunkFault !== undefined) {
      const problem = chunkFaultProblem(chunkFault, chunks.length)

      if (problem !== undefined) {
        entry.faultError = problem
        entry.status = 500

        return controlError(500, `emulator fault cannot apply: ${problem}`)
      }
    }

    // Build the response before using up the fault: a response that cannot be built must not
    // consume it.
    const response = new Response(chunkedBody(chunks, chunkFault, entry), { status, headers })

    if (chunkFault !== undefined && fault !== undefined) {
      consumeFault(fault, entry)
    }

    entry.status = response.status

    return response
  }

  /** Answer a `status` fault with its status, headers, and body (or `defaultBody`). */
  const respondWithStatusFault = (
    entry: Entry,
    state: MutableFaultState<Fault>,
    fault: typeof EmulatorStatusFault.Type,
    defaultBody: (status: number) => Schema.Json
  ): Response => {
    const faultBody = fault.body ?? defaultBody(fault.status)

    // Built first: a status fault whose response cannot be built is not used up.
    const response = new Response(bodyText(faultBody), {
      status: fault.status,
      headers: bodyHeaders(fault.headers, faultBody)
    })

    consumeFault(state, entry)
    entry.status = response.status

    return response
  }

  /** Answer a scripted error turn; a matching chunk fault still shapes its body. */
  const respondWithScriptedError = (
    entry: Entry,
    error: EmulatorScriptedError['error'],
    fault: MutableFaultState<Fault> | undefined
  ): Response =>
    respondWithBody(
      entry,
      error.status,
      bodyHeaders(error.headers, error.body),
      [bodyText(error.body)],
      fault
    )

  const reset = () => {
    clearLedger()
    faultStates = []
    turns = []
  }

  const state = () => ({
    ...config.stateFields(),
    pendingTurns: turns.length,
    faults: faultStates.map(snapshotFault),
    ledgerEntries: entries.length
  })

  const controlPlane = async (request: Request, path: string): Promise<Response> => {
    const method = request.method
    const allow = (methods: string) => controlError(405, 'method not allowed', { allow: methods })

    const jsonBody = async (): Promise<Schema.Json | undefined> => {
      const text = await readText(request)

      return text === undefined ? undefined : parseJson(text)
    }

    switch (path) {
      case '/_emulate/ledger':
        if (method === 'GET') {
          return jsonResponse(200, { entries: entries.map(config.snapshotEntry) })
        }

        if (method === 'DELETE') {
          const cleared = entries.length

          clearLedger()

          return jsonResponse(200, { cleared })
        }

        return allow('GET, DELETE')

      case '/_emulate/faults': {
        if (method === 'GET') {
          return jsonResponse(200, { faults: faultStates.map(snapshotFault) })
        }

        if (method === 'DELETE') {
          const cleared = faultStates.length

          faultStates = []

          return jsonResponse(200, { cleared })
        }

        if (method !== 'POST') {
          return allow('GET, POST, DELETE')
        }

        const decoded = decodeFaultList(await jsonBody())

        if (Result.isFailure(decoded)) {
          return controlError(400, `invalid fault: ${issueMessage(decoded.failure.issue)}`)
        }

        const added = (
          'faults' in decoded.success ? decoded.success.faults : [decoded.success]
        ).map(fault => addFault(fault))

        return jsonResponse(201, { faults: added })
      }

      case '/_emulate/script': {
        if (method !== 'POST') {
          return allow('POST')
        }

        const decoded = decodeTurnList(await jsonBody())

        if (Result.isFailure(decoded)) {
          return controlError(400, `invalid turn: ${issueMessage(decoded.failure.issue)}`)
        }

        const queued =
          Predicate.isObject(decoded.success) && 'turns' in decoded.success
            ? decoded.success.turns
            : [decoded.success]

        for (const turn of queued) {
          enqueueTurn(turn)
        }

        return jsonResponse(201, { pending: turns.length })
      }

      case '/_emulate/reset':
        if (method !== 'POST') {
          return allow('POST')
        }

        reset()

        return jsonResponse(200, { reset: true })

      case '/_emulate/state':
        if (method !== 'GET') {
          return allow('GET')
        }

        return jsonResponse(200, state())

      case '/_emulate/coverage':
        if (method !== 'GET') {
          return allow('GET')
        }

        return jsonResponse(200, coverage())

      default:
        return controlError(404, 'unknown control-plane route')
    }
  }

  /**
   * Bind one handler per manifest route (keyed by `emulatorRouteKey`) and
   * return the emulator API. Throws `EmulatorRouteUnmapped` when a manifest
   * route has no handler or a handler has no manifest route.
   */
  const serve = (
    handlers: ReadonlyMap<string, EmulatorRouteHandler<Entry>>
  ): EmulatorApi<Turn, Fault, Snapshot> => {
    const routes = bindRouteHandlers(config.routes, handlers)

    const emulatedApi = async (request: Request, path: string): Promise<Response> => {
      const bound = routes.find(
        candidate => candidate.route.method === request.method && candidate.route.path === path
      )

      const entry = config.newEntry({
        seq: nextSeq++,
        method: request.method,
        path,
        evidence: bound?.route.evidence ?? 'unknown-route',
        status: 0,
        bodyChunks: 0
      })

      entries.push(entry)

      if (bound === undefined) {
        const response = config.unknownRoute(entry)

        entry.status = response.status

        return response
      }

      // Error recovery still answers through the route: the fallback 500 is evidence-tagged and
      // the ledger records the status actually sent.
      const response = await bound.handler(request, entry, path).catch(() => {
        entry.status = 500
        entry.responseError = 'the emulator could not build the planned response'

        return controlError(500, 'emulator could not build the response')
      })

      return withEvidence(response, bound.route.evidence)
    }

    const handle = (request: Request): Promise<Response> => {
      const path = URL.canParse(request.url) ? new URL(request.url).pathname : '/'

      return path === '/_emulate' || path.startsWith('/_emulate/')
        ? controlPlane(request, path)
        : emulatedApi(request, path)
    }

    return {
      fetch: request =>
        handle(request).catch(() => controlError(500, 'emulator failed to handle the request')),
      ledger: {
        entries: () => entries.map(config.snapshotEntry),
        clear: clearLedger
      },
      reset,
      faults: {
        add: fault => {
          const added = addFault(fault)

          if (Predicate.isString(added)) {
            throw config.inputInvalid('fault', added)
          }

          return added
        },
        list: () => faultStates.map(snapshotFault),
        clear: () => {
          faultStates = []
        }
      },
      script: {
        enqueue: turn => {
          const problem = enqueueTurn(turn)

          if (problem !== undefined) {
            throw config.inputInvalid('turn', problem)
          }
        },
        pending: () => turns.length,
        clear: () => {
          turns = []
        }
      },
      coverage
    }
  }

  return {
    takeFault,
    consumeFault,
    nextTurn,
    respondWithBody,
    respondWithStatusFault,
    respondWithScriptedError,
    serve
  }
}
