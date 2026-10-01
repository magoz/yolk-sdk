/**
 * Stateful LinkedIn search emulator (the Exa and Enrich Layer routes of the LinkedIn search
 * conformance cases: `POST /search` on `https://api.exa.ai`, and `GET /api/v2/profile` and
 * `GET /api/v2/profile/email` on `https://enrichlayer.com`), built on the upstream
 * `@emulators/core` custom runtime, with a request ledger, status faults, and an `/_emulate/*`
 * control plane.
 *
 * It never imports SDK code: its answers, error bodies, and default seed are copied as data from
 * the synthetic LinkedIn search conformance fixtures, and every route names the conformance cases
 * it follows in `linkedInSearchEmulatorRoutes`. Only the routes those seven cases send are
 * emulated, and every one is a read (nothing is ever written). Response behaviour comes only from
 * the fixtures, byte for byte: a search answers only the results the state holds for exactly its
 * query and `numResults` (the default seed holds the three the fixtures record, for `numResults`
 * 10, 3, and 2); a profile lookup answers a held profile, or the recorded 404 for a seeded absent
 * profile; an email lookup answers a held profile's recorded email. A key a seed marks as rejected
 * on an origin answers that origin's recorded 401 (the default seed rejects the synthetic invalid
 * keys the two unauthorized cases send). Anything else answers one ledgered 400 not-emulated and
 * uses up no fault. Every route answers only on its recorded origin (`fetchOn(origin)` serves one
 * behind a loopback rewrite).
 *
 * Fail closed, on the shared wrapper's fail-closed mode exactly as `/github` and `/google` use it:
 * a request is recognised only when its raw path is exactly an emulated route path under that
 * route's method, and any `Authorization` header is exactly `Bearer <token>` with a recognisable
 * bearer (the RFC 6750 `b64token` syntax, at least 8 characters, a first character in
 * `[G-Zg-z\-._~+/]` other than `n`, `r`, `t`, `u`, and a character outside `[0-9.eE+-]`). Every
 * other request is ledgered and answered with constant text only (`/<unrecognised>`, a standard
 * method or `<other>`, an empty query, no body, a constant reason). A recognised request that
 * repeats the bearer anywhere (its raw path, the raw query or any query key or value, the recorded
 * `content-type` header, or its body, through the wrapper's fixpoint closure of tolerant
 * percent-decoding and JSON-unescaping, capped, where a cap refuses) is ledgered with constant
 * text only; any other has the bearer scrubbed from every ledgered field and reason. The bearer is
 * never stored, forwarded, or ledgered: routes see only its per-origin digest (the wrapper's
 * opt-in `bearerDigest`; SHA-256 of the origin, a space, and the key), which a plan compares with
 * the digests of the seed's rejected keys for that origin; the state holds only those digests, so
 * even a rejected key never reaches the state or `/_emulate/*`. Refusals never echo a request's
 * own query or body keys (the wrapper's constant-reason `exactQuery` and `exactBodyKeys`).
 *
 * Request-shape latitude (`/linkedin-search`, the only accepted deviations): any bearer value in
 * the RFC 6750 `b64token` syntax (`[A-Za-z0-9\-._~+/]+=*`) of at least 8 characters, starting with
 * a character in `[G-Zg-z\-._~+/]` other than `n`, `r`, `t`, `u`, with at least one outside
 * `[0-9.eE+-]`, that occurs nowhere else in the request (never stored or ledgered; only its
 * per-origin digest is compared, with the digests of the keys the seed marks as rejected on that
 * origin); extra request headers; JSON key order; `content-type` media-type parameters on the
 * search; any percent-encoding of the `linkedin_profile_url` value that decodes once to the same
 * profile URL; and, with a key the seed marks as rejected on the request's origin, any search
 * `query` (one trimmed line of at most 500 characters) with any integer `numResults` from 1 to 100,
 * and any profile URL of the form `https://<host>/in/<slug>`, each answered the origin's
 * recorded 401. `Authorization` must be exactly `Bearer <token>` (that spelling, one space).
 * Everything else (other body keys or values, a `category` other than `people`, a `type` other than
 * `auto`, `contents` other than `{ "text": true }`, a search the state holds no answer for (another
 * query, or a `numResults` no seeded search of that query records), a profile URL the state holds
 * neither as a profile nor as absent, an email lookup of an absent profile, any query parameter on
 * the search, other, missing, or repeated query parameters on a lookup, empty query components such
 * as a bare `?` or a stray `&`, a body on a lookup, another origin, and a bearer repeated anywhere
 * in the request) is not emulated.
 *
 * Node-only: `@emulators/core` imports Node builtins, so the core is loaded lazily by
 * `makeLinkedInSearchEmulator` (importing this module has no side effects).
 *
 * @experimental
 */
import type { EmulatorSnapshot } from '@emulators/core'
import { Data, Predicate } from 'effect'
import {
  linkedInSearchApiRoutes,
  linkedInSearchEmulatorDrillKnobs,
  type LinkedInSearchApiEnv,
  type LinkedInSearchEmulatorDrills
} from './linkedin-search/api.ts'
import {
  buildSeedState,
  decodeState,
  linkedInSearchKeyDigest,
  type LinkedInSearchEmulatorSeed,
  type LinkedInSearchEmulatorState
} from './linkedin-search/state.ts'
import type { EmulatorRouteEvidence } from './route-evidence.ts'
import {
  StatefulFault,
  StatefulFaultMatch,
  checkBooleanDrills,
  makeStatefulEmulator,
  routeEvidence,
  type StatefulCoverage,
  type StatefulEmulatorApi,
  type StatefulFaultState,
  type StatefulInputKind,
  type StatefulLedgerEntry
} from './stateful-emulator.ts'

export type { EmulatorEvidence, EmulatorRouteEvidence } from './route-evidence.ts'

export { emulatorEvidenceHeader } from './route-evidence.ts'

export {
  linkedInSearchEmulatorErrorBodies,
  type LinkedInSearchEmulatorDrills
} from './linkedin-search/api.ts'

export {
  LinkedInSearchEmulatorProfile,
  LinkedInSearchEmulatorResult,
  LinkedInSearchEmulatorSearch,
  LinkedInSearchEmulatorSeed,
  LinkedInSearchEmulatorStateSchema,
  linkedInSearchEmulatorEnrichLayerOrigin,
  linkedInSearchEmulatorExaOrigin,
  type LinkedInSearchEmulatorState
} from './linkedin-search/state.ts'

/**
 * Route evidence manifest: every emulated route (all reads) and the conformance cases whose
 * (currently synthetic, unverified) wire claims it follows. Kept in sync with the handlers by
 * construction (both come from one route table).
 */
export const linkedInSearchEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> =
  linkedInSearchApiRoutes.map(routeEvidence)

/**
 * Optional fault filter; an omitted field matches every request. `path` ending in `*` is a
 * prefix.
 */
export const LinkedInSearchFaultMatch = StatefulFaultMatch

export type LinkedInSearchFaultMatch = typeof StatefulFaultMatch.Type

/**
 * A status fault (400-599): answer matching requests with this status, headers, and body instead
 * of the route's answer. The body defaults to `{ error: { type: 'emulator_fault', message } }`;
 * `count` limits how many requests it answers. Only a request the emulator would answer reaches a
 * fault: a request that is not emulated, by its shape or by the state, never uses one up.
 */
export const LinkedInSearchFault = StatefulFault

export type LinkedInSearchFault = StatefulFault

export type LinkedInSearchFaultState = StatefulFaultState

export type LinkedInSearchLedgerEntry = StatefulLedgerEntry

export type LinkedInSearchCoverage = StatefulCoverage

/** Invalid emulator input from the JS API: a seed, a fault, or an option. A programmer error. */
export class LinkedInSearchEmulatorInputInvalid extends Data.TaggedError(
  'LinkedInSearchEmulatorInputInvalid'
)<{
  readonly input: StatefulInputKind
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid LinkedIn search emulator ${this.input}: ${this.reason}`
  }
}

export type LinkedInSearchEmulatorOptions = {
  /** Typed seed; defaults to the fixture entities. */
  readonly seed?: LinkedInSearchEmulatorSeed
  /** Drill knobs (tests only): make the emulator disagree with one conformance claim. */
  readonly drills?: LinkedInSearchEmulatorDrills
}

export type LinkedInSearchEmulator = StatefulEmulatorApi<
  LinkedInSearchEmulatorState,
  LinkedInSearchEmulatorSeed
>

const inputInvalid = (input: StatefulInputKind, reason: string) =>
  new LinkedInSearchEmulatorInputInvalid({ input, reason })

/** The constant reason of a request on no emulated route shape. */
const unrecognisedReason = 'no emulated Exa or Enrich Layer route for this method and path'

/** The constant reason of a request whose `Authorization` header is not one recognisable bearer. */
const unrecognisedAuthorizationReason = 'an unrecognisable Authorization header is not emulated'

/**
 * Create a stateful LinkedIn search emulator on the `@emulators/core` custom runtime. Each call
 * has its own state, ledger, and faults. Rejects with `LinkedInSearchEmulatorInputInvalid` for an
 * invalid seed or option. See `src/stateful-emulator.ts` for the request precedence.
 */
export const makeLinkedInSearchEmulator = async (
  options: LinkedInSearchEmulatorOptions = {}
): Promise<LinkedInSearchEmulator> => {
  const initial = buildSeedState(options.seed ?? {})

  if (Predicate.isString(initial)) {
    throw inputInvalid('seed', initial)
  }

  checkBooleanDrills(options.drills, linkedInSearchEmulatorDrillKnobs, inputInvalid)

  const drills = options.drills ?? {}

  const env: LinkedInSearchApiEnv = {
    drills: {
      defaultSearchWithoutText: drills.defaultSearchWithoutText === true,
      numResultsIgnored: drills.numResultsIgnored === true,
      profileAnswersEmptyObject: drills.profileAnswersEmptyObject === true,
      emailAnswerOmitsEmail: drills.emailAnswerOmitsEmail === true,
      exaUnauthorizedAs5xx: drills.exaUnauthorizedAs5xx === true,
      enrichLayerUnauthorizedAs2xx: drills.enrichLayerUnauthorizedAs2xx === true,
      absentProfileAs2xx: drills.absentProfileAs2xx === true
    }
  }

  // Loaded lazily: the core imports Node builtins and reads files at import time.
  const core = await import('@emulators/core')

  return makeStatefulEmulator<
    LinkedInSearchEmulatorState,
    LinkedInSearchApiEnv,
    LinkedInSearchEmulatorSeed
  >(
    {
      routes: linkedInSearchApiRoutes,
      env,
      initial,
      buildSeed: buildSeedState,
      recordHeaders: [{ name: 'content-type', json: false }],
      failClosed: {
        unrecognised: unrecognisedReason,
        unrecognisedAuthorization: unrecognisedAuthorizationReason
      },
      bearerDigest: linkedInSearchKeyDigest,
      // No cursors or other runtime data.
      clearRuntime: () => undefined,
      runtimeState: () => ({}),
      seedSummary: state => ({
        searches: state.searches.length,
        profiles: state.profiles.length,
        absentProfiles: state.absentProfileUrls.length,
        exaRejectedKeys: state.exaRejectedKeyDigests.length,
        enrichLayerRejectedKeys: state.enrichLayerRejectedKeyDigests.length
      }),
      inputInvalid
    },
    async dispatch => {
      const definition = core.defineEmulator<LinkedInSearchEmulatorState>({
        name: 'linkedin-search',
        cors: false,
        state: () => initial,
        validateSeed: value => {
          const decoded = decodeState(value)

          if (Predicate.isString(decoded)) {
            throw inputInvalid('seed', decoded)
          }

          return decoded
        },
        // The wrapper matched the route already and forwards every admitted request as a POST.
        setup: ({ app, state }) => {
          app.post('*', context => dispatch(state, context.req.raw))
        }
      })

      const runtime = await core.createCustomRuntime(definition, { seed: initial })

      return {
        fetch: request => runtime.fetch(request),
        baseUrl: runtime.baseUrl,
        snapshot: () => runtime.snapshot().state,
        restore: state => {
          const current: EmulatorSnapshot<LinkedInSearchEmulatorState> = runtime.snapshot()

          return runtime.restore({ ...current, state })
        },
        close: () => runtime.close()
      }
    }
  )
}
