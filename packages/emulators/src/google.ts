/**
 * Stateful Google emulator (the Gmail, Calendar, and Drive routes the Google conformance cases
 * send), built on the upstream `@emulators/core` custom runtime, with a request ledger, status
 * faults, and an `/_emulate/*` control plane.
 *
 * It never imports SDK code: its wire shapes, error envelopes, and default seed are copied as data
 * from the synthetic Google conformance fixtures, and every route names the conformance cases it
 * follows in `googleEmulatorRoutes`. Only the routes those thirteen cases (with their cleanup)
 * send are emulated: Gmail on `https://gmail.googleapis.com` (`/gmail/v1/users/me/...` and the
 * multipart send upload), Calendar and Drive on `https://www.googleapis.com` (`/calendar/v3` and
 * `/drive/v3`). Each route answers only on its recorded origin (`fetchOn(origin)` serves one
 * origin behind a loopback rewrite). Response behaviour comes only from the fixtures: anything
 * they do not show answers one ledgered 400 not-emulated, writes nothing, and uses up no fault.
 * That includes an empty listing and every read of the leftover lookup
 * (`findGoogleConformanceLeftovers`, whose label listing, draft search, and free-text event query
 * no fixture records): the lookup fails, and runners print their lookup-failed WARN.
 *
 * The practice send (`google.gmail.send-practice-address`) is irreversible on Gmail. Here it is
 * only recorded in the state (the sent message reads back; nothing is delivered anywhere), and only
 * the recorded 7-bit message whose sole recipient header is `To: <the seeded practice address>`
 * is accepted, and only while that address is the recorded `practice@example.test` (the recorded
 * `sizeEstimate` covers it, as it covers the draft and send subjects, which therefore take only a
 * run id of the fixtures' 13-character length).
 *
 * Fail closed: Google follows the shared fail-closed rule of `src/stateful-emulator.ts` (its opt-in
 * `failClosed` mode, the same rule as `/github`). Every route parameter has a raw pattern matched
 * in full, so a request is recognised only when its raw path is exactly an emulated route shape
 * under that route's method and any `Authorization` header is exactly `Bearer <token>` with a
 * recognisable bearer (below); every other request is ledgered and answered with constant text only
 * (`/<unrecognised>`, a standard method or `<other>`, an empty query, no body, a constant reason).
 * The bearer value is never compared against anything, stored, forwarded, or ledgered. A recognised
 * request that repeats it in its raw path, any path segment, the query or any query key or value,
 * the recorded `content-type` header, or its raw body (the multipart send body included), or, on
 * the draft compose and update routes, in the base64url-decoded MIME of `message.raw` (Gmail's own
 * wire format wraps the draft this way; the routes give it to the wrapper as a decoded view), is
 * ledgered as the constant credential-repeat entry, checked through the wrapper's fixpoint closure
 * of a tolerant percent-decode and a tolerant JSON-unescape; any other recognised request has the
 * bearer scrubbed from its ledgered fields and every not-emulated reason. A `message.raw` the route
 * would refuse (anything but canonical unpadded base64url of exactly the recorded draft MIME, the
 * run id aside) makes the view throw a `DecodedViewRefusal` with one of the route's declared
 * constant reasons (`viewRefusalReasons`: the canonical-base64url reason, the
 * other-than-the-recorded-run-draft reason, the 13-character run-id reason, the extra-key reason),
 * which the wrapper ledgers in the constant entry before anything is recorded (or
 * `the request body repeats the credential` when the raw decodes cleanly to text holding the
 * bearer), so a refused `message.raw` never reaches the ledger. Google refusals use the wrapper's
 * constant-reason `exactQuery` and `exactBodyKeys`, so they never echo a request's own query or
 * body keys.
 *
 * Request-shape latitude (`/google`, the only accepted deviations): any bearer value in the RFC
 * 6750 `b64token` syntax (`[A-Za-z0-9\-._~+/]+=*`) of at least 8 characters, starting with a
 * character in `[G-Zg-z\-._~+/]` other than `n`, `r`, `t`, `u`, with at least one outside
 * `[0-9.eE+-]` (Google's `ya29.…` access tokens qualify), that occurs nowhere else in the request
 * (never compared against anything, stored, or ledgered); extra request headers (except
 * `X-Goog-Drive-Resource-Keys`, which no fixture sends); JSON key order; `content-type` media-type
 * parameters on JSON requests; query parameters in any order; any `run-` run id (at most 40
 * characters) in a run-scoped label name, event summary, or folder name; in a draft subject
 * (compose and update) and the sent subject, only a run id of exactly 13 characters, the length of
 * the fixtures' `run-synthetic`, because the recorded `sizeEstimate` of the draft and sent messages
 * (answered by their message reads and the draft thread) covers the subject; on the practice send,
 * a `content-type` of exactly `multipart/related; boundary=<b>` with any one unquoted boundary of 1
 * to 70 `[A-Za-z0-9_]` characters and no other parameter; a `gmail.list` `maxResults` from 1 to
 * 500, a `calendar.list_events` `maxResults` from 1 to 2500, and a `drive.list_files` `pageSize`
 * from 1 to 1000; any `timeMin` before `timeMax` (RFC 3339 instants with a real calendar date, hour
 * 0 to 23, minute and second 0 to 59, and a `Z` or in-range numeric offset); any id of an item the
 * state holds where a fixture has an id (writes: only items created here, plus label changes,
 * trash, and untrash of a stored non-draft message); and, for an id the state does not hold, only
 * the recorded not-found answers (a `format=minimal` read of a 16-hex-digit message id, a read of a
 * `Label_<1 to 999999999>` label, a delete of an `r-<digits>` draft, and a Drive file read). A seed
 * may set another `practiceAddress`, but then every send is refused, since the recorded
 * `sizeEstimate` of the sent message also covers the address: the send answers only while the
 * seeded address is the recorded `practice@example.test`. On the draft compose and update routes,
 * `message.raw` must be canonical unpadded base64url of exactly the recorded draft MIME of that
 * route, the run id aside; any other `message.raw` (line-wrapped, the standard alphabet, padded,
 * with a stray character, or with MIME-level encodings such as RFC 2047 encoded-words,
 * quoted-printable, or UTF-16) is refused before anything is recorded or a fault is decided, as a
 * constant entry with the route's own declared reason
 * (`message.raw must be canonical base64url UTF-8 MIME`,
 * `a draft compose other than the recorded run draft is not emulated` or its `update` form, the
 * 13-character run-id reason, or `message has a key this route does not take`), or
 * `the request body repeats the credential` when that raw decodes cleanly to text holding the
 * bearer, so a refused `message.raw` never reaches the ledger and an admitted one is the recorded
 * text. `Authorization` must be exactly `Bearer <token>` (that spelling, one space). Everything
 * else (other keys, values, formats, query parameters, empty query components such as a bare `?` or
 * a stray `&`, recorded headers such as Drive's `accept: application/json` missing, another origin,
 * repeated query parameters, any recipient but the seeded practice address, a draft or send run id
 * of another length, a bearer repeated anywhere in the request, including base64url-encoded inside
 * a draft's `message.raw`, and page tokens not issued for the same list since the last reset or
 * seed, or whose list changed) is not emulated.
 *
 * Node-only: `@emulators/core` imports Node builtins, so the core is loaded lazily by
 * `makeGoogleEmulator` (importing this module has no side effects).
 *
 * @experimental
 */
import type { EmulatorSnapshot } from '@emulators/core'
import { Data, Predicate } from 'effect'
import { calendarRoutes } from './google/calendar.ts'
import { driveRoutes } from './google/drive.ts'
import { gmailRoutes } from './google/gmail.ts'
import {
  googleEmulatorDrillKnobs,
  type GoogleApiEnv,
  type GoogleEmulatorDrills,
  type GoogleRoute
} from './google/shared.ts'
import {
  buildSeedState,
  decodeState,
  type GoogleEmulatorSeed,
  type GoogleEmulatorState
} from './google/state.ts'
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
  googleEmulatorApisOrigin,
  googleEmulatorGmailOrigin,
  type GoogleEmulatorDrills
} from './google/shared.ts'

export {
  GoogleEmulatorAttachment,
  GoogleEmulatorCalendar,
  GoogleEmulatorCalendarEvent,
  GoogleEmulatorDraft,
  GoogleEmulatorDriveFile,
  GoogleEmulatorEventBoundary,
  GoogleEmulatorGmailLabel,
  GoogleEmulatorGmailMessage,
  GoogleEmulatorImpliedMessage,
  GoogleEmulatorPracticeAddress,
  GoogleEmulatorProfile,
  GoogleEmulatorSeed,
  GoogleEmulatorStateSchema,
  type GoogleEmulatorState
} from './google/state.ts'

const googleApiRoutes: ReadonlyArray<GoogleRoute> = [
  ...gmailRoutes,
  ...calendarRoutes,
  ...driveRoutes
]

/**
 * Route evidence manifest: every emulated route, whether it writes, and the conformance cases
 * whose (currently synthetic, unverified) wire claims it follows. Kept in sync with the handlers
 * by construction (both come from one route table). Every route cites at least one case.
 */
export const googleEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> =
  googleApiRoutes.map(routeEvidence)

/**
 * Optional fault filter; an omitted field matches every request. `path` ending in `*` is a
 * prefix.
 */
export const GoogleFaultMatch = StatefulFaultMatch

export type GoogleFaultMatch = typeof StatefulFaultMatch.Type

/**
 * A status fault (400-599): answer matching requests with this status, headers, and body instead
 * of the route's write, so nothing is written. The body defaults to
 * `{ error: { type: 'emulator_fault', message } }`; `count` limits how many requests it answers.
 * Only a request the emulator would answer reaches a fault: a request that is not emulated, by
 * its shape or by the state, never uses one up.
 */
export const GoogleFault = StatefulFault

export type GoogleFault = StatefulFault

export type GoogleFaultState = StatefulFaultState

export type GoogleLedgerEntry = StatefulLedgerEntry

export type GoogleCoverage = StatefulCoverage

/** Invalid emulator input from the JS API: a seed, a fault, or an option. A programmer error. */
export class GoogleEmulatorInputInvalid extends Data.TaggedError('GoogleEmulatorInputInvalid')<{
  readonly input: StatefulInputKind
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid Google emulator ${this.input}: ${this.reason}`
  }
}

export type GoogleEmulatorOptions = {
  /** Typed seed; defaults to the fixture entities (`profile: 'default'`). */
  readonly seed?: GoogleEmulatorSeed
  /**
   * Clock in epoch milliseconds (created and updated event times, Drive folder times, and the
   * sent message's `Date` header). Defaults to `Date.now`.
   */
  readonly now?: () => number
  /** Drill knobs (tests only): make the emulator disagree with one conformance case. */
  readonly drills?: GoogleEmulatorDrills
}

export type GoogleEmulator = StatefulEmulatorApi<GoogleEmulatorState, GoogleEmulatorSeed>

/** The constant reason of a request on no emulated route shape (nothing of it is ledgered). */
const googleUnrecognisedReason = 'no emulated Google route for this method and path'

/** The constant reason of a request whose `Authorization` header is not one recognisable bearer. */
const googleUnrecognisedAuthorizationReason =
  'an unrecognisable Authorization header is not emulated'

const inputInvalid = (input: StatefulInputKind, reason: string) =>
  new GoogleEmulatorInputInvalid({ input, reason })

/**
 * Create a stateful Google emulator on the `@emulators/core` custom runtime. Each call has its
 * own state, ledger, faults, and page tokens. Rejects with `GoogleEmulatorInputInvalid` for an
 * invalid seed or option. See `src/stateful-emulator.ts` for the request precedence.
 */
export const makeGoogleEmulator = async (
  options: GoogleEmulatorOptions = {}
): Promise<GoogleEmulator> => {
  const initial = buildSeedState(options.seed ?? {})

  if (Predicate.isString(initial)) {
    throw inputInvalid('seed', initial)
  }

  checkBooleanDrills(options.drills, googleEmulatorDrillKnobs, inputInvalid)

  const drills = options.drills ?? {}

  const env: GoogleApiEnv = {
    now: options.now ?? (() => Date.now()),
    drills: {
      gmailPageRepeats: drills.gmailPageRepeats === true,
      attachmentStandardBase64: drills.attachmentStandardBase64 === true,
      notFoundWithoutMessage: drills.notFoundWithoutMessage === true,
      labelDeleteKeepsOnMessages: drills.labelDeleteKeepsOnMessages === true,
      draftUpdateKeepsContent: drills.draftUpdateKeepsContent === true,
      trashAnswerOmitsTrash: drills.trashAnswerOmitsTrash === true,
      sentMessageWithoutTo: drills.sentMessageWithoutTo === true,
      calendarPageRepeats: drills.calendarPageRepeats === true,
      eventPatchKeepsSummary: drills.eventPatchKeepsSummary === true,
      repeatedEventDeleteConflict: drills.repeatedEventDeleteConflict === true,
      drivePageRepeats: drills.drivePageRepeats === true,
      getFileWithoutParents: drills.getFileWithoutParents === true,
      listIncludesTrashed: drills.listIncludesTrashed === true
    },
    pageTokens: new Map(),
    generation: { current: 0 },
    firstIssued: new Map()
  }

  // Loaded lazily: the core imports Node builtins and reads files at import time.
  const core = await import('@emulators/core')

  return makeStatefulEmulator<GoogleEmulatorState, GoogleApiEnv, GoogleEmulatorSeed>(
    {
      routes: googleApiRoutes,
      env,
      initial,
      buildSeed: buildSeedState,
      requestProblem: header =>
        header('x-goog-drive-resource-keys') === undefined
          ? undefined
          : 'X-Goog-Drive-Resource-Keys is not emulated (no fixture sends it)',
      // `content-type` only (never a credential header); the bearer is checked in it too.
      recordHeaders: [{ name: 'content-type', json: false }],
      // Page token values never cross a reset or seed: the generation makes later tokens distinct.
      clearRuntime: () => {
        env.pageTokens.clear()
        env.generation.current += 1
      },
      runtimeState: () => ({ pageTokens: env.pageTokens.size }),
      seedSummary: state => ({
        messages: state.messages.length,
        events: state.events.length,
        files: state.files.length
      }),
      inputInvalid,
      failClosed: {
        unrecognised: googleUnrecognisedReason,
        unrecognisedAuthorization: googleUnrecognisedAuthorizationReason
      }
    },
    async dispatch => {
      const definition = core.defineEmulator<GoogleEmulatorState>({
        name: 'google',
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
          const current: EmulatorSnapshot<GoogleEmulatorState> = runtime.snapshot()

          return runtime.restore({ ...current, state })
        },
        close: () => runtime.close()
      }
    }
  )
}
