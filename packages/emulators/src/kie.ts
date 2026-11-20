/**
 * Stateful Kie emulator (the Market API routes of the Kie conformance cases on
 * `https://api.kie.ai`: `GET /api/v1/jobs/recordInfo` and `POST /api/v1/jobs/createTask`), built
 * on the upstream `@emulators/core` custom runtime, with a request ledger, status faults, and an
 * `/_emulate/*` control plane.
 *
 * It never imports SDK code: its answers, error bodies, and default seed are copied as data from
 * the synthetic Kie conformance fixtures, and every route names the conformance cases it follows in
 * `kieEmulatorRoutes`. Only the routes those six cases send are emulated. Response behaviour comes
 * only from the fixtures, byte for byte: `recordInfo` answers a held finished task's record (the
 * default seed holds the fixtures' `success` and `fail` tasks), or, for a seeded absent task id,
 * the recorded not-found envelope (`code` 422 at HTTP 200); a key a seed marks as rejected answers
 * the recorded 401 for any well-formed task id (the default seed rejects the synthetic invalid key
 * the unauthorized case sends). `createTask` accepts only the two recorded create flows (GPT Image 2
 * text-to-image, square at 1K; Wan 2.7 image-to-video, 720p for 5 seconds) and answers envelope
 * `code` 200 with a minted task id. A create is irreversible on Kie (it spends credits and cannot
 * be cancelled), so the emulator records the created task in the state; created tasks are never
 * readable, since no fixture records a created task's `recordInfo`. Anything else answers one
 * ledgered 400 not-emulated and uses up no fault. Every route answers only on its recorded origin
 * (`fetchOn(origin)` serves it behind a loopback rewrite).
 *
 * Fail closed, on the shared wrapper's fail-closed mode exactly as `/github`, `/google`, and
 * `/linkedin-search` use it: a request is recognised only when its raw path is exactly an emulated
 * route path under that route's method, and any `Authorization` header is exactly
 * `Bearer <token>` with a recognisable bearer (the RFC 6750 `b64token` syntax, at least 8
 * characters, a first character in `[G-Zg-z\-._~+/]` other than `n`, `r`, `t`, `u`, and a
 * character outside `[0-9.eE+-]`). Every other request is ledgered and answered with constant text
 * only (`/<unrecognised>`, a standard method or `<other>`, an empty query, no body, a constant
 * reason). A recognised request that repeats the bearer anywhere (its raw path, the raw query or
 * any query key or value, the recorded `accept` and `content-type` headers, or its body, through
 * the wrapper's fixpoint closure of tolerant percent-decoding and JSON-unescaping, capped, where a
 * cap refuses) is ledgered with constant text only; any other has the bearer scrubbed from every
 * ledgered field and reason. The bearer is never stored, forwarded, or ledgered: routes see only
 * its digest (the wrapper's opt-in `bearerDigest`; SHA-256 of the origin, a space, and the key),
 * which a plan compares with the digests of the seed's rejected keys; the state holds only those
 * digests, and seed errors are constant text (a category and a field path) that never quote a key.
 * Refusals never echo a request's own query or body keys (the wrapper's constant-reason
 * `exactQuery` and `exactBodyKeys`).
 *
 * Request-shape latitude (`/kie`, the only accepted deviations): any bearer value in the RFC 6750
 * `b64token` syntax (`[A-Za-z0-9\-._~+/]+=*`) of at least 8 characters, starting with a character
 * in `[G-Zg-z\-._~+/]` other than `n`, `r`, `t`, `u`, with at least one outside `[0-9.eE+-]`, that
 * occurs nowhere else in the request (never stored or ledgered; only its digest is compared, with
 * the digests of the keys the seed marks as rejected); extra request headers; JSON key order;
 * `content-type` media-type parameters on the create; with a key the seed marks as rejected, any
 * `recordInfo` task id of 1 to 128 letters, digits, underscores, or hyphens, answered the recorded
 * 401; any non-empty `prompt` within the connector's limit (20000 characters for GPT Image 2, 5000
 * for Wan 2.7); and any absolute https `first_frame_url` without credentials or whitespace of at
 * most 2048 characters. `Authorization` must be exactly `Bearer <token>` (that spelling, one
 * space), and `Accept` `application/json`. Everything else (a request without `Authorization`,
 * other body keys or values, a `callBackUrl`, another model, aspect ratio, resolution, or duration,
 * `input_urls`, a task id the state holds neither as a finished task nor as absent, a created
 * task's `recordInfo`, a create with a rejected key, any query parameter on the create, other,
 * missing, or repeated query parameters on `recordInfo`, a query parameter name in any but its
 * plain form, empty query components such as a bare `?` or a stray `&`, another origin, and a
 * bearer repeated anywhere in the request) is not emulated.
 *
 * Node-only: `@emulators/core` imports Node builtins, so the core is loaded lazily by
 * `makeKieEmulator` (importing this module has no side effects).
 *
 * @experimental
 */
import { Data, Predicate } from 'effect'
import {
  kieApiRoutes,
  kieEmulatorDrillKnobs,
  type KieApiEnv,
  type KieEmulatorDrills
} from './kie/api.ts'
import {
  buildSeedState,
  decodeState,
  kieKeyDigest,
  type KieEmulatorSeed,
  type KieEmulatorState
} from './kie/state.ts'
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
import { statefulCoreRuntime } from './stateful-core.ts'

export type { EmulatorEvidence, EmulatorRouteEvidence } from './route-evidence.ts'

export { emulatorEvidenceHeader } from './route-evidence.ts'

export { kieEmulatorErrorBodies, type KieEmulatorDrills } from './kie/api.ts'

export {
  KieEmulatorCreatedTask,
  KieEmulatorSeed,
  KieEmulatorStateSchema,
  KieEmulatorTask,
  kieEmulatorCreatedId,
  kieEmulatorCreatedIdPrefix,
  kieEmulatorDefaultRejectedKeys,
  kieEmulatorMaxCreated,
  kieEmulatorOrigin,
  type KieEmulatorState
} from './kie/state.ts'

/**
 * Route evidence manifest: every emulated route and the conformance cases whose (currently
 * synthetic, unverified) wire claims it follows. `POST /api/v1/jobs/createTask` is a connector
 * write. Kept in sync with the handlers by construction (both come from one route table).
 */
export const kieEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> =
  kieApiRoutes.map(routeEvidence)

/**
 * Optional fault filter; an omitted field matches every request. `method` is the HTTP method;
 * `path` is the raw request path (ending in `*`, a prefix); `route` is a route template of the
 * manifest (another value is rejected when the fault is added).
 */
export const KieFaultMatch = StatefulFaultMatch

export type KieFaultMatch = typeof StatefulFaultMatch.Type

/**
 * A status fault (400-599): answer matching requests with this status, headers, and body instead
 * of the route's answer. The body defaults to `{ error: { type: 'emulator_fault', message } }`;
 * `count` limits how many requests it answers. Only a request the emulator would answer reaches a
 * fault: a request that is not emulated, by its shape or by the state, never uses one up, and a
 * faulted create records nothing and mints no id.
 */
export const KieFault = StatefulFault

export type KieFault = StatefulFault

export type KieFaultState = StatefulFaultState

export type KieLedgerEntry = StatefulLedgerEntry

export type KieCoverage = StatefulCoverage

/** Invalid emulator input from the JS API: a seed, a fault, or an option. A programmer error. */
export class KieEmulatorInputInvalid extends Data.TaggedError('KieEmulatorInputInvalid')<{
  readonly input: StatefulInputKind
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid Kie emulator ${this.input}: ${this.reason}`
  }
}

export type KieEmulatorOptions = {
  /** Typed seed; defaults to the fixture entities. */
  readonly seed?: KieEmulatorSeed
  /** Drill knobs (tests only): make the emulator disagree with one conformance claim. */
  readonly drills?: KieEmulatorDrills
}

export type KieEmulator = StatefulEmulatorApi<KieEmulatorState, KieEmulatorSeed>

const inputInvalid = (input: StatefulInputKind, reason: string) =>
  new KieEmulatorInputInvalid({ input, reason })

/** The constant reason of a request on no emulated route shape. */
const unrecognisedReason = 'no emulated Kie route for this method and path'

/** The constant reason of a request whose `Authorization` header is not one recognisable bearer. */
const unrecognisedAuthorizationReason = 'an unrecognisable Authorization header is not emulated'

/** The `Accept` value every fixture sends. */
const kieEmulatorAccept = 'application/json'

/**
 * Create a stateful Kie emulator on the `@emulators/core` custom runtime. Each call has its own
 * state, ledger, and faults. Rejects with `KieEmulatorInputInvalid` for an invalid seed or option.
 * See `src/stateful-emulator.ts` for the request precedence.
 */
export const makeKieEmulator = async (options: KieEmulatorOptions = {}): Promise<KieEmulator> => {
  const initial = buildSeedState(options.seed ?? {})

  if (Predicate.isString(initial)) {
    throw inputInvalid('seed', initial)
  }

  checkBooleanDrills(options.drills, kieEmulatorDrillKnobs, inputInvalid)

  const drills = options.drills ?? {}

  const env: KieApiEnv = {
    drills: {
      successWithoutResultUrls: drills.successWithoutResultUrls === true,
      failedTaskAsEnvelopeError: drills.failedTaskAsEnvelopeError === true,
      absentTaskAsSuccess: drills.absentTaskAsSuccess === true,
      unauthorizedAs5xx: drills.unauthorizedAs5xx === true,
      imageCreateInsufficientCredits: drills.imageCreateInsufficientCredits === true,
      videoCreateEmptyTaskId: drills.videoCreateEmptyTaskId === true
    }
  }

  return makeStatefulEmulator<KieEmulatorState, KieApiEnv, KieEmulatorSeed>(
    {
      routes: kieApiRoutes,
      env,
      initial,
      buildSeed: buildSeedState,
      requestProblem: header =>
        header('accept') === kieEmulatorAccept
          ? undefined
          : `Accept other than ${kieEmulatorAccept} is not emulated`,
      recordHeaders: [
        { name: 'accept', json: false },
        { name: 'content-type', json: false }
      ],
      failClosed: {
        unrecognised: unrecognisedReason,
        unrecognisedAuthorization: unrecognisedAuthorizationReason
      },
      bearerDigest: kieKeyDigest,
      // No cursors or other runtime data: the created-id counter lives in the state.
      clearRuntime: () => undefined,
      runtimeState: () => ({}),
      seedSummary: state => ({
        tasks: state.tasks.length,
        absentTaskIds: state.absentTaskIds.length,
        rejectedKeys: state.rejectedKeyDigests.length
      }),
      inputInvalid
    },
    statefulCoreRuntime({ name: 'kie', initial, decodeState, inputInvalid })
  )
}
