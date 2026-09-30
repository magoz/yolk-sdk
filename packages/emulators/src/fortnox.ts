/**
 * Stateful Fortnox API emulator (`/3`), built on the upstream `@emulators/core` custom runtime,
 * with a request ledger, wire faults, and an `/_emulate/*` control plane.
 *
 * It never imports SDK code: its wire shapes and default seed are copied as data from the
 * synthetic Fortnox conformance fixtures, and every route names the conformance cases it follows
 * in `fortnoxEmulatorRoutes`. The observed Fortnox quirks those cases claim (sticky row discounts,
 * empty strings that keep values, payment filters that skip unbooked invoices, `ErrorInformation`
 * rejections, read-only `Country`) are implemented and listed in `fortnoxEmulatorQuirks`.
 *
 * Node-only: `@emulators/core` imports Node builtins, so the core is loaded lazily by
 * `makeFortnoxEmulator` (importing this module has no side effects).
 *
 * @experimental
 */
import type { EmulatorSnapshot } from '@emulators/core'
import { Data, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  EmulatorHeaderRecord,
  EmulatorResponseStatus,
  handlerFailedHeader
} from './emulator-http.ts'
import {
  errorInformation,
  fortnoxApiRoutes,
  fortnoxEmulatorErrorCodes,
  matchFortnoxRoute,
  parseJsonText,
  registerFortnoxApi,
  type FortnoxApiEnv,
  type FortnoxEmulatorQuirks
} from './fortnox/api.ts'
import {
  buildSeedState,
  decodeState,
  type FortnoxEmulatorSeed,
  type FortnoxEmulatorState
} from './fortnox/state.ts'
import {
  emulatorEvidenceHeader,
  type EmulatorEvidence,
  type EmulatorRouteEvidence
} from './route-evidence.ts'

export type { EmulatorEvidence, EmulatorRouteEvidence } from './route-evidence.ts'

export { emulatorEvidenceHeader } from './route-evidence.ts'

export {
  fortnoxEmulatorBasePath,
  fortnoxEmulatorErrorCodes,
  fortnoxEmulatorQuirks,
  type FortnoxEmulatorQuirk,
  type FortnoxEmulatorQuirks
} from './fortnox/api.ts'

export {
  FortnoxEmulatorCompany,
  FortnoxEmulatorCustomer,
  FortnoxEmulatorCustomerSeed,
  FortnoxEmulatorInvoice,
  FortnoxEmulatorInvoiceRow,
  FortnoxEmulatorInvoiceRowSeed,
  FortnoxEmulatorInvoiceSeed,
  FortnoxEmulatorOutboxEntry,
  FortnoxEmulatorProfile,
  FortnoxEmulatorSeed,
  FortnoxEmulatorStateSchema,
  type FortnoxEmulatorState
} from './fortnox/state.ts'

/** Origin the connector calls; also the default origin of `@url` links. */
export const fortnoxEmulatorDefaultOrigin = 'https://api.fortnox.se'

/**
 * Route evidence manifest: every emulated Fortnox route, whether it writes, and the conformance
 * cases whose (currently synthetic, unverified) wire claims it follows. Kept in sync with the
 * handlers by construction (both come from one route table).
 */
export const fortnoxEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> = fortnoxApiRoutes.map(
  ({ handler: _handler, queryKeys: _queryKeys, ...route }) => route
)

const FaultCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** Optional fault filter; an omitted field matches every request. `path` ending in `*` is a prefix. */
export const FortnoxFaultMatch = Schema.Struct({
  method: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String)
})

export type FortnoxFaultMatch = typeof FortnoxFaultMatch.Type

/**
 * A wire fault: answer matching requests with this status, headers, and body (for example 429
 * with `retry-after`) before the route runs, so nothing is written. The body defaults to a
 * Fortnox `ErrorInformation`. `count` limits how many requests it answers (omitted: all).
 *
 * The Gateway emulator's rules apply: statuses that cannot carry a body (1xx, 204, 205) and
 * redirects (3xx) are rejected, as are invalid header names or values, a `location` header, and
 * framing headers (`content-length`, `transfer-encoding`, `connection`, `keep-alive`, `upgrade`).
 */
export const FortnoxFault = Schema.Struct({
  kind: Schema.Literal('status'),
  status: EmulatorResponseStatus,
  headers: Schema.optionalKey(EmulatorHeaderRecord),
  body: Schema.optionalKey(Schema.Json),
  match: Schema.optionalKey(FortnoxFaultMatch),
  count: Schema.optionalKey(FaultCount)
})

export type FortnoxFault = typeof FortnoxFault.Type

/** Invalid emulator input from the JS API: a seed, a fault, or an option. A programmer error. */
export class FortnoxEmulatorInputInvalid extends Data.TaggedError('FortnoxEmulatorInputInvalid')<{
  readonly input: 'seed' | 'fault' | 'option'
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid Fortnox emulator ${this.input}: ${this.reason}`
  }
}

export type FortnoxLedgerEntry = {
  /** 1-based arrival order since the last ledger clear or reset. */
  readonly seq: number
  readonly method: string
  /** Concrete request path, for example `/3/invoices/103`. */
  readonly path: string
  /** Path template of the matched route, for example `/3/invoices/{DocumentNumber}`. */
  readonly route?: string
  readonly query: Readonly<Record<string, string>>
  /** Parsed JSON request body, when there was one. */
  readonly body?: Schema.Json
  readonly status: number
  /** Evidence of the matched route; `unknown-route` for requests that failed closed. */
  readonly evidence: EmulatorEvidence | 'unknown-route'
  /** Set when a fault answered the request. */
  readonly fault?: 'status'
  /**
   * Set when the emulator could not build or produce the response, or a route handler threw; the
   * request was answered with a 500 `ErrorInformation` (still evidence-tagged) and no fault was
   * used up.
   */
  readonly responseError?: string
}

export type FortnoxFaultState = {
  readonly id: number
  readonly fault: FortnoxFault
  /** Remaining matching requests; `undefined` for an unlimited fault. */
  readonly remaining: number | undefined
  readonly applied: number
}

export type FortnoxRouteCoverage = EmulatorRouteEvidence & {
  /** Ledger requests answered by this route since the last ledger clear or reset. */
  readonly requests: number
}

export type FortnoxCoverage = {
  readonly routes: ReadonlyArray<FortnoxRouteCoverage>
  /** Ledger requests to unknown routes (failed closed). */
  readonly unknownRouteRequests: number
}

export type FortnoxEmulatorOptions = {
  /** Typed seed; defaults to the fixture entities (`profile: 'default'`). */
  readonly seed?: FortnoxEmulatorSeed
  /** Clock in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Drill knobs (tests only): flip one observed quirk to prove the cases catch it. */
  readonly quirks?: FortnoxEmulatorQuirks
  /** Origin of `@url` links in responses. Defaults to `https://api.fortnox.se`. */
  readonly baseUrl?: string
}

export type FortnoxEmulator = {
  /** The fetch handler (the `/3` API plus the `/_emulate/*` control plane). Never rejects. */
  readonly fetch: (request: Request) => Promise<Response>
  /** Origin of `@url` links in responses. */
  readonly baseUrl: string
  readonly ledger: {
    readonly entries: () => ReadonlyArray<FortnoxLedgerEntry>
    readonly clear: () => void
  }
  readonly faults: {
    /** Add a fault; throws `FortnoxEmulatorInputInvalid` for an invalid fault. */
    readonly add: (fault: FortnoxFault) => FortnoxFaultState
    readonly list: () => ReadonlyArray<FortnoxFaultState>
    readonly clear: () => void
  }
  /** Restore the current seed and clear the ledger and faults. */
  readonly reset: () => Promise<void>
  /**
   * Replace the state with a new seed, which becomes what `reset` restores. Rejects with
   * `FortnoxEmulatorInputInvalid` for an invalid seed.
   */
  readonly seed: (seed: FortnoxEmulatorSeed) => Promise<void>
  /** A deep copy of the current state (entities, outbox, counters). */
  readonly snapshot: () => FortnoxEmulatorState
  readonly coverage: () => FortnoxCoverage
  /** Close the core runtime. Later requests answer 503. Idempotent. */
  readonly close: () => Promise<void>
}

const strict = { onExcessProperty: 'error' } as const

const decodeFault = Schema.decodeUnknownResult(FortnoxFault, strict)

const decodeFaultList = Schema.decodeUnknownResult(
  Schema.Union([FortnoxFault, Schema.Struct({ faults: Schema.Array(FortnoxFault) })]),
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

const codes = fortnoxEmulatorErrorCodes

const defaultFaultBody = (status: number): Schema.Json => ({
  ErrorInformation:
    status === 429
      ? { error: 1, message: 'Synthetic: too many requests.', code: codes.rateLimited }
      : { error: 1, message: `Synthetic upstream error (${status}).`, code: codes.upstreamError }
})

// A non-empty bearer credential. The value is never checked, stored, forwarded, or ledgered.
const bearerPattern = /^bearer\s+\S+/i

const pathMatches = (pattern: string, path: string): boolean =>
  pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : pattern === path

const faultMatches = (fault: FortnoxFault, method: string, path: string): boolean =>
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

type MutableLedgerEntry = {
  seq: number
  method: string
  path: string
  route?: string
  query: Readonly<Record<string, string>>
  body?: Schema.Json
  status: number
  evidence: EmulatorEvidence | 'unknown-route'
  fault?: 'status'
  responseError?: string
}

type MutableFaultState = {
  readonly id: number
  readonly fault: FortnoxFault
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

const defaultQuirks: Required<FortnoxEmulatorQuirks> = {
  stickyRowDiscount: true,
  emptyStringClears: false,
  paymentFiltersIncludeUnbooked: false
}

/** The evidence-tagged fallback when a matched API route cannot build or produce its response. */
const responseFailed = (): Response =>
  errorInformation(
    500,
    codes.upstreamError,
    'Synthetic: the emulator could not build the response.'
  )

const isControlPath = (path: string): boolean =>
  path === '/_emulate' || path.startsWith('/_emulate/')

/**
 * Create a stateful Fortnox emulator on the `@emulators/core` custom runtime. Each call has its
 * own state, ledger, and faults. Rejects with `FortnoxEmulatorInputInvalid` for an invalid seed
 * or `baseUrl`.
 *
 * Requests to `/3/*` need `Authorization: Bearer <non-empty>` (missing: 401 `ErrorInformation`);
 * the token is never checked, stored, forwarded to the core, or ledgered. Precedence per request:
 * route match (unknown routes fail closed with a 404 `ErrorInformation`), authorization, JSON
 * body parsing, then the first matching fault (answered before the route runs, so nothing is
 * written), then the stateful route. Every response from an unverified route carries
 * `x-emulator-evidence: unverified`.
 */
export const makeFortnoxEmulator = async (
  options: FortnoxEmulatorOptions = {}
): Promise<FortnoxEmulator> => {
  const initial = buildSeedState(options.seed ?? {})

  if (Predicate.isString(initial)) {
    throw new FortnoxEmulatorInputInvalid({ input: 'seed', reason: initial })
  }

  const linkOrigin = validOrigin(options.baseUrl ?? fortnoxEmulatorDefaultOrigin)

  if (linkOrigin === undefined) {
    throw new FortnoxEmulatorInputInvalid({
      input: 'option',
      reason: 'baseUrl must be an http(s) origin without path, query, hash, or credentials'
    })
  }

  const env: FortnoxApiEnv = {
    now: options.now ?? (() => Date.now()),
    linkOrigin,
    quirks: { ...defaultQuirks, ...options.quirks }
  }

  // Loaded lazily: the core imports Node builtins and reads files at import time.
  const core = await import('@emulators/core')

  const definition = core.defineEmulator<FortnoxEmulatorState>({
    name: 'fortnox',
    cors: false,
    state: () => initial,
    validateSeed: value => {
      const decoded = decodeState(value)

      if (Predicate.isString(decoded)) {
        throw new FortnoxEmulatorInputInvalid({ input: 'seed', reason: decoded })
      }

      return decoded
    },
    setup: ({ app, state }) => registerFortnoxApi(app, state, env)
  })

  const runtime = await core.createCustomRuntime(definition, { seed: initial })

  let baseline: FortnoxEmulatorState = initial
  let entries: Array<MutableLedgerEntry> = []
  let faultStates: Array<MutableFaultState> = []
  let nextSeq = 1
  let nextFaultId = 1
  let closed = false

  const snapshotEntry = (entry: MutableLedgerEntry): FortnoxLedgerEntry => ({
    ...entry,
    query: { ...entry.query }
  })

  const snapshotFault = (state: MutableFaultState): FortnoxFaultState => ({ ...state })

  const clearLedger = () => {
    entries = []
    nextSeq = 1
  }

  const addFault = (input: unknown): FortnoxFaultState | string => {
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
    const body = state.fault.body ?? defaultFaultBody(state.fault.status)

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

  const snapshot = (): FortnoxEmulatorState => runtime.snapshot().state

  const restore = (state: FortnoxEmulatorState): Promise<void> => {
    const current: EmulatorSnapshot<FortnoxEmulatorState> = runtime.snapshot()

    return runtime.restore({ ...current, state })
  }

  const reset = async () => {
    clearLedger()
    faultStates = []
    await restore(baseline)
  }

  const reseed = async (input: unknown): Promise<FortnoxEmulatorState | string> => {
    const next = buildSeedState(input)

    if (Predicate.isString(next)) {
      return next
    }

    await restore(next)
    baseline = next

    return next
  }

  const coverage = (): FortnoxCoverage => ({
    routes: fortnoxEmulatorRoutes.map(route => ({
      ...route,
      requests: entries.filter(
        entry => entry.route === route.path && entry.method.toUpperCase() === route.method
      ).length
    })),
    unknownRouteRequests: entries.filter(entry => entry.evidence === 'unknown-route').length
  })

  /** Authorization, body parsing, faults, then the core route (without the credential). */
  const routed = async (
    request: Request,
    url: URL,
    entry: MutableLedgerEntry
  ): Promise<Response> => {
    if (!bearerPattern.test(request.headers.get('authorization') ?? '')) {
      return errorInformation(
        401,
        codes.unauthorized,
        'Synthetic: missing or invalid authorization.'
      )
    }

    const text = await readText(request)

    if (text === undefined) {
      return errorInformation(400, codes.invalidBody, 'Synthetic: the request body is unreadable.')
    }

    if (text !== '') {
      const json = parseJsonText(text)

      if (json === undefined) {
        return errorInformation(
          400,
          codes.invalidBody,
          'Synthetic: the request body is not valid JSON.'
        )
      }

      entry.body = json
    }

    const method = request.method.toUpperCase()
    const fault = takeFault(method, url.pathname)

    if (fault !== undefined) {
      const response = applyFault(fault)

      entry.fault = 'status'

      return response
    }

    const hasBody = text !== '' && method !== 'GET' && method !== 'HEAD'

    const init: RequestInit = {
      method,
      headers: hasBody
        ? { accept: 'application/json', 'content-type': 'application/json' }
        : { accept: 'application/json' }
    }

    if (hasBody) {
      init.body = text
    }

    const response = await runtime.fetch(
      new Request(new URL(`${url.pathname}${url.search}`, runtime.baseUrl), init)
    )

    if (response.headers.has(handlerFailedHeader)) {
      entry.responseError = 'the route handler failed'

      return responseFailed()
    }

    return response
  }

  const emulatedApi = async (request: Request, url: URL): Promise<Response> => {
    const route = matchFortnoxRoute(request.method, url.pathname)

    const entry: MutableLedgerEntry = {
      seq: nextSeq++,
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      status: 0,
      evidence: route?.evidence ?? 'unknown-route'
    }

    entries.push(entry)

    if (route === undefined) {
      entry.status = 404

      return errorInformation(404, codes.unknownRoute, 'Synthetic: no emulated Fortnox route.')
    }

    entry.route = route.path

    // Error recovery still answers through the route: the fallback 500 is evidence-tagged and
    // the ledger records the status actually sent.
    const response = await routed(request, url, entry).catch(() => {
      entry.responseError = 'the emulator could not build or produce the response'

      return responseFailed()
    })

    const tagged = withEvidence(response, route.evidence)

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
          customers: next.customers.length,
          invoices: next.invoices.length
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
   * requests answer a Fortnox `ErrorInformation` 500, tagged with the matched route's evidence;
   * control-plane requests answer an emulator error.
   */
  const lastResort = (request: Request): Response => {
    const path = URL.canParse(request.url) ? new URL(request.url).pathname : undefined

    if (path !== undefined && isControlPath(path)) {
      return controlError(500, 'emulator failed to handle the request')
    }

    const route = path === undefined ? undefined : matchFortnoxRoute(request.method, path)

    return route === undefined ? responseFailed() : withEvidence(responseFailed(), route.evidence)
  }

  const handle = async (request: Request): Promise<Response> => {
    if (closed) {
      return errorInformation(503, codes.upstreamError, 'Synthetic: the emulator is closed.')
    }

    const url = new URL(request.url)

    return isControlPath(url.pathname)
      ? controlPlane(request, url.pathname)
      : emulatedApi(request, url)
  }

  return {
    fetch: request => handle(request).catch(() => lastResort(request)),
    baseUrl: linkOrigin,
    ledger: {
      entries: () => entries.map(snapshotEntry),
      clear: clearLedger
    },
    faults: {
      add: fault => {
        const added = addFault(fault)

        if (Predicate.isString(added)) {
          throw new FortnoxEmulatorInputInvalid({ input: 'fault', reason: added })
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
        throw new FortnoxEmulatorInputInvalid({ input: 'seed', reason: next })
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
