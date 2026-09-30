/**
 * Stateful Microsoft Graph emulator (`/v1.0` on `https://graph.microsoft.com`, plus the OneDrive
 * copy monitor URL on the SharePoint origin), built on the upstream `@emulators/core` custom
 * runtime, with a request ledger, wire faults, and an `/_emulate/*` control plane.
 *
 * It never imports SDK code: its wire shapes and default seed are copied as data from the
 * synthetic Microsoft conformance fixtures, and every route names the conformance cases it
 * follows in `microsoftEmulatorRoutes`. Only the routes those eleven cases need are emulated;
 * everything else fails closed with the Graph error envelope.
 *
 * Node-only: `@emulators/core` imports Node builtins, so the core is loaded lazily by
 * `makeMicrosoftEmulator` (importing this module has no side effects).
 *
 * @experimental
 */
import type { EmulatorSnapshot } from '@emulators/core'
import { Data, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  EmulatorHeaderRecord,
  EmulatorResponseStatus,
  handlerFailedHeader,
  redactCredentialFields,
  redactCredentialQuery
} from './emulator-http.ts'
import {
  matchMicrosoftRoute,
  microsoftApiRoutes,
  registerMicrosoftApi,
  requestSeqHeader
} from './microsoft/api.ts'
import {
  codes,
  errorContext,
  graphError,
  parseJsonText,
  type CopyMonitor,
  type ErrorContext,
  type MicrosoftApiEnv,
  type MicrosoftEmulatorDrills
} from './microsoft/graph.ts'
import {
  buildSeedState,
  decodeState,
  type MicrosoftEmulatorSeed,
  type MicrosoftEmulatorState
} from './microsoft/state.ts'
import {
  emulatorEvidenceHeader,
  type EmulatorEvidence,
  type EmulatorRouteEvidence
} from './route-evidence.ts'

export type { EmulatorEvidence, EmulatorRouteEvidence } from './route-evidence.ts'

export { emulatorEvidenceHeader } from './route-evidence.ts'

export { microsoftEmulatorBasePath } from './microsoft/api.ts'

export { microsoftEmulatorErrorCodes, type MicrosoftEmulatorDrills } from './microsoft/graph.ts'

export {
  MicrosoftEmulatorAttachment,
  MicrosoftEmulatorAttachmentSeed,
  MicrosoftEmulatorCalendar,
  MicrosoftEmulatorDrive,
  MicrosoftEmulatorDriveItem,
  MicrosoftEmulatorDriveItemSeed,
  MicrosoftEmulatorEvent,
  MicrosoftEmulatorEventSeed,
  MicrosoftEmulatorMailFolder,
  MicrosoftEmulatorMessage,
  MicrosoftEmulatorMessageSeed,
  MicrosoftEmulatorProfile,
  MicrosoftEmulatorRecipient,
  MicrosoftEmulatorSeed,
  MicrosoftEmulatorStateSchema,
  MicrosoftEmulatorUser,
  type MicrosoftEmulatorState
} from './microsoft/state.ts'

/** Origin the connector calls; also the origin of `@odata.nextLink` values. */
export const microsoftEmulatorDefaultOrigin = 'https://graph.microsoft.com'

/**
 * Origin of OneDrive `webUrl` values and copy monitor URLs (the fixtures' synthetic SharePoint
 * host). Route it to the same emulator as the Graph origin.
 */
export const microsoftEmulatorDefaultSharePointOrigin = 'https://synthetic-my.sharepoint.com'

/**
 * Route evidence manifest: every emulated route, whether it writes, and the conformance cases
 * whose (currently synthetic, unverified) wire claims it follows. Kept in sync with the handlers
 * by construction (both come from one route table). The monitor route lives on the SharePoint
 * origin; every other route on the Graph origin.
 */
export const microsoftEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> = microsoftApiRoutes.map(
  ({ handler: _handler, queryKeys: _queryKeys, auth: _auth, ...evidence }) => evidence
)

const FaultCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** Optional fault filter; an omitted field matches every request. `path` ending in `*` is a prefix. */
export const MicrosoftFaultMatch = Schema.Struct({
  method: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String)
})

export type MicrosoftFaultMatch = typeof MicrosoftFaultMatch.Type

/**
 * A wire fault: answer matching requests with this status, headers, and body (for example 429
 * with `retry-after`) before the route runs, so nothing is written. The body defaults to a Graph
 * error envelope. `count` limits how many requests it answers (omitted: all). `match.path` is
 * the raw request path (`/v1.0/users/ada%40example.test/...`).
 *
 * The shared emulator rules apply: statuses that cannot carry a body (1xx, 204, 205) and
 * redirects (3xx) are rejected, as are invalid header names or values, a `location` header, and
 * framing headers (`content-length`, `transfer-encoding`, `connection`, `keep-alive`, `upgrade`).
 */
export const MicrosoftFault = Schema.Struct({
  kind: Schema.Literal('status'),
  status: EmulatorResponseStatus,
  headers: Schema.optionalKey(EmulatorHeaderRecord),
  body: Schema.optionalKey(Schema.Json),
  match: Schema.optionalKey(MicrosoftFaultMatch),
  count: Schema.optionalKey(FaultCount)
})

export type MicrosoftFault = typeof MicrosoftFault.Type

/** Invalid emulator input from the JS API: a seed, a fault, or an option. A programmer error. */
export class MicrosoftEmulatorInputInvalid extends Data.TaggedError(
  'MicrosoftEmulatorInputInvalid'
)<{
  readonly input: 'seed' | 'fault' | 'option'
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid Microsoft emulator ${this.input}: ${this.reason}`
  }
}

export type MicrosoftLedgerEntry = {
  /** 1-based arrival order since the last ledger clear or reset. */
  readonly seq: number
  readonly method: string
  /** Raw request path, for example `/v1.0/users/ada%40example.test/messages`. */
  readonly path: string
  /** Path template of the matched route, for example `/v1.0/users/{userId}/messages`. */
  readonly route?: string
  /** Query parameters; the values of credential-named keys (`access_token`) are `<redacted>`. */
  readonly query: Readonly<Record<string, string>>
  /**
   * Parsed JSON request body, when there was one, with every credential-named key's value
   * (for example a `$batch` subrequest's `Authorization` header) replaced by `<redacted>`.
   */
  readonly body?: Schema.Json
  /** The `Prefer` header, when sent (never a credential). */
  readonly prefer?: string
  readonly status: number
  /** Evidence of the matched route; `unknown-route` for requests that failed closed. */
  readonly evidence: EmulatorEvidence | 'unknown-route'
  /** Set when a fault answered the request. */
  readonly fault?: 'status'
  /**
   * Set when the emulator could not build or produce the response, or a route handler threw; the
   * request was answered with a 500 Graph error envelope (still evidence-tagged) and no fault was
   * used up.
   */
  readonly responseError?: string
}

export type MicrosoftFaultState = {
  readonly id: number
  readonly fault: MicrosoftFault
  /** Remaining matching requests; `undefined` for an unlimited fault. */
  readonly remaining: number | undefined
  readonly applied: number
}

export type MicrosoftRouteCoverage = EmulatorRouteEvidence & {
  /** Ledger requests answered by this route since the last ledger clear or reset. */
  readonly requests: number
}

export type MicrosoftCoverage = {
  readonly routes: ReadonlyArray<MicrosoftRouteCoverage>
  /** Ledger requests to unknown routes (failed closed). */
  readonly unknownRouteRequests: number
}

/** A copy monitor as reported by `/_emulate/state` and `monitors()`. */
export type MicrosoftCopyMonitorState = {
  readonly id: string
  readonly sourceId: string
  readonly destinationParentId: string
  readonly pollsLeft: number
  readonly status: 'inProgress' | 'completed'
  readonly resourceId?: string
}

export type MicrosoftEmulatorOptions = {
  /** Typed seed; defaults to the fixture entities (`profile: 'default'`). */
  readonly seed?: MicrosoftEmulatorSeed
  /** Clock in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Origin of `@odata.nextLink` values. Defaults to `https://graph.microsoft.com`. */
  readonly baseUrl?: string
  /** Origin of `webUrl` values and monitor URLs. Defaults to `https://synthetic-my.sharepoint.com`. */
  readonly sharePointOrigin?: string
  /**
   * In-progress monitor answers before a copy completes (integer 0-100, default 0: the first poll
   * completes, as the copy fixture records).
   */
  readonly copyInProgressPolls?: number
  /**
   * How long (ms, integer 0-10000, default 25) the first message write to reach the handler holds
   * its message; an overlapping write to that message gets 409. Non-overlapping writes both apply
   * (an emulator extrapolation). `0` only rejects writes that overlap the handler itself.
   */
  readonly conflictWindowMs?: number
  /** Drill knobs (tests only): make the emulator disagree with one conformance claim. */
  readonly drills?: MicrosoftEmulatorDrills
}

export type MicrosoftEmulator = {
  /** The fetch handler (Graph routes, the copy monitor, and `/_emulate/*`). Never rejects. */
  readonly fetch: (request: Request) => Promise<Response>
  /** Origin of `@odata.nextLink` values. */
  readonly baseUrl: string
  /** Origin of `webUrl` values and monitor URLs; route it to this emulator too. */
  readonly sharePointOrigin: string
  readonly ledger: {
    readonly entries: () => ReadonlyArray<MicrosoftLedgerEntry>
    readonly clear: () => void
  }
  readonly faults: {
    /** Add a fault; throws `MicrosoftEmulatorInputInvalid` for an invalid fault. */
    readonly add: (fault: MicrosoftFault) => MicrosoftFaultState
    readonly list: () => ReadonlyArray<MicrosoftFaultState>
    readonly clear: () => void
  }
  /** The copy monitors created since the last reset or seed. */
  readonly monitors: () => ReadonlyArray<MicrosoftCopyMonitorState>
  /** Restore the current seed and clear the ledger, faults, and copy monitors. */
  readonly reset: () => Promise<void>
  /**
   * Replace the state with a new seed, which becomes what `reset` restores (monitors are
   * cleared). Rejects with `MicrosoftEmulatorInputInvalid` for an invalid seed.
   */
  readonly seed: (seed: MicrosoftEmulatorSeed) => Promise<void>
  /** A deep copy of the current state (entities and counters). */
  readonly snapshot: () => MicrosoftEmulatorState
  readonly coverage: () => MicrosoftCoverage
  /** Close the core runtime. Later requests answer 503. Idempotent. */
  readonly close: () => Promise<void>
}

const strict = { onExcessProperty: 'error' } as const

const decodeFault = Schema.decodeUnknownResult(MicrosoftFault, strict)

const decodeFaultList = Schema.decodeUnknownResult(
  Schema.Union([MicrosoftFault, Schema.Struct({ faults: Schema.Array(MicrosoftFault) })]),
  strict
)

const issueMessage = (issue: Schema.SchemaError['issue']): string =>
  new Schema.SchemaError(issue).message

const jsonResponse = (status: number, body: unknown, headers: HeadersInit = {}): Response => {
  const responseHeaders = new Headers(headers)

  responseHeaders.set('content-type', 'application/json')

  return new Response(JSON.stringify(body), { status, headers: responseHeaders })
}

const controlError = (status: number, message: string, headers: HeadersInit = {}): Response =>
  jsonResponse(status, { error: { message, type: 'emulator_error' } }, headers)

const defaultFaultBody = (context: ErrorContext, status: number): Schema.Json => ({
  error: {
    code: status === 429 ? codes.rateLimited : codes.upstreamError,
    message:
      status === 429 ? 'Synthetic: too many requests.' : `Synthetic upstream error (${status}).`,
    innerError: {
      date: context.date,
      'request-id': context.requestId,
      'client-request-id': context.clientRequestId
    }
  }
})

// A non-empty bearer credential. The value is never checked, stored, forwarded, or ledgered.
const bearerPattern = /^bearer\s+\S+/i

const pathMatches = (pattern: string, path: string): boolean =>
  pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : pattern === path

const faultMatches = (fault: MicrosoftFault, method: string, path: string): boolean =>
  (fault.match?.method === undefined || fault.match.method.toUpperCase() === method) &&
  (fault.match?.path === undefined || pathMatches(fault.match.path, path))

const readText = (request: Request): Promise<string | undefined> =>
  request.text().then(
    text => text,
    () => undefined
  )

const validOrigin = (input: string): string | undefined => {
  if (!URL.canParse(input)) {
    return undefined
  }

  const url = new URL(input)

  const bare =
    (url.pathname === '/' || url.pathname === '') &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === ''

  return (url.protocol === 'http:' || url.protocol === 'https:') && bare ? url.origin : undefined
}

const integerOption = (
  name: string,
  value: number | undefined,
  fallback: number,
  maximum: number
): number => {
  const resolved = value ?? fallback

  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > maximum) {
    throw new MicrosoftEmulatorInputInvalid({
      input: 'option',
      reason: `${name} must be an integer from 0 to ${maximum}`
    })
  }

  return resolved
}

type MutableLedgerEntry = {
  seq: number
  method: string
  path: string
  route?: string
  query: Readonly<Record<string, string>>
  body?: Schema.Json
  prefer?: string
  status: number
  evidence: EmulatorEvidence | 'unknown-route'
  fault?: 'status'
  responseError?: string
}

type MutableFaultState = {
  readonly id: number
  readonly fault: MicrosoftFault
  remaining: number | undefined
  applied: number
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

const isControlPath = (path: string): boolean =>
  path === '/_emulate' || path.startsWith('/_emulate/')

/** The largest instant a JS `Date` holds (ms from the epoch, either way). */
const maxDateMs = 8_640_000_000_000_000

/** Fixed synthetic `innerError.date` for error recovery when the clock fails (the epoch). */
const recoveryDateMs = 0

const monitorState = (monitor: CopyMonitor): MicrosoftCopyMonitorState => {
  const base: MicrosoftCopyMonitorState = {
    id: monitor.id,
    sourceId: monitor.sourceId,
    destinationParentId: monitor.destinationParentId,
    pollsLeft: monitor.pollsLeft,
    status: monitor.resourceId === undefined ? 'inProgress' : 'completed'
  }

  return monitor.resourceId === undefined ? base : { ...base, resourceId: monitor.resourceId }
}

/**
 * Create a stateful Microsoft Graph emulator on the `@emulators/core` custom runtime. Each call
 * has its own state, ledger, faults, and copy monitors. Rejects with
 * `MicrosoftEmulatorInputInvalid` for an invalid seed or option.
 *
 * Graph routes need `Authorization: Bearer <non-empty>` (missing: 401 Graph error envelope); the
 * token is never checked, stored, forwarded to the core, or ledgered. The copy monitor needs no
 * credential. Precedence per request: route match (unknown routes fail closed with a 404 Graph
 * error envelope), authorization, JSON body parsing, then the first matching fault (answered
 * before the route runs, so nothing is written), then the stateful route (whose query allowlist
 * and `If-Match` refusal are checked before its handler). A handler that throws answers a 500
 * Graph error envelope with `responseError` in the ledger, even when the clock throws. Every
 * response from an unverified route carries `x-emulator-evidence: unverified`. Ledgered bodies and
 * query parameters have credential-named keys redacted.
 */
export const makeMicrosoftEmulator = async (
  options: MicrosoftEmulatorOptions = {}
): Promise<MicrosoftEmulator> => {
  const initial = buildSeedState(options.seed ?? {})

  if (Predicate.isString(initial)) {
    throw new MicrosoftEmulatorInputInvalid({ input: 'seed', reason: initial })
  }

  const graphOrigin = validOrigin(options.baseUrl ?? microsoftEmulatorDefaultOrigin)

  const sharePointOrigin = validOrigin(
    options.sharePointOrigin ?? microsoftEmulatorDefaultSharePointOrigin
  )

  if (graphOrigin === undefined || sharePointOrigin === undefined) {
    throw new MicrosoftEmulatorInputInvalid({
      input: 'option',
      reason:
        'baseUrl and sharePointOrigin must be http(s) origins without path, query, hash, or credentials'
    })
  }

  const now = options.now ?? (() => Date.now())

  const env: MicrosoftApiEnv = {
    now,
    graphOrigin,
    sharePointOrigin,
    drills: {
      calendarRangeEmpty: options.drills?.calendarRangeEmpty ?? false,
      createOmitsId: options.drills?.createOmitsId ?? false,
      timestampPrecisionDigits: integerOption(
        'drills.timestampPrecisionDigits',
        options.drills?.timestampPrecisionDigits,
        7,
        7
      ),
      omitNextLink: options.drills?.omitNextLink ?? false
    },
    copyInProgressPolls: integerOption('copyInProgressPolls', options.copyInProgressPolls, 0, 100),
    conflictWindowMs: integerOption('conflictWindowMs', options.conflictWindowMs, 25, 10_000),
    messageLocks: new Set(),
    monitors: new Map(),
    monitorCounter: { next: 1 }
  }

  // Loaded lazily: the core imports Node builtins and reads files at import time.
  const core = await import('@emulators/core')

  const definition = core.defineEmulator<MicrosoftEmulatorState>({
    name: 'microsoft',
    cors: false,
    state: () => initial,
    validateSeed: value => {
      const decoded = decodeState(value)

      if (Predicate.isString(decoded)) {
        throw new MicrosoftEmulatorInputInvalid({ input: 'seed', reason: decoded })
      }

      return decoded
    },
    setup: ({ app, state }) => registerMicrosoftApi(app, state, env)
  })

  const runtime = await core.createCustomRuntime(definition, { seed: initial })

  let baseline: MicrosoftEmulatorState = initial
  let entries: Array<MutableLedgerEntry> = []
  let faultStates: Array<MutableFaultState> = []
  let nextSeq = 1
  let nextFaultId = 1
  let closed = false

  const snapshotEntry = (entry: MutableLedgerEntry): MicrosoftLedgerEntry => ({
    ...entry,
    query: { ...entry.query }
  })

  const snapshotFault = (state: MutableFaultState): MicrosoftFaultState => ({ ...state })

  const clearLedger = () => {
    entries = []
    nextSeq = 1
  }

  const clearMonitors = () => {
    env.monitors.clear()
    env.monitorCounter.next = 1
  }

  const addFault = (input: unknown): MicrosoftFaultState | string => {
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
  const applyFault = (state: MutableFaultState, context: ErrorContext): Response => {
    const headers = new Headers(state.fault.headers ?? {})
    const body = state.fault.body ?? defaultFaultBody(context, state.fault.status)

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

  const snapshot = (): MicrosoftEmulatorState => runtime.snapshot().state

  const restore = (state: MicrosoftEmulatorState): Promise<void> => {
    const current: EmulatorSnapshot<MicrosoftEmulatorState> = runtime.snapshot()

    return runtime.restore({ ...current, state })
  }

  const reset = async () => {
    clearLedger()
    faultStates = []
    clearMonitors()
    await restore(baseline)
  }

  const reseed = async (input: unknown): Promise<MicrosoftEmulatorState | string> => {
    const next = buildSeedState(input)

    if (Predicate.isString(next)) {
      return next
    }

    await restore(next)
    clearMonitors()
    baseline = next

    return next
  }

  const coverage = (): MicrosoftCoverage => ({
    routes: microsoftEmulatorRoutes.map(route => ({
      ...route,
      requests: entries.filter(
        entry => entry.route === route.path && entry.method.toUpperCase() === route.method
      ).length
    })),
    unknownRouteRequests: entries.filter(entry => entry.evidence === 'unknown-route').length
  })

  const contextOf = (request: Request, seq: number): ErrorContext =>
    errorContext(now(), seq, request.headers.get('client-request-id'))

  /**
   * The clock for error recovery: read once, and a clock that throws (or answers a value that is
   * not a finite date) falls back to a fixed synthetic date, so recovery never fails on it.
   */
  const recoveryNow = (): number => {
    try {
      const value = now()

      return Number.isFinite(value) && Math.abs(value) <= maxDateMs ? value : recoveryDateMs
    } catch {
      return recoveryDateMs
    }
  }

  /**
   * The evidence-tagged fallback when a matched route cannot build or produce its response.
   * Clock-independent: see `recoveryNow`.
   */
  const responseFailed = (request: Request, seq: number): Response =>
    graphError(
      errorContext(recoveryNow(), seq, request.headers.get('client-request-id')),
      500,
      codes.upstreamError,
      'Synthetic: the emulator could not build the response.'
    )

  /** Authorization, body parsing, faults, then the core route (without the credential). */
  const routed = async (
    request: Request,
    url: URL,
    entry: MutableLedgerEntry,
    auth: boolean
  ): Promise<Response> => {
    // Built on demand, so the clock is read only when the wrapper answers an error itself.
    const context = () => contextOf(request, entry.seq)

    if (auth && !bearerPattern.test(request.headers.get('authorization') ?? '')) {
      return graphError(context(), 401, codes.unauthenticated, 'Access token is empty.')
    }

    const text = await readText(request)

    if (text === undefined) {
      return graphError(
        context(),
        400,
        codes.invalidBody,
        'Synthetic: the request body is unreadable.'
      )
    }

    if (text !== '') {
      const json = parseJsonText(text)

      if (json === undefined) {
        return graphError(
          context(),
          400,
          codes.invalidBody,
          'Synthetic: the request body is not valid JSON.'
        )
      }

      // Redacted before it is stored: a rejected request's body stays in the ledger too.
      entry.body = redactCredentialFields(json)
    }

    const method = request.method.toUpperCase()
    const fault = takeFault(method, url.pathname)

    if (fault !== undefined) {
      const response = applyFault(fault, context())

      entry.fault = 'status'

      return response
    }

    const hasBody = text !== '' && method !== 'GET' && method !== 'HEAD'

    const headers = new Headers({
      accept: 'application/json',
      [requestSeqHeader]: String(entry.seq)
    })

    // Only non-credential headers the routes read are forwarded.
    for (const name of ['prefer', 'if-match', 'client-request-id']) {
      const value = request.headers.get(name)

      if (value !== null) headers.set(name, value)
    }

    if (hasBody) headers.set('content-type', 'application/json')

    const init: RequestInit = { method, headers }

    if (hasBody) {
      init.body = text
    }

    const response = await runtime.fetch(
      new Request(new URL(`${url.pathname}${url.search}`, runtime.baseUrl), init)
    )

    if (response.headers.has(handlerFailedHeader)) {
      entry.responseError = 'the route handler failed'

      return responseFailed(request, entry.seq)
    }

    return response
  }

  const emulatedApi = async (request: Request, url: URL): Promise<Response> => {
    const matched = matchMicrosoftRoute(request.method, url.pathname)
    const prefer = request.headers.get('prefer')

    const entry: MutableLedgerEntry = {
      seq: nextSeq++,
      method: request.method,
      path: url.pathname,
      query: redactCredentialQuery(url.searchParams),
      status: 0,
      evidence: matched?.route.evidence ?? 'unknown-route'
    }

    if (prefer !== null) entry.prefer = prefer

    entries.push(entry)

    if (matched === undefined) {
      entry.status = 404

      return graphError(
        contextOf(request, entry.seq),
        404,
        codes.unknownRoute,
        'Synthetic: no emulated Microsoft Graph route.'
      )
    }

    entry.route = matched.route.path

    // Error recovery still answers through the route: the fallback 500 is evidence-tagged and
    // the ledger records the status actually sent.
    const response = await routed(request, url, entry, matched.route.auth).catch(() => {
      entry.responseError = 'the emulator could not build or produce the response'

      return responseFailed(request, entry.seq)
    })

    const tagged = withEvidence(response, matched.route.evidence)

    entry.status = tagged.status

    return tagged
  }

  const controlPlane = async (request: Request, path: string): Promise<Response> => {
    const method = request.method
    const allow = (methods: string) => controlError(405, 'method not allowed', { allow: methods })

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
          return controlError(400, `invalid fault: ${issueMessage(decoded.failure.issue)}`)
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
          state: snapshot(),
          monitors: [...env.monitors.values()].map(monitorState),
          faults: faultStates.map(snapshotFault),
          ledgerEntries: entries.length
        })

      case '/_emulate/seed': {
        if (method !== 'POST') {
          return allow('POST')
        }

        const next = await reseed((await jsonBody()) ?? null)

        if (Predicate.isString(next)) {
          return controlError(400, `invalid seed: ${next}`)
        }

        return jsonResponse(200, {
          seeded: true,
          messages: next.messages.length,
          events: next.events.length,
          driveItems: next.driveItems.length
        })
      }

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
   * Last resort when handling itself fails (for example an unparseable request URL): API
   * requests answer a Graph error 500, tagged with the matched route's evidence; control-plane
   * requests answer an emulator error.
   */
  const lastResort = (request: Request): Response => {
    const path = URL.canParse(request.url) ? new URL(request.url).pathname : undefined

    if (path !== undefined && isControlPath(path)) {
      return controlError(500, 'emulator failed to handle the request')
    }

    const matched = path === undefined ? undefined : matchMicrosoftRoute(request.method, path)
    const failed = responseFailed(request, 0)

    return matched === undefined ? failed : withEvidence(failed, matched.route.evidence)
  }

  const handle = async (request: Request): Promise<Response> => {
    if (closed) {
      return graphError(
        contextOf(request, 0),
        503,
        codes.upstreamError,
        'Synthetic: the emulator is closed.'
      )
    }

    const url = new URL(request.url)

    return isControlPath(url.pathname)
      ? controlPlane(request, url.pathname)
      : emulatedApi(request, url)
  }

  return {
    fetch: request => handle(request).catch(() => lastResort(request)),
    baseUrl: graphOrigin,
    sharePointOrigin,
    ledger: {
      entries: () => entries.map(snapshotEntry),
      clear: clearLedger
    },
    faults: {
      add: fault => {
        const added = addFault(fault)

        if (Predicate.isString(added)) {
          throw new MicrosoftEmulatorInputInvalid({ input: 'fault', reason: added })
        }

        return added
      },
      list: () => faultStates.map(snapshotFault),
      clear: () => {
        faultStates = []
      }
    },
    monitors: () => [...env.monitors.values()].map(monitorState),
    reset,
    seed: async input => {
      const next = await reseed(input)

      if (Predicate.isString(next)) {
        throw new MicrosoftEmulatorInputInvalid({ input: 'seed', reason: next })
      }
    },
    snapshot,
    coverage,
    close: () => {
      closed = true

      return runtime.close()
    }
  }
}
