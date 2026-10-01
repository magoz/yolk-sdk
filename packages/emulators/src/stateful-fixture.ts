/**
 * Shared wrapper of the fixture-only stateful connector emulators (internal; used by
 * `src/todoist.ts` and `src/telegram.ts`): the request ledger, status faults, the ledgered 400
 * not-emulated answer, clock-free error recovery, coverage, and the `/_emulate/*` control plane
 * around a stateful `@emulators/core` runtime.
 *
 * It never imports the core itself (the subpaths load it lazily and hand over the runtime), so it
 * needs no Node builtins. Fixture-only rule: a route answers only what its conformance fixtures
 * record; everything else (unknown routes and methods, missing or malformed credentials, query
 * parameters, body keys, and values no fixture records) answers one ledgered 400
 * `{ error: { type: 'not_emulated', message } }`, never a guessed provider status or envelope.
 *
 * Credentials are required by each subpath's `resolve` but never forwarded to the core, stored, or
 * ledgered. Resolution fails closed: a request that matches no emulated route shape exactly is
 * `unrecognised` and is ledgered and answered with constant text only (`unrecognisedLedgerPath`, a
 * standard method or `<other>`, no query or body, a constant reason). For a recognised request,
 * `secrets` (the credential values the subpath took from the recognised shape: a Telegram bot token
 * from its exact path segment and its secret part, or the Todoist bearer value) are scrubbed
 * (`scrubSecrets`) from the ledgered method, path, query keys and values, and every not-emulated
 * reason before anything is ledgered or answered; a query, remaining path, or body that repeats one
 * (raw, percent-decoded, in any parsed JSON key, string value, or number, or in the parsed body as
 * it would be recorded) is refused with constant text, so no response, state, or ledger entry can
 * carry them. Credential-named query and body keys are redacted too.
 *
 * Eligibility before faults: route handlers return a `CoreOutcome` (a refusal, or a commit whose
 * `run` performs every write). The wrapper first asks the core for a dry-run verdict (the
 * handler's checks against the request and the state, writing nothing), then picks a fault, then
 * commits. So a refused request never uses a fault, and a fault never writes.
 *
 * Recovery never reads the injectable clock: not-emulated (400), handler failures (500), and a
 * closed emulator (503) answer emulator-owned bodies without dates, so a clock that throws can
 * fail only the route handlers that read it (answered 500 with `responseError`).
 *
 * @experimental
 */
import { Data, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  EmulatorHeaderRecord,
  handlerFailedHeader,
  redactCredentialFields,
  redactCredentialQuery
} from './emulator-http.ts'
import {
  emulatorEvidenceHeader,
  type EmulatorEvidence,
  type EmulatorRouteEvidence
} from './route-evidence.ts'

/** Statuses a fault may answer on a fixture-only route: 400-599 (never a success). */
export const StatefulFixtureFaultStatus = Schema.Int.check(
  Schema.isBetween({ minimum: 400, maximum: 599 })
)

const FaultCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/**
 * Optional fault filter; an omitted field matches every request. `path` is the ledgered path
 * (ending in `*` for a prefix); `route` is a manifest path template.
 */
export const StatefulFixtureFaultMatch = Schema.Struct({
  method: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  route: Schema.optionalKey(Schema.String)
})

export type StatefulFixtureFaultMatch = typeof StatefulFixtureFaultMatch.Type

/**
 * A status fault answered before the route runs (nothing is written). The body defaults to
 * `{ error: { type: 'emulator_fault', message } }`. Statuses are 400-599; headers follow the shared
 * rules (valid names and values, no `location`, no framing headers).
 */
export const StatefulFixtureFault = Schema.Struct({
  kind: Schema.Literal('status'),
  status: StatefulFixtureFaultStatus,
  headers: Schema.optionalKey(EmulatorHeaderRecord),
  body: Schema.optionalKey(Schema.Json),
  match: Schema.optionalKey(StatefulFixtureFaultMatch),
  count: Schema.optionalKey(FaultCount)
})

export type StatefulFixtureFault = typeof StatefulFixtureFault.Type

export type StatefulFixtureLedgerEntry = {
  /** 1-based arrival order since the last ledger clear or reset. */
  readonly seq: number
  readonly method: string
  /** The request path, with credentials the path carries replaced by `<redacted>`. */
  readonly path: string
  /** Path template of the matched route. */
  readonly route?: string
  /** Query parameters; credential-named keys are `<redacted>`. */
  readonly query: Readonly<Record<string, string>>
  /** Parsed JSON request body, when there was one (credential-named keys redacted). */
  readonly body?: Schema.Json
  readonly status: number
  /** Evidence of the matched route; `unknown-route` for requests on no route. */
  readonly evidence: EmulatorEvidence | 'unknown-route'
  /** Why the request was answered 400 not-emulated (never carries a credential). */
  readonly notEmulated?: string
  /** Set when a fault answered the request. */
  readonly fault?: 'status'
  /** Set when the response could not be built or a route handler threw (answered 500). */
  readonly responseError?: string
}

export type StatefulFixtureFaultState = {
  readonly id: number
  readonly fault: StatefulFixtureFault
  /** Remaining matching requests; `undefined` for an unlimited fault. */
  readonly remaining: number | undefined
  readonly applied: number
}

export type StatefulFixtureRouteCoverage = EmulatorRouteEvidence & {
  /** Ledger requests on this route since the last ledger clear or reset. */
  readonly requests: number
}

export type StatefulFixtureCoverage = {
  readonly routes: ReadonlyArray<StatefulFixtureRouteCoverage>
  /** Ledger requests on no route. */
  readonly unknownRouteRequests: number
  /** Ledger requests answered 400 not-emulated (on a route or on none). */
  readonly notEmulatedRequests: number
}

/**
 * How a subpath resolves one API request (fail closed):
 *
 * - `unrecognised`: the raw request matches no emulated route shape exactly. It is ledgered and
 *   answered with constant text only (`unrecognisedLedgerPath`, a method from a fixed list or
 *   `<other>`, no query, no body, a constant reason), so nothing the request carries can reach
 *   the ledger, a response, or `/_emulate/*`, and no credential extraction is needed for it.
 * - `not-emulated`: a recognised route refuses the request before it runs (for example a query
 *   key it does not take). `ledgerPath` is the route's safe path; `secrets` (the credential
 *   values extracted from the recognised shape) are scrubbed from everything ledgered.
 * - `route`: a recognised, eligible request; `secrets` are guarded as above, and a query,
 *   remaining path, or body that repeats one is refused.
 */
export type StatefulFixtureResolution =
  | { readonly kind: 'unrecognised'; readonly reason: string }
  | {
      readonly kind: 'not-emulated'
      readonly ledgerPath: string
      readonly reason: string
      readonly route: EmulatorRouteEvidence
      readonly secrets: ReadonlyArray<string>
    }
  | {
      readonly kind: 'route'
      readonly ledgerPath: string
      readonly route: EmulatorRouteEvidence
      /** Path and query of the core request (never a credential). */
      readonly corePath: string
      /** Internal, credential-free headers for the core handler. */
      readonly coreHeaders: Readonly<Record<string, string>>
      readonly secrets: ReadonlyArray<string>
    }

/** The ledgered path of every unrecognised request (constant: nothing from the request). */
export const unrecognisedLedgerPath = '/<unrecognised>'

const ledgerableMethods: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS'
])

/** The ledgered method of an unrecognised request: a standard method, or `<other>`. */
const unrecognisedMethod = (method: string): string =>
  ledgerableMethods.has(method) ? method : '<other>'

/** The parts of an `@emulators/core` custom runtime the wrapper uses. */
export type StatefulFixtureRuntime<S> = {
  readonly baseUrl: string
  readonly fetch: (request: Request) => Promise<Response>
  readonly snapshot: () => S
  readonly restore: (state: S) => Promise<void>
  readonly close: () => Promise<void>
}

export type StatefulFixtureConfig<S> = {
  readonly routes: ReadonlyArray<EmulatorRouteEvidence>
  readonly runtime: StatefulFixtureRuntime<S>
  readonly initial: S
  readonly resolve: (request: Request, url: URL) => StatefulFixtureResolution
  /** Decode and build a seed (a string is why it is invalid). */
  readonly buildSeed: (input: unknown) => S | string
  /** Clear runtime data that is not state (cursors), on reset and seed. */
  readonly clearRuntime: () => void
  /** Runtime data `/_emulate/state` reports next to the state. */
  readonly runtimeState: () => Schema.Json
  /** Counts `/_emulate/seed` reports for a new state. */
  readonly seedSummary: (state: S) => Readonly<Record<string, number>>
}

export type StatefulFixtureEmulatorCore<S, Seed> = {
  readonly fetch: (request: Request) => Promise<Response>
  readonly ledger: {
    readonly entries: () => ReadonlyArray<StatefulFixtureLedgerEntry>
    readonly clear: () => void
  }
  readonly faults: {
    /** Add a fault; a string is why it is invalid. */
    readonly add: (fault: unknown) => StatefulFixtureFaultState | string
    readonly list: () => ReadonlyArray<StatefulFixtureFaultState>
    readonly clear: () => void
  }
  readonly reset: () => Promise<void>
  /** Replace the state; a string is why the seed is invalid. */
  readonly seed: (seed: Seed) => Promise<string | undefined>
  readonly snapshot: () => S
  readonly coverage: () => StatefulFixtureCoverage
  readonly close: () => Promise<void>
}

/** Internal response header a core handler sets to have the wrapper answer 400 not-emulated. */
export const notEmulatedHeader = 'x-emulator-not-emulated'

/** A core handler's not-emulated answer: the wrapper turns it into the ledgered 400. */
export const notEmulatedCoreResponse = (reason: string): Response =>
  new Response(null, { status: 400, headers: { [notEmulatedHeader]: encodeURIComponent(reason) } })

/**
 * Internal request header of the wrapper's eligibility check: the core handler validates the
 * request against the state (refusing what no fixture records) and answers `eligibleHeader`
 * without writing. Faults are chosen only after it, so a refused request never uses one.
 */
export const dryRunHeader = 'x-emulator-dry-run'

/** Internal response header of an eligible dry run. */
export const eligibleHeader = 'x-emulator-eligible'

/**
 * What a route handler decides without writing: `Refuse` (a not-emulated reason), or `Commit`
 * (`run` performs every write and builds the answer). Handlers validate first (request and state)
 * and write only inside `run`, so the wrapper can check eligibility before it picks a fault.
 */
export type CoreOutcome = Data.TaggedEnum<{
  Refuse: { readonly reason: string }
  Commit: { readonly run: () => Response }
}>

/** A route handler's refusal (nothing was written). */
export type CoreRefusal = Extract<CoreOutcome, { readonly _tag: 'Refuse' }>

const CoreOutcome = Data.taggedEnum<CoreOutcome>()

export const refuse = (reason: string): CoreRefusal => CoreOutcome.Refuse({ reason })

export const commit = (run: () => Response): CoreOutcome => CoreOutcome.Commit({ run })

export const isRefusal = (value: unknown): value is CoreRefusal =>
  Predicate.isTagged(value, 'Refuse')

/** The core answer for an outcome: the refusal, the dry-run verdict, or the committed answer. */
export const coreResponse = (outcome: CoreOutcome, raw: Request): Response =>
  CoreOutcome.$match(outcome, {
    Refuse: ({ reason }) => notEmulatedCoreResponse(reason),
    Commit: ({ run }) =>
      raw.headers.get(dryRunHeader) === '1'
        ? new Response(null, { status: 204, headers: { [eligibleHeader]: '1' } })
        : run()
  })

const jsonResponse = (status: number, body: unknown, headers: HeadersInit = {}): Response => {
  const responseHeaders = new Headers(headers)

  responseHeaders.set('content-type', 'application/json')

  return new Response(JSON.stringify(body), { status, headers: responseHeaders })
}

/** The fixture-only not-emulated answer (the same body as the other fixture-only routes). */
export const notEmulatedResponse = (reason: string): Response =>
  jsonResponse(400, { error: { type: 'not_emulated', message: `Not emulated: ${reason}` } })

const emulatorError = (status: number, message: string, headers: HeadersInit = {}): Response =>
  jsonResponse(status, { error: { message, type: 'emulator_error' } }, headers)

const defaultFaultBody = (status: number): Schema.Json => ({
  error: { type: 'emulator_fault', message: `Emulator fault: status ${status}.` }
})

const strict = { onExcessProperty: 'error' } as const

const decodeFault = Schema.decodeUnknownResult(StatefulFixtureFault, strict)

const decodeFaultList = Schema.decodeUnknownResult(
  Schema.Union([
    StatefulFixtureFault,
    Schema.Struct({ faults: Schema.Array(StatefulFixtureFault) })
  ]),
  strict
)

const decodeJsonText = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))

/** Parsed JSON, or `undefined` for invalid JSON. */
export const parseJsonText = (text: string): Schema.Json | undefined => {
  const result = decodeJsonText(text)

  return Result.isSuccess(result) ? result.success : undefined
}

const issueMessage = (issue: Schema.SchemaError['issue']): string =>
  new Schema.SchemaError(issue).message

const readText = (request: Request): Promise<string | undefined> =>
  request.text().then(
    text => text,
    () => undefined
  )

const pathMatches = (pattern: string, path: string): boolean =>
  pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : pattern === path

const isControlPath = (path: string): boolean =>
  path === '/_emulate' || path.startsWith('/_emulate/')

const decodedOrRaw = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Secrets shorter than this are not scrubbed (they would redact ordinary text). */
const minimumSecretLength = 4

const meaningful = (secrets: ReadonlyArray<string>): ReadonlyArray<string> =>
  secrets.filter(secret => secret.length >= minimumSecretLength)

/** True when `text`, raw or percent-decoded, contains a secret. */
const repeatsSecret = (text: string, secrets: ReadonlyArray<string>): boolean => {
  const decoded = decodedOrRaw(text.replaceAll('+', ' '))

  return meaningful(secrets).some(secret => text.includes(secret) || decoded.includes(secret))
}

const isJsonRecord = (value: Schema.Json): value is Schema.JsonObject =>
  value !== null && Predicate.isObject(value) && !Array.isArray(value)

/**
 * True when any object key, string value, or number of `value` (raw or percent-decoded) holds a
 * secret. Numbers are checked as JavaScript prints them (`1.2345678e7` parses to `12345678`).
 */
const jsonRepeatsSecret = (value: Schema.Json, secrets: ReadonlyArray<string>): boolean => {
  if (Predicate.isString(value)) return repeatsSecret(value, secrets)

  if (Predicate.isNumber(value)) return repeatsSecret(String(value), secrets)

  if (Array.isArray(value)) return value.some(item => jsonRepeatsSecret(item, secrets))

  if (isJsonRecord(value)) {
    return Object.entries(value).some(
      ([key, item]) => repeatsSecret(key, secrets) || jsonRepeatsSecret(item, secrets)
    )
  }

  return false
}

/**
 * `text` with every secret (raw and percent-encoded) replaced by `<redacted>`; when a secret still
 * shows after that (for example in another percent-encoding), the whole text is `<redacted>`.
 * Applied to everything the ledger keeps or a refusal answers.
 */
export const scrubSecrets = (text: string, secrets: ReadonlyArray<string>): string => {
  const variants = meaningful(secrets)
    .flatMap(secret => [secret, encodeURIComponent(secret)])
    .sort((left, right) => right.length - left.length)

  let result = text

  for (const variant of variants) result = result.replaceAll(variant, '<redacted>')

  return repeatsSecret(result, secrets) ? '<redacted>' : result
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
  notEmulated?: string
  fault?: 'status'
  responseError?: string
}

type MutableFaultState = {
  readonly id: number
  readonly fault: StatefulFixtureFault
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

/**
 * Wrap a stateful core runtime. Precedence per API request: `resolve` (unknown routes, missing
 * or malformed credentials, and the subpath's own refusals answer 400 not-emulated), then the
 * query, path, and body checks (unreadable, not JSON, or repeating a secret: 400 not-emulated),
 * then the route handler's dry-run eligibility check against the state (its refusals: 400
 * not-emulated), then the first matching fault (answered before anything is written), then the
 * commit, which validates again. A handler that throws answers a 500 emulator error with
 * `responseError` in the ledger.
 */
export const makeStatefulFixtureEmulator = <S, Seed>(
  config: StatefulFixtureConfig<S>
): StatefulFixtureEmulatorCore<S, Seed> => {
  const { runtime } = config

  let baseline: S = config.initial
  let entries: Array<MutableLedgerEntry> = []
  let faultStates: Array<MutableFaultState> = []
  let nextSeq = 1
  let nextFaultId = 1
  let closed = false

  const snapshotEntry = (entry: MutableLedgerEntry): StatefulFixtureLedgerEntry => ({
    ...entry,
    query: { ...entry.query }
  })

  const snapshotFault = (state: MutableFaultState): StatefulFixtureFaultState => ({ ...state })

  const clearLedger = () => {
    entries = []
    nextSeq = 1
  }

  const addFault = (input: unknown): StatefulFixtureFaultState | string => {
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

  const takeFault = (method: string, path: string, route: string) =>
    faultStates.find(
      state =>
        (state.remaining === undefined || state.remaining > 0) &&
        (state.fault.match?.method === undefined ||
          state.fault.match.method.toUpperCase() === method) &&
        (state.fault.match?.path === undefined || pathMatches(state.fault.match.path, path)) &&
        (state.fault.match?.route === undefined || state.fault.match.route === route)
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

  const reset = async () => {
    clearLedger()
    faultStates = []
    config.clearRuntime()
    await runtime.restore(baseline)
  }

  const reseed = async (input: unknown): Promise<S | string> => {
    const next = config.buildSeed(input)

    if (Predicate.isString(next)) {
      return next
    }

    await runtime.restore(next)
    config.clearRuntime()
    baseline = next

    return next
  }

  const coverage = (): StatefulFixtureCoverage => ({
    routes: config.routes.map(route => ({
      ...route,
      requests: entries.filter(
        entry => entry.route === route.path && entry.method.toUpperCase() === route.method
      ).length
    })),
    unknownRouteRequests: entries.filter(entry => entry.evidence === 'unknown-route').length,
    notEmulatedRequests: entries.filter(entry => entry.notEmulated !== undefined).length
  })

  /** The ledgered 400; the reason is scrubbed of the request's secrets first. */
  const notEmulated = (
    entry: MutableLedgerEntry,
    reason: string,
    secrets: ReadonlyArray<string>
  ): Response => {
    const safe = scrubSecrets(reason, secrets)

    entry.notEmulated = safe

    return notEmulatedResponse(safe)
  }

  const responseFailed = (): Response =>
    emulatorError(500, 'Synthetic: the emulator could not build the response.')

  const routed = async (
    request: Request,
    resolved: Extract<StatefulFixtureResolution, { readonly kind: 'route' }>,
    url: URL,
    entry: MutableLedgerEntry
  ): Promise<Response> => {
    const { secrets } = resolved
    const refused = (reason: string) => notEmulated(entry, reason, secrets)

    if (repeatsSecret(url.search, secrets)) return refused('the query repeats the credential')

    if (repeatsSecret(resolved.corePath, secrets)) {
      return refused('the request path repeats the credential')
    }

    const text = await readText(request)

    if (text === undefined) return refused('the request body is unreadable')

    if (repeatsSecret(text, secrets)) return refused('the request body repeats the credential')

    if (text !== '') {
      const json = parseJsonText(text)

      if (json === undefined) return refused('the request body is not JSON')

      // Normalised forms (`\u0051` escapes, `1.2345678e7` numbers) only show once parsed: every
      // key, string value, and number is checked, and so is the value as it would be recorded.
      if (jsonRepeatsSecret(json, secrets) || repeatsSecret(JSON.stringify(json), secrets)) {
        return refused('the request body repeats the credential')
      }

      // Redacted before it is stored: a refused request's body stays in the ledger too.
      entry.body = redactCredentialFields(json)
    }

    const method = request.method.toUpperCase()

    const coreRequest = (dryRun: boolean) => {
      const headers = new Headers(resolved.coreHeaders)
      const contentType = request.headers.get('content-type')

      // The only client header forwarded: never a credential.
      if (contentType !== null) headers.set('content-type', contentType)

      if (dryRun) headers.set(dryRunHeader, '1')

      const init: RequestInit = { method, headers }

      if (text !== '') init.body = text

      return new Request(new URL(resolved.corePath, runtime.baseUrl), init)
    }

    /** A core answer that refuses or failed, or `undefined` to carry on with it. */
    const settled = (response: Response): Response | undefined => {
      if (response.headers.has(handlerFailedHeader)) {
        entry.responseError = 'the route handler failed'

        return responseFailed()
      }

      const reason = response.headers.get(notEmulatedHeader)

      return reason === null ? undefined : refused(decodedOrRaw(reason))
    }

    // 1. Eligibility against the request and the state, writing nothing.
    const verdict = await runtime.fetch(coreRequest(true))
    const ineligible = settled(verdict)

    if (ineligible !== undefined) return ineligible

    if (!verdict.headers.has(eligibleHeader)) {
      entry.responseError = 'the route handler answered no eligibility verdict'

      return responseFailed()
    }

    // 2. A fault answers an eligible request before anything is written.
    const fault = takeFault(method, entry.path, resolved.route.path)

    if (fault !== undefined) {
      const response = applyFault(fault)

      entry.fault = 'status'

      return response
    }

    // 3. The commit (which validates again: the state may have changed since step 1).
    const response = await runtime.fetch(coreRequest(false))

    return settled(response) ?? response
  }

  const emulatedApi = async (request: Request, url: URL): Promise<Response> => {
    const resolved = config.resolve(request, url)

    // Fail closed: an unrecognised request is ledgered with constant text only.
    if (resolved.kind === 'unrecognised') {
      const entry: MutableLedgerEntry = {
        seq: nextSeq++,
        method: unrecognisedMethod(request.method),
        path: unrecognisedLedgerPath,
        query: {},
        status: 400,
        evidence: 'unknown-route',
        notEmulated: resolved.reason
      }

      entries.push(entry)

      return notEmulatedResponse(resolved.reason)
    }

    const { secrets } = resolved
    const query = redactCredentialQuery(url.searchParams)

    const entry: MutableLedgerEntry = {
      seq: nextSeq++,
      method: scrubSecrets(request.method, secrets),
      path: scrubSecrets(resolved.ledgerPath, secrets),
      route: resolved.route.path,
      // Query keys and values are scrubbed of the request's secrets before they are recorded.
      query: Object.fromEntries(
        Object.entries(query).map(([key, value]) => [
          scrubSecrets(key, secrets),
          scrubSecrets(value, secrets)
        ])
      ),
      status: 0,
      evidence: resolved.route.evidence
    }

    entries.push(entry)

    if (resolved.kind === 'not-emulated') {
      const tagged = withEvidence(
        notEmulated(entry, resolved.reason, secrets),
        resolved.route.evidence
      )

      entry.status = tagged.status

      return tagged
    }

    // Error recovery still answers through the route: the fallback 500 is evidence-tagged and
    // the ledger records the status actually sent.
    const response = await routed(request, resolved, url, entry).catch(() => {
      entry.responseError = 'the emulator could not build or produce the response'

      return responseFailed()
    })

    const tagged = withEvidence(response, resolved.route.evidence)

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
          state: runtime.snapshot(),
          runtime: config.runtimeState(),
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

  const handle = async (request: Request): Promise<Response> => {
    if (closed) {
      return emulatorError(503, 'Synthetic: the emulator is closed.')
    }

    const url = new URL(request.url)

    return isControlPath(url.pathname)
      ? controlPlane(request, url.pathname)
      : emulatedApi(request, url)
  }

  return {
    // Last resort when handling itself fails (for example an unparseable request URL).
    fetch: request =>
      handle(request).catch(() => emulatorError(500, 'emulator failed to handle the request')),
    ledger: {
      entries: () => entries.map(snapshotEntry),
      clear: clearLedger
    },
    faults: {
      add: addFault,
      list: () => faultStates.map(snapshotFault),
      clear: () => {
        faultStates = []
      }
    },
    reset,
    seed: async input => {
      const next = await reseed(input)

      return Predicate.isString(next) ? next : undefined
    },
    snapshot: runtime.snapshot,
    coverage,
    close: () => {
      if (closed) return Promise.resolve()

      closed = true

      return runtime.close()
    }
  }
}
