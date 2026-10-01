/**
 * Shared wrapper of the fixture-only stateful connector emulators (internal; used by `/dropbox`,
 * `/notion`, and `/github`, not by the earlier `/fortnox` and `/microsoft` emulators, which keep
 * their own).
 *
 * The emulator state lives in an `@emulators/core` custom runtime that the Node-only subpath
 * creates and hands in (this module imports no Node builtin and never imports the core); the
 * request ledger, status faults, credential handling, and the `/_emulate/*` control plane live
 * here, because the core reserves `/_emulate`.
 *
 * The owner rule: response behaviour comes only from the committed conformance fixtures. Every
 * request is answered by its route or with one ledgered 400 not-emulated
 * (`{ error: { type: 'not_emulated', message } }`, `notEmulated` in the ledger). Precedence per
 * request:
 *
 * 1. route match on the raw path (path parameters decoded once; unknown routes and methods, and
 *    invalid percent-encoding, are not emulated), and the origin the route is recorded on;
 * 2. a non-empty `Authorization: Bearer` credential (never checked, stored, forwarded, or
 *    ledgered) and the emulator's header rules;
 * 3. the body the route takes (none, JSON with an `application/json` media type, or raw bytes);
 * 4. the route's request-shape check, which reads no state;
 * 5. in the core runtime, the route's plan: a pure, state-reading eligibility check that refuses
 *    what the state cannot answer the way a fixture does, and otherwise returns a commit;
 * 6. the first matching status fault, decided only for an eligible request (nothing is written);
 * 7. the commit, the only step that writes.
 *
 * A request that is not emulated (steps 1 to 5) never uses up a fault. The plan, the fault
 * decision, and the commit run synchronously together, so no other request interleaves. A route
 * that throws answers an evidence-tagged 500 emulator error
 * (`responseError` in the ledger); a closed emulator answers 503. No recovery answer reads the
 * injectable clock, so a failing clock cannot change it. Every response of a matched route
 * carries `x-emulator-evidence: unverified` when the route is unverified. Ledgered bodies and
 * query parameters have credential-named keys redacted.
 *
 * Fail-closed mode (opt-in, `failClosed`; used by `/github`): every route parameter has a raw
 * pattern, and a request is recognised only when its raw path is exactly an emulated route shape
 * under that route's method and any `Authorization` header is one recognisable bearer
 * (`Bearer <at least 8 non-space characters>`). Every other request is ledgered and answered with
 * constant text only (`/<unrecognised>`, a standard method or `<other>`, an empty query, no body,
 * a constant reason). For a recognised request the bearer value is a guarded secret: it is
 * scrubbed from the ledgered method, path, query keys and values, recorded headers, and every
 * not-emulated reason, and a path, query, or body that repeats it (raw, percent-decoded, or in any
 * parsed JSON key, string, or number) is refused with constant text. A template parameter written
 * `{name+}` spans one or more path segments (each decoded once, none may decode to a `/`).
 *
 * @experimental
 */
import { Data, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  EmulatorHeaderRecord,
  EmulatorResponseStatus,
  handlerFailedHeader,
  handlerFailedResponse,
  isCredentialHeaderName,
  redactCredentialFields,
  redactCredentialQuery,
  redactedCredentialValue
} from './emulator-http.ts'
import {
  emulatorEvidenceHeader,
  emulatorRouteKey,
  type EmulatorEvidence,
  type EmulatorRouteEvidence
} from './route-evidence.ts'
import {
  jsonRepeatsSecret,
  repeatsSecret,
  scrubSecrets,
  unrecognisedLedgerPath,
  unrecognisedMethod
} from './stateful-fixture.ts'

/** A request the emulator does not emulate, with the reason (answered 400 not-emulated). */
export class NotEmulated extends Data.TaggedClass('NotEmulated')<{ readonly reason: string }> {}

export const notEmulated = (reason: string): NotEmulated => new NotEmulated({ reason })

export const isNotEmulated = (value: unknown): value is NotEmulated => value instanceof NotEmulated

export const jsonResponse = (
  status: number,
  body: unknown,
  headers: HeadersInit = {}
): Response => {
  const responseHeaders = new Headers(headers)

  if (!responseHeaders.has('content-type')) {
    responseHeaders.set('content-type', 'application/json')
  }

  return new Response(JSON.stringify(body), { status, headers: responseHeaders })
}

/** The one answer for everything no fixture records. */
export const notEmulatedResponse = (reason: string): Response =>
  jsonResponse(400, { error: { type: 'not_emulated', message: `Not emulated: ${reason}` } })

const emulatorError = (status: number, message: string, headers: HeadersInit = {}): Response =>
  jsonResponse(status, { error: { message, type: 'emulator_error' } }, headers)

// Fault statuses are errors only (400-599), so no control answers a success no fixture records.
const FaultStatus = EmulatorResponseStatus.check(
  Schema.makeFilter(status =>
    status >= 400 ? true : 'fixture-only emulators take fault statuses of 400 or above'
  )
)

const FaultCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** Optional fault filter; an omitted field matches every request. `path` ending in `*` is a prefix. */
export const StatefulFaultMatch = Schema.Struct({
  method: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String)
})

/**
 * A status fault: answer matching requests with this status (400-599), headers, and body before
 * the route runs, so nothing is written. The body defaults to an emulator-fault body
 * (`{ error: { type: 'emulator_fault', message } }`), never a guessed provider envelope. `count`
 * limits how many requests it answers (omitted: all). `match.path` is the raw request path.
 * Invalid header names or values, `location`, and framing headers are rejected.
 */
export const StatefulFault = Schema.Struct({
  kind: Schema.Literal('status'),
  status: FaultStatus,
  headers: Schema.optionalKey(EmulatorHeaderRecord),
  body: Schema.optionalKey(Schema.Json),
  match: Schema.optionalKey(StatefulFaultMatch),
  count: Schema.optionalKey(FaultCount)
})

export type StatefulFault = typeof StatefulFault.Type

export type StatefulFaultState = {
  readonly id: number
  readonly fault: StatefulFault
  /** Remaining matching requests; `undefined` for an unlimited fault. */
  readonly remaining: number | undefined
  readonly applied: number
}

export type StatefulLedgerEntry = {
  /** 1-based arrival order since the last ledger clear or reset. */
  readonly seq: number
  readonly method: string
  /** Raw request path. */
  readonly path: string
  /** Path template of the matched route. */
  readonly route?: string
  /** Query parameters; the values of credential-named keys are `<redacted>`. */
  readonly query: Readonly<Record<string, string>>
  /** Parsed JSON request body, with credential-named keys redacted at any depth. */
  readonly body?: Schema.Json
  /** Length of a raw (non-JSON) request body. */
  readonly bodyBytes?: number
  /**
   * The non-credential request headers the emulator records (lower-case names); a JSON header is
   * recorded with credential-named keys redacted at any depth, or as `<redacted>` when unparseable.
   */
  readonly headers: Readonly<Record<string, string>>
  readonly status: number
  /** Evidence of the matched route; `unknown-route` for requests on no route. */
  readonly evidence: EmulatorEvidence | 'unknown-route'
  /** Why the request was answered 400 not-emulated. */
  readonly notEmulated?: string
  /** Set when a fault answered the request. */
  readonly fault?: 'status'
  /** Set when the emulator could not build the response, or a route threw (answered 500). */
  readonly responseError?: string
}

export type StatefulRouteCoverage = EmulatorRouteEvidence & {
  /** Ledger requests on this route since the last ledger clear or reset. */
  readonly requests: number
}

export type StatefulCoverage = {
  readonly routes: ReadonlyArray<StatefulRouteCoverage>
  /** Ledger requests on no route. */
  readonly unknownRouteRequests: number
  /** Ledger requests answered 400 not-emulated (on a route or not). */
  readonly notEmulatedRequests: number
}

/** One routed API request, as a route sees it. */
export type EmulatedRequest = {
  readonly method: string
  /** Raw (still percent-encoded) path. */
  readonly path: string
  /** Path parameters, percent-decoded once. */
  readonly params: Readonly<Record<string, string>>
  readonly query: URLSearchParams
  /** A non-credential request header (credential headers always read as `undefined`). */
  readonly header: (name: string) => string | undefined
  /** Parsed JSON body (`json` routes). */
  readonly json: Schema.Json | undefined
  /** Raw body (`bytes` routes). */
  readonly bytes: Uint8Array | undefined
}

export type RunContext<Env> = {
  readonly env: Env
  /** Ledger sequence number of the request (for synthetic request ids). */
  readonly seq: number
}

/** The writing part of an eligible request: applies its change and answers. */
export type Commit = () => Response

/** An admitted request: its pure, state-reading eligibility check, returning the commit. */
export type Admission<State, Env> = {
  readonly plan: (state: State, context: RunContext<Env>) => Commit | NotEmulated
}

export type RouteBody = 'none' | 'json' | 'bytes'

/** Route parts that are not evidence: the recorded origin and the raw parameter patterns. */
export type StatefulRouteBinding = {
  /** The origin a fixture records the route on; another origin is not emulated. Omitted: any. */
  readonly origin?: string
  /**
   * Raw (still percent-encoded) patterns of the path parameters; a parameter that does not match
   * its pattern makes the path match no route. Fail-closed emulators give every parameter one.
   */
  readonly params?: Readonly<Record<string, RegExp>>
}

export type StatefulRoute<State, Env> = EmulatorRouteEvidence &
  StatefulRouteBinding & {
    readonly body: RouteBody
    /** The request-shape check (reads no state): an admission, or not emulated. */
    readonly admit: (request: EmulatedRequest, env: Env) => Admission<State, Env> | NotEmulated
  }

/**
 * A route of the table: its evidence (and recorded origin), the body it takes, its request-shape
 * check `admit` (no state), and `plan`, which only ever sees an admitted input: it reads the state
 * without writing and answers not emulated or the commit that writes.
 */
export const statefulRoute = <State, Env, Input>(
  evidence: EmulatorRouteEvidence & StatefulRouteBinding,
  body: RouteBody,
  admit: (request: EmulatedRequest, env: Env) => Input | NotEmulated,
  plan: (state: State, input: Input, context: RunContext<Env>) => Commit | NotEmulated
): StatefulRoute<State, Env> => ({
  ...evidence,
  body,
  admit: (request, env) => {
    const input = admit(request, env)

    return isNotEmulated(input) ? input : { plan: (state, context) => plan(state, input, context) }
  }
})

/** Route evidence without the handler parts. */
export const routeEvidence = <State, Env>({
  body: _body,
  admit: _admit,
  origin: _origin,
  params: _params,
  ...evidence
}: StatefulRoute<State, Env>): EmulatorRouteEvidence => evidence

/** A percent-decoded path segment, or `undefined` for invalid percent-encoding. */
export const decodeSegment = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

// `{name}` is one path segment; `{name+}` is one or more segments.
const templatePattern = (template: string): RegExp =>
  new RegExp(
    `^${template
      .split(/(\{[A-Za-z]+\+?\})/)
      .map(part =>
        /^\{[A-Za-z]+\}$/.test(part)
          ? '([^/]+)'
          : /^\{[A-Za-z]+\+\}$/.test(part)
            ? '(.+)'
            : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      )
      .join('')}$`
  )

const templateNames = (template: string): ReadonlyArray<string> =>
  [...template.matchAll(/\{([A-Za-z]+)\+?\}/g)].map(match => match[1] ?? '')

/**
 * A multi-segment parameter decoded segment by segment (each once), or `undefined` for an empty
 * segment, invalid percent-encoding, or a segment that decodes to a `/`.
 */
const decodeSegments = (raw: string): string | undefined => {
  const segments = raw.split('/').map(segment => {
    const decoded = segment === '' ? undefined : decodeSegment(segment)

    return decoded === undefined || decoded.includes('/') ? undefined : decoded
  })

  return segments.some(segment => segment === undefined) ? undefined : segments.join('/')
}

export type MatchedRoute<State, Env> = {
  readonly route: StatefulRoute<State, Env>
  readonly params: Readonly<Record<string, string>>
}

/**
 * A matcher over a route table: the route answering `method` + raw `path`, with its parameters
 * decoded once, or `undefined` (also for a parameter that is not valid percent-encoding).
 */
export const routeMatcher = <State, Env>(routes: ReadonlyArray<StatefulRoute<State, Env>>) => {
  const keys = routes.map(route => emulatorRouteKey(route.method, route.path))
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index)

  if (duplicate !== undefined) {
    throw new Error(`duplicate emulator route ${duplicate}`)
  }

  const compiled = routes.map(route => ({
    route,
    pattern: templatePattern(route.path),
    names: templateNames(route.path),
    multi: new Set([...route.path.matchAll(/\{([A-Za-z]+)\+\}/g)].map(match => match[1] ?? ''))
  }))

  return (method: string, path: string): MatchedRoute<State, Env> | undefined => {
    for (const candidate of compiled) {
      if (candidate.route.method !== method.toUpperCase()) continue

      const match = candidate.pattern.exec(path)

      if (match === null) continue

      const raws = candidate.names.map((name, index) => [name, match[index + 1] ?? ''] as const)

      // A raw parameter outside its pattern is no shape of this route.
      if (raws.some(([name, raw]) => candidate.route.params?.[name]?.test(raw) === false)) {
        continue
      }

      const params: Record<string, string> = {}

      for (const [name, raw] of raws) {
        const value = candidate.multi.has(name) ? decodeSegments(raw) : decodeSegment(raw)

        if (value === undefined) return undefined

        params[name] = value
      }

      return { route: candidate.route, params }
    }

    return undefined
  }
}

/** The template parameters of a route that have no raw pattern (fail-closed emulators need one). */
export const unpatternedParams = <State, Env>(
  route: StatefulRoute<State, Env>
): ReadonlyArray<string> => templateNames(route.path).filter(name => !route.params?.[name])

const decodeJsonText = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))

/** Parsed JSON, or `undefined` for invalid JSON. */
export const parseJsonText = (text: string): Schema.Json | undefined => {
  const result = decodeJsonText(text)

  return Result.isSuccess(result) ? result.success : undefined
}

export const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  value !== undefined && value !== null && Predicate.isObject(value) && !Array.isArray(value)

/** The media type of a `content-type` value (lower-case, without parameters). */
export const mediaType = (value: string | undefined): string =>
  (value ?? '').split(';')[0]?.trim().toLowerCase() ?? ''

/**
 * A JSON object with exactly the `required` keys plus any of the `optional` ones, or not
 * emulated (naming the first missing or unknown key).
 */
export const exactObject = (
  value: Schema.Json | undefined,
  label: string,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = []
): Schema.JsonObject | NotEmulated => {
  if (!isJsonObject(value)) return notEmulated(`${label} must be a JSON object`)

  const unknown = Object.keys(value).find(key => !required.includes(key) && !optional.includes(key))

  if (unknown !== undefined) return notEmulated(`${label} key '${unknown}' is not emulated`)

  const missing = required.find(key => !(key in value))

  return missing === undefined
    ? value
    : notEmulated(`${label} without '${missing}' is not emulated`)
}

/** An integer in `[minimum, maximum]`, or not emulated. */
export const integerIn = (
  value: Schema.Json | undefined,
  label: string,
  minimum: number,
  maximum: number
): number | NotEmulated =>
  Predicate.isNumber(value) && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : notEmulated(`${label} must be an integer from ${minimum} to ${maximum}`)

/** Error-input kinds of the JS API. */
export type StatefulInputKind = 'seed' | 'fault' | 'option'

/** The core runtime the Node subpath creates (state, snapshot, restore), as the wrapper uses it. */
export type StatefulCore<State> = {
  readonly fetch: (request: Request) => Promise<Response>
  readonly baseUrl: string
  readonly snapshot: () => State
  readonly restore: (state: State) => Promise<void>
  readonly close: () => Promise<void>
}

/**
 * What the core runs for a request the wrapper forwarded: `(state, request)` to a response. The
 * Node subpath registers it as the core app's only route.
 */
export type CoreDispatch<State> = (state: State, request: Request) => Response

/** A request header the ledger records. */
export type RecordedHeader = { readonly name: string; readonly json: boolean }

/**
 * Fail-closed mode: the constant reasons ledgered and answered for an unrecognised request (no
 * emulated route shape) and for an unrecognisable `Authorization` header. Nothing the request
 * carries is ledgered or answered for either.
 */
export type StatefulFailClosed = {
  readonly unrecognised: string
  readonly unrecognisedAuthorization: string
}

export type StatefulEmulatorConfig<State, Env> = {
  readonly routes: ReadonlyArray<StatefulRoute<State, Env>>
  readonly env: Env
  readonly initial: State
  /** Decode and build a seed; a string is why it is invalid. */
  readonly buildSeed: (input: unknown) => State | string
  /** Header rules every request must meet (after the credential); a string is not emulated. */
  readonly requestProblem?: (header: (name: string) => string | undefined) => string | undefined
  /**
   * Non-credential request headers the ledger records (lower-case names). A `json` header is
   * parsed and its credential-named keys redacted at any depth; an unparseable value is recorded
   * as `<redacted>`. A credential header name is refused when the emulator is built.
   */
  readonly recordHeaders: ReadonlyArray<RecordedHeader>
  /**
   * Opt-in fail-closed mode (see the module header): constant-text ledger entries for unrecognised
   * requests and Authorization headers, and the bearer value guarded as a secret. Every route
   * parameter must have a raw pattern (checked when the emulator is built).
   */
  readonly failClosed?: StatefulFailClosed
  /** Clear runtime data (cursors) on reset and seed. */
  readonly clearRuntime: () => void
  /** Extra `/_emulate/state` fields (runtime data). */
  readonly runtimeState: () => Schema.JsonObject
  /** The `/_emulate/seed` answer for a new state. */
  readonly seedSummary: (state: State) => Schema.JsonObject
  readonly inputInvalid: (input: StatefulInputKind, reason: string) => Error
}

export type StatefulEmulatorApi<State, Seed> = {
  /**
   * The fetch handler (API routes and `/_emulate/*`); a request arrives on the origin of its URL.
   * Never rejects.
   */
  readonly fetch: (request: Request) => Promise<Response>
  /**
   * The fetch handler for requests that arrive on `origin` whatever their URL says (serve it on
   * a loopback server behind `EmulatedHttpClient`, which rewrites the origin). Never rejects.
   */
  readonly fetchOn: (origin: string) => (request: Request) => Promise<Response>
  readonly ledger: {
    readonly entries: () => ReadonlyArray<StatefulLedgerEntry>
    readonly clear: () => void
  }
  readonly faults: {
    /** Add a fault; throws the emulator's input-invalid error for an invalid fault. */
    readonly add: (fault: StatefulFault) => StatefulFaultState
    readonly list: () => ReadonlyArray<StatefulFaultState>
    readonly clear: () => void
  }
  /** Restore the current seed and clear the ledger, faults, and runtime data (cursors). */
  readonly reset: () => Promise<void>
  /**
   * Replace the state with a new seed, which becomes what `reset` restores (runtime data is
   * cleared). Rejects with the emulator's input-invalid error for an invalid seed.
   */
  readonly seed: (seed: Seed) => Promise<void>
  /** A deep copy of the current state. */
  readonly snapshot: () => State
  readonly coverage: () => StatefulCoverage
  /** Close the core runtime. Later requests answer 503. Idempotent. */
  readonly close: () => Promise<void>
}

const strict = { onExcessProperty: 'error' } as const

const decodeFault = Schema.decodeUnknownResult(StatefulFault, strict)

const decodeFaultList = Schema.decodeUnknownResult(
  Schema.Union([StatefulFault, Schema.Struct({ faults: Schema.Array(StatefulFault) })]),
  strict
)

const issueMessage = (issue: Schema.SchemaError['issue']): string =>
  new Schema.SchemaError(issue).message

// A non-empty bearer credential. The value is never checked, stored, forwarded, or ledgered.
const bearerPattern = /^bearer\s+\S+/i

/**
 * Fail-closed mode: exactly one bearer of at least 8 non-space characters (no extra words, so
 * combined duplicate headers never match). The value is guarded, never checked or stored.
 */
const recognisableBearerPattern = /^bearer\s+(\S{8,})\s*$/i

const missingBearerReason =
  'requests without Authorization: Bearer <token of at least 8 characters> are not emulated'

const pathMatches = (pattern: string, path: string): boolean =>
  pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : pattern === path

const faultMatches = (fault: StatefulFault, method: string, path: string): boolean =>
  (fault.match?.method === undefined || fault.match.method.toUpperCase() === method) &&
  (fault.match?.path === undefined || pathMatches(fault.match.path, path))

const faultBody = (status: number): Schema.Json => ({
  error: { type: 'emulator_fault', message: `Emulator fault: status ${status}.` }
})

const readText = (request: Request): Promise<string | undefined> =>
  request.text().then(
    text => text,
    () => undefined
  )

const readBytes = (request: Request): Promise<Uint8Array | undefined> =>
  request.arrayBuffer().then(
    buffer => new Uint8Array(buffer),
    () => undefined
  )

const isControlPath = (path: string): boolean =>
  path === '/_emulate' || path.startsWith('/_emulate/')

/**
 * Header the wrapper sets on core requests: the id of the forwarded job, from a counter that
 * never resets (the ledger sequence does), so a ledger clear never makes two jobs share an id.
 */
const jobIdHeader = 'x-emulator-job-id'

type MutableLedgerEntry = {
  seq: number
  method: string
  path: string
  route?: string
  query: Readonly<Record<string, string>>
  body?: Schema.Json
  bodyBytes?: number
  headers: Record<string, string>
  status: number
  evidence: EmulatorEvidence | 'unknown-route'
  notEmulated?: string
  fault?: 'status'
  responseError?: string
}

type MutableFaultState = {
  readonly id: number
  readonly fault: StatefulFault
  remaining: number | undefined
  applied: number
}

type Job<State, Env> = {
  readonly admission: Admission<State, Env>
  /** Ledger sequence number of the request (for synthetic request ids). */
  readonly seq: number
  /** Answers the first matching fault (consuming it), or `undefined` when none matches. */
  readonly decideFault: () => Response | undefined
  /** Guarded credential values, scrubbed from a plan's not-emulated reason. */
  readonly secrets: ReadonlyArray<string>
  notEmulated?: string
}

const withEvidence = (response: Response, evidence: EmulatorEvidence): Response => {
  const headers = new Headers(response.headers)

  if (evidence === 'unverified') {
    headers.set(emulatorEvidenceHeader, 'unverified')
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

/**
 * The recorded query: credential-named keys redacted, and any value that parses as a JSON object or
 * array (Dropbox's browser-style `arg` parameter, for example) recorded with its credential-named
 * keys redacted at any depth, and a JSON-looking value that does not parse recorded as `<redacted>`,
 * as a recorded JSON header is.
 */
const recordedQuery = (query: URLSearchParams): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(redactCredentialQuery(query)).map(([key, value]) => {
      if (!value.trimStart().startsWith('{') && !value.trimStart().startsWith('[')) {
        return [key, value]
      }

      // A JSON-looking value that does not parse cannot be redacted field by field: record it
      // whole as redacted, as a recorded JSON header is.
      const parsed = parseJsonText(value)

      return [
        key,
        parsed === undefined
          ? redactedCredentialValue
          : JSON.stringify(redactCredentialFields(parsed))
      ]
    })
  )

/** A recorded header value: JSON with credential-named keys redacted, or the plain value. */
const recordedHeaderValue = (header: RecordedHeader, value: string): string => {
  if (!header.json) return value

  const parsed = parseJsonText(value)

  return parsed === undefined
    ? redactedCredentialValue
    : JSON.stringify(redactCredentialFields(parsed))
}

const snapshotEntry = (entry: MutableLedgerEntry): StatefulLedgerEntry => ({
  ...entry,
  query: { ...entry.query },
  headers: { ...entry.headers }
})

const snapshotFault = (state: MutableFaultState): StatefulFaultState => ({ ...state })

/**
 * Build the wrapper over a core runtime. `createCore` receives the dispatch the core must run for
 * every request (its only route) and returns the runtime adapter.
 */
export const makeStatefulEmulator = async <State, Env, Seed>(
  config: StatefulEmulatorConfig<State, Env>,
  createCore: (dispatch: CoreDispatch<State>) => Promise<StatefulCore<State>>
): Promise<StatefulEmulatorApi<State, Seed>> => {
  const credentialHeader = config.recordHeaders.find(header => isCredentialHeaderName(header.name))

  if (credentialHeader !== undefined) {
    throw new Error(`the ledger never records the credential header ${credentialHeader.name}`)
  }

  if (config.failClosed !== undefined) {
    for (const route of config.routes) {
      const missing = unpatternedParams(route)

      if (missing.length > 0) {
        throw new Error(
          `fail-closed route ${route.method} ${route.path} needs raw patterns for ${missing.join(', ')}`
        )
      }
    }
  }

  const match = routeMatcher(config.routes)
  const manifest = config.routes.map(routeEvidence)
  const jobs = new Map<number, Job<State, Env>>()
  let nextJobId = 1

  // Plan, fault decision, and commit run synchronously together: no request interleaves.
  const dispatch: CoreDispatch<State> = (state, request) => {
    const job = jobs.get(Number(request.headers.get(jobIdHeader) ?? 'NaN'))

    if (job === undefined) return handlerFailedResponse()

    try {
      const planned = job.admission.plan(state, { env: config.env, seq: job.seq })

      if (isNotEmulated(planned)) {
        const reason = scrubSecrets(planned.reason, job.secrets)

        job.notEmulated = reason

        return notEmulatedResponse(reason)
      }

      return job.decideFault() ?? planned()
    } catch {
      return handlerFailedResponse()
    }
  }

  const core = await createCore(dispatch)

  let baseline: State = config.initial
  let entries: Array<MutableLedgerEntry> = []
  let faultStates: Array<MutableFaultState> = []
  let nextSeq = 1
  let nextFaultId = 1
  let closed = false

  const clearLedger = () => {
    entries = []
    nextSeq = 1
  }

  const addFault = (input: unknown): StatefulFaultState | string => {
    const decoded = decodeFault(input)

    if (Result.isFailure(decoded)) {
      return issueMessage(decoded.failure.issue)
    }

    const state: MutableFaultState = {
      id: nextFaultId++,
      fault: decoded.success,
      remaining: decoded.success.count,
      applied: 0
    }

    faultStates.push(state)

    return snapshotFault(state)
  }

  const takeFault = (method: string, path: string): MutableFaultState | undefined =>
    faultStates.find(
      state =>
        (state.remaining === undefined || state.remaining > 0) &&
        faultMatches(state.fault, method, path)
    )

  /** Build the fault's response first: a response that cannot be built must not consume it. */
  const applyFault = (state: MutableFaultState): Response => {
    const headers = new Headers(state.fault.headers ?? {})
    const body = state.fault.body ?? faultBody(state.fault.status)

    if (!headers.has('content-type')) {
      headers.set('content-type', Predicate.isString(body) ? 'text/plain' : 'application/json')
    }

    const response = new Response(Predicate.isString(body) ? body : JSON.stringify(body), {
      status: state.fault.status,
      headers
    })

    state.applied += 1

    if (state.remaining !== undefined) {
      state.remaining -= 1
    }

    return response
  }

  const reset = async () => {
    clearLedger()
    faultStates = []
    config.clearRuntime()
    await core.restore(baseline)
  }

  const reseed = async (input: unknown): Promise<State | string> => {
    const next = config.buildSeed(input)

    if (Predicate.isString(next)) {
      return next
    }

    await core.restore(next)
    config.clearRuntime()
    baseline = next

    return next
  }

  const coverage = (): StatefulCoverage => ({
    routes: manifest.map(route => ({
      ...route,
      requests: entries.filter(
        entry => entry.route === route.path && entry.method.toUpperCase() === route.method
      ).length
    })),
    unknownRouteRequests: entries.filter(entry => entry.evidence === 'unknown-route').length,
    notEmulatedRequests: entries.filter(entry => entry.notEmulated !== undefined).length
  })

  /** The ledgered 400; the reason is scrubbed of the request's guarded secrets first. */
  const refuse = (
    entry: MutableLedgerEntry,
    reason: string,
    secrets: ReadonlyArray<string> = []
  ): Response => {
    const safe = scrubSecrets(reason, secrets)

    entry.notEmulated = safe

    return notEmulatedResponse(safe)
  }

  /** True when a body text, raw or parsed as JSON (keys, strings, numbers), repeats a secret. */
  const bodyRepeatsSecret = (text: string, secrets: ReadonlyArray<string>): boolean => {
    if (secrets.length === 0) return false

    if (repeatsSecret(text, secrets)) return true

    const parsed = text === '' ? undefined : parseJsonText(text)

    // Normalised forms (`\u0051` escapes, `1.2345678e7` numbers) only show once parsed: every key,
    // string value, and number is checked, and so is the value as it would be recorded.
    return (
      parsed !== undefined &&
      (jsonRepeatsSecret(parsed, secrets) || repeatsSecret(JSON.stringify(parsed), secrets))
    )
  }

  /** Everything after the route match: credential, headers, body, shape, then the core. */
  const routed = async (
    request: Request,
    url: URL,
    entry: MutableLedgerEntry,
    matched: MatchedRoute<State, Env>,
    secrets: ReadonlyArray<string>
  ): Promise<Response> => {
    const header = (name: string): string | undefined =>
      isCredentialHeaderName(name) ? undefined : (request.headers.get(name) ?? undefined)

    const refused = (reason: string) => refuse(entry, reason, secrets)

    if (config.failClosed === undefined) {
      if (!bearerPattern.test(request.headers.get('authorization') ?? '')) {
        return refused('a non-empty Authorization: Bearer credential is required')
      }
    } else {
      // The header is absent here (an unrecognisable one never reaches a route).
      if (secrets.length === 0) return refused(missingBearerReason)

      if (repeatsSecret(url.search, secrets)) return refused('the query repeats the credential')

      if (repeatsSecret(url.pathname, secrets)) {
        return refused('the request path repeats the credential')
      }
    }

    const problem = config.requestProblem?.(header)

    if (problem !== undefined) return refused(problem)

    let json: Schema.Json | undefined
    let bytes: Uint8Array | undefined

    switch (matched.route.body) {
      case 'none': {
        const text = await readText(request)

        if (text !== undefined && bodyRepeatsSecret(text, secrets)) {
          return refused('the request body repeats the credential')
        }

        if (text === undefined || text !== '') {
          return refused('this route takes no request body')
        }

        break
      }

      case 'json': {
        const text = await readText(request)

        // Checked first: a body that repeats a secret is never parsed into the ledger.
        if (text !== undefined && bodyRepeatsSecret(text, secrets)) {
          return refused('the request body repeats the credential')
        }

        if (mediaType(header('content-type')) !== 'application/json') {
          return refused('this route takes a content-type: application/json body')
        }

        const parsed = text === undefined ? undefined : parseJsonText(text)

        if (parsed === undefined) return refused('the request body is not valid JSON')

        // Redacted before it is stored: a refused request's body stays in the ledger too.
        entry.body = redactCredentialFields(parsed)
        json = parsed

        break
      }

      case 'bytes': {
        bytes = await readBytes(request)

        if (bytes === undefined) return refused('the request body is unreadable')

        if (bodyRepeatsSecret(new TextDecoder().decode(bytes), secrets)) {
          return refused('the request body repeats the credential')
        }

        entry.bodyBytes = bytes.byteLength

        break
      }
    }

    const admitted = matched.route.admit(
      {
        method: request.method.toUpperCase(),
        path: url.pathname,
        params: matched.params,
        query: url.searchParams,
        header,
        json,
        bytes
      },
      config.env
    )

    if (isNotEmulated(admitted)) return refused(admitted.reason)

    const method = request.method.toUpperCase()
    const jobId = nextJobId++

    const job: Job<State, Env> = {
      admission: admitted,
      seq: entry.seq,
      secrets,
      decideFault: () => {
        const fault = takeFault(method, url.pathname)

        if (fault === undefined) return undefined

        const response = applyFault(fault)

        entry.fault = 'status'

        return response
      }
    }

    jobs.set(jobId, job)

    try {
      const response = await core.fetch(
        new Request(new URL(url.pathname, core.baseUrl), {
          method: 'POST',
          headers: { [jobIdHeader]: String(jobId) }
        })
      )

      if (response.headers.has(handlerFailedHeader)) {
        entry.responseError = 'the route handler failed'

        return emulatorError(500, 'the emulator could not build the response')
      }

      if (job.notEmulated !== undefined) entry.notEmulated = job.notEmulated

      return response
    } finally {
      jobs.delete(jobId)
    }
  }

  /** Fail closed: an unrecognised request is ledgered and answered with constant text only. */
  const unrecognised = (request: Request, reason: string): Response => {
    entries.push({
      seq: nextSeq++,
      method: unrecognisedMethod(request.method.toUpperCase()),
      path: unrecognisedLedgerPath,
      query: {},
      headers: {},
      status: 400,
      evidence: 'unknown-route',
      notEmulated: reason
    })

    return notEmulatedResponse(reason)
  }

  const emulatedApi = async (request: Request, url: URL, arrivedOn: string): Promise<Response> => {
    const matched = match(request.method, url.pathname)
    const failClosed = config.failClosed
    let secrets: ReadonlyArray<string> = []

    if (failClosed !== undefined) {
      const authorization = request.headers.get('authorization')
      const bearer = recognisableBearerPattern.exec(authorization ?? '')?.[1]

      // Its credential cannot be extracted and scrubbed: nothing of the request is kept.
      if (authorization !== null && bearer === undefined) {
        return unrecognised(request, failClosed.unrecognisedAuthorization)
      }

      if (matched === undefined) return unrecognised(request, failClosed.unrecognised)

      secrets = bearer === undefined ? [] : [bearer]
    }

    const scrub = (text: string): string => scrubSecrets(text, secrets)

    const entry: MutableLedgerEntry = {
      seq: nextSeq++,
      method: scrub(request.method),
      path: scrub(url.pathname),
      // Query keys and values are scrubbed of the request's secrets before they are recorded.
      query: Object.fromEntries(
        Object.entries(recordedQuery(url.searchParams)).map(([key, value]) => [
          scrub(key),
          scrub(value)
        ])
      ),
      headers: {},
      status: 0,
      evidence: matched?.route.evidence ?? 'unknown-route'
    }

    for (const header of config.recordHeaders) {
      const value = request.headers.get(header.name)

      if (value !== null) entry.headers[header.name] = scrub(recordedHeaderValue(header, value))
    }

    entries.push(entry)

    if (matched === undefined) {
      entry.status = 400

      return refuse(entry, 'no emulated route for this method and path')
    }

    entry.route = matched.route.path

    if (matched.route.origin !== undefined && matched.route.origin !== arrivedOn) {
      entry.status = 400

      return withEvidence(
        refuse(entry, `this route is recorded on ${matched.route.origin} only`, secrets),
        matched.route.evidence
      )
    }

    // Error recovery still answers through the route: the fallback 500 is evidence-tagged and
    // the ledger records the status actually sent.
    const response = await routed(request, url, entry, matched, secrets).catch(() => {
      entry.responseError = 'the emulator could not build or produce the response'

      return emulatorError(500, 'the emulator could not build the response')
    })

    const tagged = withEvidence(response, matched.route.evidence)

    entry.status = tagged.status

    return tagged
  }

  const controlPlane = async (request: Request, path: string): Promise<Response> => {
    const method = request.method
    const allow = (methods: string) => emulatorError(405, 'method not allowed', { allow: methods })

    const jsonBody = async (): Promise<Schema.Json | undefined> => {
      const text = await readText(request)

      return text === undefined ? undefined : parseJsonText(text)
    }

    switch (path) {
      case '/_emulate/ledger':
        if (method === 'GET') {
          return jsonResponse(200, { entries: entries.map(snapshotEntry) })
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
          return emulatorError(400, `invalid fault: ${issueMessage(decoded.failure.issue)}`)
        }

        const faults = 'faults' in decoded.success ? decoded.success.faults : [decoded.success]

        return jsonResponse(201, { faults: faults.map(fault => addFault(fault)) })
      }

      case '/_emulate/reset':
        if (method !== 'POST') {
          return allow('POST')
        }

        await reset()

        return jsonResponse(200, { reset: true })

      case '/_emulate/state':
        if (method !== 'GET') {
          return allow('GET')
        }

        return jsonResponse(200, {
          state: core.snapshot(),
          ...config.runtimeState(),
          faults: faultStates.map(snapshotFault),
          ledgerEntries: entries.length
        })

      case '/_emulate/seed': {
        if (method !== 'POST') {
          return allow('POST')
        }

        const next = await reseed((await jsonBody()) ?? null)

        if (Predicate.isString(next)) {
          return emulatorError(400, `invalid seed: ${next}`)
        }

        return jsonResponse(200, { seeded: true, ...config.seedSummary(next) })
      }

      case '/_emulate/coverage':
        if (method !== 'GET') {
          return allow('GET')
        }

        return jsonResponse(200, coverage())

      default:
        return emulatorError(404, 'unknown control-plane route')
    }
  }

  /**
   * Last resort when handling itself fails (for example an unparseable request URL): a 500
   * emulator error, tagged with the matched route's evidence when there is one.
   */
  const lastResort = (request: Request): Response => {
    const path = URL.canParse(request.url) ? new URL(request.url).pathname : undefined
    const failed = emulatorError(500, 'the emulator failed to handle the request')

    if (path === undefined || isControlPath(path)) return failed

    const matched = match(request.method, path)

    return matched === undefined ? failed : withEvidence(failed, matched.route.evidence)
  }

  const handle = async (request: Request, origin: string | undefined): Promise<Response> => {
    if (closed) {
      return emulatorError(503, 'the emulator is closed')
    }

    const url = new URL(request.url)

    return isControlPath(url.pathname)
      ? controlPlane(request, url.pathname)
      : emulatedApi(request, url, origin ?? url.origin)
  }

  const fetchOn =
    (origin: string | undefined) =>
    (request: Request): Promise<Response> =>
      handle(request, origin).catch(() => lastResort(request))

  return {
    fetch: fetchOn(undefined),
    fetchOn: origin => fetchOn(origin),
    ledger: {
      entries: () => entries.map(snapshotEntry),
      clear: clearLedger
    },
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
    reset,
    seed: async input => {
      const next = await reseed(input)

      if (Predicate.isString(next)) {
        throw config.inputInvalid('seed', next)
      }
    },
    snapshot: () => core.snapshot(),
    coverage,
    close: () => {
      closed = true

      return core.close()
    }
  }
}

/** Throws `inputInvalid('option', ...)` unless every drill knob is a known boolean (or absent). */
export const checkBooleanDrills = (
  drills: object | undefined,
  knobs: ReadonlyArray<string>,
  inputInvalid: (input: StatefulInputKind, reason: string) => Error
): void => {
  for (const [key, value] of Object.entries(drills ?? {})) {
    if (!knobs.includes(key)) {
      throw inputInvalid('option', `unknown drill knob ${key}`)
    }

    if (value !== undefined && !Predicate.isBoolean(value)) {
      throw inputInvalid('option', `drills.${key} must be a boolean`)
    }
  }
}
