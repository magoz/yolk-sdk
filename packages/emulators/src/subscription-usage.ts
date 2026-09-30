/**
 * Subscription-usage emulator core (internal; not a package export).
 *
 * One `GET` route answering a JSON subscription-allowance snapshot, as the SDK's best-effort usage
 * fetchers read it (Claude, Codex, Grok, OpenCode Go). Each subpath supplies the path and
 * manifest, the default payload (synthetic, shaped exactly as its parser accepts), the error
 * envelope, the 401 error for a missing bearer credential, extra header rules (required headers
 * with their status and error, and which non-credential header values the ledger records), and
 * required query parameters. Faults, scripted turns, the request ledger, the `/_emulate/*` control
 * plane, evidence tagging, and route binding come from the shared kernel (`emulator-kernel.ts`).
 *
 * Usage routes live next to a wire core on the same origin (`/anthropic`, `/codex`, `/xai`,
 * `/opencode`), but keep their own manifest, ledger, faults, and turns, so the wire core's
 * manifest and coverage are unchanged; `emulator-compose.ts` dispatches to them.
 *
 * Runtime-portable Web APIs only (`Request`, `Response`, `ReadableStream`, `TextEncoder`, `URL`);
 * no Node builtins and no SDK imports.
 */
import * as Schema from 'effect/Schema'
import {
  EmulatorErrorAfterChunksFault,
  EmulatorScriptedError,
  EmulatorStatusFault,
  EmulatorTruncateAfterChunksFault,
  jsonResponse,
  makeEmulatorKernel,
  type EmulatorApi,
  type KernelLedgerEntry
} from './emulator-kernel.ts'
import {
  emulatorRouteKey,
  type EmulatorEvidence,
  type EmulatorRouteEvidence
} from './route-evidence.ts'

/**
 * Wire faults: `status` (for example 429 with `retry-after`; the body defaults to the subpath's
 * error envelope), `error-after-chunks` (0: a dropped connection before the body), and
 * `truncate-after-chunks` (0: an empty body). The JSON body is one chunk.
 */
export const SubscriptionUsageFault = Schema.Union([
  EmulatorStatusFault,
  EmulatorErrorAfterChunksFault,
  EmulatorTruncateAfterChunksFault
])

export type SubscriptionUsageFault = typeof SubscriptionUsageFault.Type

export type SubscriptionUsageFaultKind = SubscriptionUsageFault['kind']

/** A scripted usage snapshot: the exact JSON body of the next usage response. */
export const SubscriptionUsageScriptedSnapshot = Schema.Struct({ usage: Schema.Json })

export type SubscriptionUsageScriptedSnapshot = typeof SubscriptionUsageScriptedSnapshot.Type

/** A turn queued for the next usage request: a snapshot body or an error response. */
export const SubscriptionUsageScriptedTurn = Schema.Union([
  EmulatorScriptedError,
  SubscriptionUsageScriptedSnapshot
])

export type SubscriptionUsageScriptedTurn = typeof SubscriptionUsageScriptedTurn.Type

export type SubscriptionUsageLedgerEntry = {
  /** 1-based arrival order since the last ledger clear or reset. */
  readonly seq: number
  readonly method: string
  readonly path: string
  /** The request's query string (with `?`), when it has one. */
  readonly query?: string
  /** Set when a non-empty bearer credential was sent (its value is never recorded). */
  readonly credentialHeader?: 'authorization'
  /** Values of the non-credential headers the subpath records (lower-case names). */
  readonly headers: Readonly<Record<string, string>>
  /** Kind of the fault that shaped the response. */
  readonly fault?: SubscriptionUsageFaultKind
  /** Why a matching fault could not take effect (the response was a 500 emulator error). */
  readonly faultError?: string
  /** Set when the emulator could not build the planned response (answered 500). */
  readonly responseError?: string
  /** Set when a scripted turn answered the request. */
  readonly scripted?: 'usage' | 'error'
  /** Evidence of the matched route; `unknown-route` for requests that failed closed. */
  readonly evidence: EmulatorEvidence | 'unknown-route'
  readonly status: number
  /** Body chunks handed to the transport so far (each produced when pulled). */
  readonly bodyChunks: number
}

export type SubscriptionUsageEmulator = EmulatorApi<
  SubscriptionUsageScriptedTurn,
  SubscriptionUsageFault,
  SubscriptionUsageLedgerEntry
>

/** A usage wire error, rendered by the subpath's `errorEnvelope`. */
export type SubscriptionUsageWireError = {
  readonly message: string
  readonly type: string
  readonly code: string
}

/**
 * One request header rule. `record` keeps the header value in the ledger `headers` (never set it
 * for credential or account headers); `required` answers a request whose value is missing, empty,
 * or not accepted with that status and error.
 */
export type SubscriptionUsageHeaderRule = {
  /** Lower-case header name. */
  readonly name: string
  readonly record: boolean
  readonly required?: {
    readonly status: number
    readonly error: SubscriptionUsageWireError
    /** Extra value check on a non-empty value (default: any non-empty value). */
    readonly accepts?: (value: string) => boolean
  }
}

/** A required query parameter with its exact value. */
export type SubscriptionUsageQueryRule = {
  readonly name: string
  readonly value: string
  readonly error: SubscriptionUsageWireError
}

/** What differs between usage routes. The core owns everything else. */
export type SubscriptionUsageEmulatorConfig = {
  /** The usage path, for example `/api/oauth/usage`. */
  readonly path: string
  /** Route evidence manifest; must list exactly the `GET` usage route. */
  readonly routes: ReadonlyArray<EmulatorRouteEvidence>
  /** The default JSON body (synthetic values, shaped exactly as the SDK parser accepts). */
  readonly usage: Schema.Json
  /** Renders a wire error as the service's JSON error envelope. */
  readonly errorEnvelope: (error: SubscriptionUsageWireError) => Schema.Json
  /**
   * Requests authenticate with a non-empty `Authorization: Bearer` credential, never checked or
   * stored; anything else answers 401 with `unauthorized`.
   */
  readonly unauthorized: SubscriptionUsageWireError
  /** Extra header rules, checked in order after the bearer credential. */
  readonly headers: ReadonlyArray<SubscriptionUsageHeaderRule>
  /** Required query parameters, checked after the headers (400 otherwise). */
  readonly query: ReadonlyArray<SubscriptionUsageQueryRule>
  /** Builds the error thrown by the JS API (`faults.add`, `script.enqueue`) for invalid input. */
  readonly inputInvalid: (input: 'fault' | 'turn', reason: string) => Error
}

// A non-empty bearer credential. The value is never checked or stored.
const bearerPattern = /^bearer\s+\S+/i

type MutableLedgerEntry = KernelLedgerEntry<SubscriptionUsageFaultKind> & {
  query?: string
  credentialHeader?: 'authorization'
  headers: Record<string, string>
  scripted?: 'usage' | 'error'
}

/**
 * Create a usage emulator from its config. Each call has independent ledger, fault, and script
 * state.
 *
 * Precedence per request: the bearer credential, the header rules in order, the query rules,
 * then the first matching fault if it is a `status` fault, then the next scripted turn, then the
 * default payload; a first matching body fault then shapes the body. Credential values are never
 * checked or stored.
 */
export const makeSubscriptionUsageEmulator = (
  config: SubscriptionUsageEmulatorConfig
): SubscriptionUsageEmulator => {
  const errorResponse = (status: number, error: SubscriptionUsageWireError): Response =>
    jsonResponse(status, config.errorEnvelope(error))

  const defaultFaultBody = (status: number): Schema.Json =>
    status === 429
      ? config.errorEnvelope({
          message: 'Synthetic rate limit: too many requests.',
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded'
        })
      : config.errorEnvelope({
          message: `Synthetic upstream error (${status}).`,
          type: status >= 500 ? 'server_error' : 'api_error',
          code: status >= 500 ? 'server_error' : 'upstream_error'
        })

  const kernel = makeEmulatorKernel({
    routes: config.routes,
    faultSchema: SubscriptionUsageFault,
    turnSchema: SubscriptionUsageScriptedTurn,
    newEntry: (base): MutableLedgerEntry => ({ ...base, headers: {} }),
    snapshotEntry: (entry): SubscriptionUsageLedgerEntry => ({
      ...entry,
      headers: { ...entry.headers }
    }),
    unknownRoute: () =>
      errorResponse(404, {
        message: 'Synthetic: no emulated route.',
        type: 'not_found_error',
        code: 'not_found'
      }),
    stateFields: () => ({ knownModels: [] }),
    inputInvalid: config.inputInvalid
  })

  const usage = async (
    request: Request,
    entry: MutableLedgerEntry,
    path: string
  ): Promise<Response> => {
    const url = new URL(request.url)

    if (url.search.length > 0) entry.query = url.search

    for (const rule of config.headers) {
      const value = request.headers.get(rule.name)

      if (rule.record && value !== null) entry.headers[rule.name] = value
    }

    if (!bearerPattern.test(request.headers.get('authorization') ?? '')) {
      entry.status = 401

      return errorResponse(401, config.unauthorized)
    }

    entry.credentialHeader = 'authorization'

    for (const rule of config.headers) {
      const required = rule.required

      if (required === undefined) continue

      const value = (request.headers.get(rule.name) ?? '').trim()

      if (value.length === 0 || (required.accepts !== undefined && !required.accepts(value))) {
        entry.status = required.status

        return errorResponse(required.status, required.error)
      }
    }

    for (const rule of config.query) {
      if (url.searchParams.get(rule.name) !== rule.value) {
        entry.status = 400

        return errorResponse(400, rule.error)
      }
    }

    const fault = kernel.takeFault(path, undefined)

    if (fault !== undefined && fault.fault.kind === 'status') {
      return kernel.respondWithStatusFault(entry, fault, fault.fault, defaultFaultBody)
    }

    // A scripted turn is used up when its request arrives.
    const turn = kernel.nextTurn()

    if (turn !== undefined && 'error' in turn) {
      entry.scripted = 'error'

      return kernel.respondWithScriptedError(entry, turn.error, fault)
    }

    if (turn !== undefined) entry.scripted = 'usage'

    return kernel.respondWithBody(
      entry,
      200,
      { 'content-type': 'application/json' },
      [JSON.stringify(turn === undefined ? config.usage : turn.usage)],
      fault
    )
  }

  // Every manifest route maps to its own handler; construction throws `EmulatorRouteUnmapped`
  // when a manifest route has no handler (or a handler has no manifest route).
  return kernel.serve(new Map([[emulatorRouteKey('GET', config.path), usage]]))
}
