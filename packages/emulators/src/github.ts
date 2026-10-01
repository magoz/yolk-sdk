/**
 * Stateful GitHub emulator (the REST routes of the GitHub conformance cases on
 * `https://api.github.com`, API version 2026-03-10), built on the upstream `@emulators/core`
 * custom runtime, with a request ledger, status faults, and an `/_emulate/*` control plane.
 *
 * It never imports SDK code: its wire shapes, error bodies, and default seed are copied as data
 * from the synthetic GitHub conformance fixtures, and every route names the conformance cases it
 * follows in `githubEmulatorRoutes`. Only the routes those seven cases send are emulated. Response
 * behaviour comes only from the fixtures: anything they do not show answers one ledgered 400
 * not-emulated, writes nothing, and uses up no fault. That includes the leftover lookup's
 * open-issue listing (`GET /repos/{owner}/{repo}/issues`, no fixture), so the read-only lookup
 * fails and the live runner prints its lookup-failed WARN. Every route answers only on the
 * recorded origin `https://api.github.com` (`fetchOn(origin)` serves it behind a loopback
 * rewrite).
 *
 * Fail closed: a request is recognised only when its raw path is exactly an emulated route shape
 * (every path parameter matches its raw pattern in full) under that route's method, and any
 * `Authorization` header is exactly `Bearer <token>` (a recognisable bearer, below). Every other
 * request is ledgered and answered with constant text only (`/<unrecognised>`, a standard method or
 * `<other>`, an empty query, no body, a constant reason). The bearer value is never compared
 * against anything, stored, forwarded, or ledgered. A recognised bearer must match the RFC 6750
 * `b64token` syntax exactly (`^[A-Za-z0-9\-._~+/]+=*$`, at least 8 characters), start with a
 * character in `[G-Zg-z\-._~+/]` other than `n`, `r`, `t`, `u`, and hold at least one character
 * outside the JSON-number alphabet `[0-9.eE+-]` (every GitHub and Google token form does: `ghp_…`,
 * `github_pat_…`, `gho_…`, `ya29.…`). So no number's text can contain it; it holds no escape
 * introducer (`%`, `\`, `"`), so no escape starts inside it; and its first character is no hex
 * digit and no JSON escape letter, so no stray `%`, `\`, or partial escape to its left can complete
 * with it, and its characters always decode in place. An `Authorization` header with any other
 * value is unrecognisable. A recognised request that repeats the bearer value in its raw path, any
 * path segment, the raw query or any query key or value, any recorded header, or its body is
 * refused and ledgered with constant text only: a standard method, the path `/<unrecognised>`, its
 * route template, an empty query, no headers or body, and a constant reason
 * (`the query repeats the credential`, for example). Each part is checked through a bounded closure
 * of two total, lexical transforms that cannot fail: a tolerant percent-decode (every `%XX` below
 * `%80` becomes its ASCII character; any other `%` sequence is left as it is) and a tolerant
 * JSON-unescape (in any text, whether or not it parses as JSON, `\uXXXX` below `\u0080` and `\"`,
 * `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t` become their characters). Starting from each part's raw
 * text, up to 4 rounds apply either transform to every text of the previous round, deduplicated,
 * and every intermediate text is checked for the bearer as a substring. So each part's raw text
 * gets 4 layers of percent-encoding or JSON escaping, in any order: the raw path and each raw path
 * segment, the raw query and each query key and value (already decoded once by `URLSearchParams`,
 * so one layer more), each recorded header, and the raw body (whose own JSON escaping costs a round
 * only where it escapes the bearer's text). Any other recognised request has the bearer value
 * scrubbed from its ledgered fields and every not-emulated reason (plan-time reasons included); its
 * recorded query is keyed by recorded key; a key recorded more than once lists its values in order
 * (as a JSON array); and recorded headers and query keys and values that start like JSON (`{`, `[`,
 * `"`) are recorded parsed with credential-named keys redacted at any depth, or as `<redacted>`
 * when they do not parse, whatever the header's declared format. Refusals never echo a request's
 * own query or body keys.
 *
 * Request-shape latitude (`/github`, the only accepted deviations): any bearer value in the RFC
 * 6750 `b64token` syntax (`[A-Za-z0-9\-._~+/]+=*`) of at least 8 characters, starting with a
 * character in `[G-Zg-z\-._~+/]` other than `n`, `r`, `t`, `u`, with at least one outside
 * `[0-9.eE+-]`, that occurs nowhere else in the request (never compared against anything, stored,
 * or ledgered); extra request headers; JSON key order; `content-type` media-type parameters; the
 * order of query parameters; any non-empty issue title and comment body, and any issue body text;
 * any comment listing `since` of the form `YYYY-MM-DDTHH:MM:SSZ`; any label listing `per_page` from
 * 1 to 100, with no `page` or a `page` from 2 to one past the last page; any issue search `q` that
 * starts with the seeded `repo:<owner>/<repo>` qualifier and whose query after it is longer than
 * 256 characters (answered the recorded 422); any issue number the repository has not reached
 * (answered the recorded 404); and any issue, comment, repository label, or file the state holds
 * where a fixture has one, under the per-route state rules. `Authorization` must be exactly
 * `Bearer <token>` (that spelling, one space), `Accept` `application/vnd.github+json`, and
 * `X-GitHub-Api-Version` `2026-03-10`. Everything else (other keys and values, query parameters,
 * empty query components such as a bare `?` or a stray `&`, another origin or repository, a
 * repeated query key, an explicit `page=1`, and a comment listing `per_page` other than 100) is not
 * emulated.
 *
 * Node-only: `@emulators/core` imports Node builtins, so the core is loaded lazily by
 * `makeGithubEmulator` (importing this module has no side effects).
 *
 * @experimental
 */
import type { EmulatorSnapshot } from '@emulators/core'
import { Data, Predicate } from 'effect'
import {
  githubApiRoutes,
  githubEmulatorAccept,
  githubEmulatorApiVersion,
  githubEmulatorDrillKnobs,
  type GithubApiEnv,
  type GithubEmulatorDrills
} from './github/api.ts'
import {
  buildSeedState,
  decodeState,
  type GithubEmulatorSeed,
  type GithubEmulatorState
} from './github/state.ts'
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
  githubEmulatorAccept,
  githubEmulatorApiVersion,
  githubEmulatorErrorBodies,
  githubEmulatorOrigin,
  type GithubEmulatorDrills
} from './github/api.ts'

export {
  GithubEmulatorComment,
  GithubEmulatorFile,
  GithubEmulatorIssue,
  GithubEmulatorLabel,
  GithubEmulatorProfile,
  GithubEmulatorRepository,
  GithubEmulatorSeed,
  GithubEmulatorSeedIssue,
  GithubEmulatorStateSchema,
  GithubEmulatorUser,
  type GithubEmulatorState
} from './github/state.ts'

/**
 * Route evidence manifest: every emulated route, whether it writes, and the conformance cases
 * whose (currently synthetic, unverified) wire claims it follows. Kept in sync with the handlers
 * by construction (both come from one route table).
 */
export const githubEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> =
  githubApiRoutes.map(routeEvidence)

/**
 * Optional fault filter; an omitted field matches every request. `path` ending in `*` is a
 * prefix.
 */
export const GithubFaultMatch = StatefulFaultMatch

export type GithubFaultMatch = typeof StatefulFaultMatch.Type

/**
 * A status fault (400-599): answer matching requests with this status, headers, and body instead
 * of the route's write, so nothing is written. The body defaults to
 * `{ error: { type: 'emulator_fault', message } }`; `count` limits how many requests it answers.
 * Only a request the emulator would answer reaches a fault: a request that is not emulated, by
 * its shape or by the state, never uses one up.
 */
export const GithubFault = StatefulFault

export type GithubFault = StatefulFault

export type GithubFaultState = StatefulFaultState

export type GithubLedgerEntry = StatefulLedgerEntry

export type GithubCoverage = StatefulCoverage

/** Invalid emulator input from the JS API: a seed, a fault, or an option. A programmer error. */
export class GithubEmulatorInputInvalid extends Data.TaggedError('GithubEmulatorInputInvalid')<{
  readonly input: StatefulInputKind
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid GitHub emulator ${this.input}: ${this.reason}`
  }
}

export type GithubEmulatorOptions = {
  /** Typed seed; defaults to the fixture entities (`profile: 'default'`). */
  readonly seed?: GithubEmulatorSeed
  /**
   * Clock in epoch milliseconds (created issue and comment times, close times). Defaults to
   * `Date.now`.
   */
  readonly now?: () => number
  /** Drill knobs (tests only): make the emulator disagree with one conformance claim. */
  readonly drills?: GithubEmulatorDrills
}

export type GithubEmulator = StatefulEmulatorApi<GithubEmulatorState, GithubEmulatorSeed>

const inputInvalid = (input: StatefulInputKind, reason: string) =>
  new GithubEmulatorInputInvalid({ input, reason })

/** The constant reason of a request on no emulated route shape. */
const githubUnrecognisedReason = 'no emulated GitHub route for this method and path'

/** The constant reason of a request whose `Authorization` header is not one recognisable bearer. */
const githubUnrecognisedAuthorizationReason =
  'an unrecognisable Authorization header is not emulated'

/**
 * Create a stateful GitHub emulator on the `@emulators/core` custom runtime. Each call has its own
 * state, ledger, and faults. Rejects with `GithubEmulatorInputInvalid` for an invalid seed or
 * option. Every request needs `Accept: application/vnd.github+json` and
 * `X-GitHub-Api-Version: 2026-03-10` (else not emulated). See `src/stateful-emulator.ts` for the
 * request precedence.
 */
export const makeGithubEmulator = async (
  options: GithubEmulatorOptions = {}
): Promise<GithubEmulator> => {
  const initial = buildSeedState(options.seed ?? {})

  if (Predicate.isString(initial)) {
    throw inputInvalid('seed', initial)
  }

  checkBooleanDrills(options.drills, githubEmulatorDrillKnobs, inputInvalid)

  const drills = options.drills ?? {}

  const env: GithubApiEnv = {
    now: options.now ?? (() => Date.now()),
    drills: {
      linkOmitsNext: drills.linkOmitsNext === true,
      notFoundOmitsDocumentationUrl: drills.notFoundOmitsDocumentationUrl === true,
      validationWithoutErrors: drills.validationWithoutErrors === true,
      contentUnfolded: drills.contentUnfolded === true,
      sinceExcludesEqual: drills.sinceExcludesEqual === true,
      addAnswerOmitsLabel: drills.addAnswerOmitsLabel === true,
      closeWithoutClosedAt: drills.closeWithoutClosedAt === true
    }
  }

  // Loaded lazily: the core imports Node builtins and reads files at import time.
  const core = await import('@emulators/core')

  return makeStatefulEmulator<GithubEmulatorState, GithubApiEnv, GithubEmulatorSeed>(
    {
      routes: githubApiRoutes,
      env,
      initial,
      buildSeed: buildSeedState,
      requestProblem: header => {
        // The values every fixture sends.
        if (header('accept') !== githubEmulatorAccept) {
          return `Accept other than ${githubEmulatorAccept} is not emulated`
        }

        return header('x-github-api-version') === githubEmulatorApiVersion
          ? undefined
          : `X-GitHub-Api-Version other than ${githubEmulatorApiVersion} is not emulated`
      },
      recordHeaders: [
        { name: 'accept', json: false },
        { name: 'x-github-api-version', json: false }
      ],
      failClosed: {
        unrecognised: githubUnrecognisedReason,
        unrecognisedAuthorization: githubUnrecognisedAuthorizationReason
      },
      // No cursors: label pages are page numbers, as GitHub's are.
      clearRuntime: () => undefined,
      runtimeState: () => ({}),
      seedSummary: state => ({
        labels: state.labels.length,
        issues: state.issues.length,
        files: state.files.length
      }),
      inputInvalid
    },
    async dispatch => {
      const definition = core.defineEmulator<GithubEmulatorState>({
        name: 'github',
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
          const current: EmulatorSnapshot<GithubEmulatorState> = runtime.snapshot()

          return runtime.restore({ ...current, state })
        },
        close: () => runtime.close()
      }
    }
  )
}
