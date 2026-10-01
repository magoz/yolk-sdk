/**
 * Stateful Notion emulator (the `/v1` routes on `https://api.notion.com` at API version
 * 2025-09-03), built on the upstream `@emulators/core` custom runtime, with a request ledger,
 * status faults, and an `/_emulate/*` control plane.
 *
 * It never imports SDK code: its wire shapes, error envelopes, and default seed are copied as data
 * from the synthetic Notion conformance fixtures, and every route names the conformance cases it
 * follows in `notionEmulatorRoutes`. Only the routes those eight cases (with their cleanup) send
 * are emulated. Response behaviour comes only from the fixtures: anything they do not show answers
 * one ledgered 400 not-emulated, writes nothing, and uses up no fault. That includes a search
 * without matches or matching a trashed page, so the read-only leftover lookup fails on a clean
 * workspace and after the write case (the live runner prints its lookup-failed WARN). Search
 * considers only the pages whose content the state holds; an implied page never matches.
 *
 * Request-shape latitude (`/notion`, the only accepted deviations): any bearer value (never
 * checked or stored); extra request headers; JSON key order; `content-type` media-type
 * parameters; the order of query parameters; Notion ids with or without dashes, in any case; any
 * search `query` (looked up in the state); and any `page_size` from 1 to 100 whose page shows
 * only recorded results (the data source query: 1). `Notion-Version` must be `2025-09-03`.
 * Everything else (other keys, filters, booleans, sorts, query parameters, titles, repeated or
 * missing `page_size`, and cursors not issued for the same list since the last reset or whose
 * list changed) is not emulated.
 *
 * Node-only: `@emulators/core` imports Node builtins, so the core is loaded lazily by
 * `makeNotionEmulator` (importing this module has no side effects).
 *
 * @experimental
 */
import type { EmulatorSnapshot } from '@emulators/core'
import { Data, Predicate } from 'effect'
import {
  notionApiRoutes,
  notionEmulatorDrillKnobs,
  notionEmulatorVersion,
  type NotionApiEnv,
  type NotionEmulatorDrills
} from './notion/api.ts'
import {
  buildSeedState,
  decodeState,
  type NotionEmulatorSeed,
  type NotionEmulatorState
} from './notion/state.ts'
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
  notionEmulatorBasePath,
  notionEmulatorVersion,
  type NotionEmulatorDrills
} from './notion/api.ts'

export {
  NotionEmulatorBlock,
  NotionEmulatorBotUser,
  NotionEmulatorDataSource,
  NotionEmulatorDatabase,
  NotionEmulatorImpliedPage,
  NotionEmulatorPage,
  NotionEmulatorParent,
  NotionEmulatorProfile,
  NotionEmulatorPropertyItems,
  NotionEmulatorSeed,
  NotionEmulatorStateSchema,
  type NotionEmulatorState
} from './notion/state.ts'

/** Origin the connector calls; also the origin of property item `next_url` values. */
export const notionEmulatorDefaultOrigin = 'https://api.notion.com'

/**
 * Route evidence manifest: every emulated route, whether it writes, and the conformance cases
 * whose (currently synthetic, unverified) wire claims it follows. Kept in sync with the handlers
 * by construction (both come from one route table).
 */
export const notionEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> =
  notionApiRoutes.map(routeEvidence)

/** Optional fault filter; an omitted field matches every request. `path` ending in `*` is a prefix. */
export const NotionFaultMatch = StatefulFaultMatch

export type NotionFaultMatch = typeof StatefulFaultMatch.Type

/**
 * A status fault (400-599): answer matching requests with this status, headers, and body instead
 * of the route's write, so nothing is written. The body defaults to
 * `{ error: { type: 'emulator_fault', message } }`; `count` limits how many requests it answers.
 * Only a request the emulator would answer reaches a fault: a request that is not emulated, by
 * its shape or by the state, never uses one up.
 */
export const NotionFault = StatefulFault

export type NotionFault = StatefulFault

export type NotionFaultState = StatefulFaultState

export type NotionLedgerEntry = StatefulLedgerEntry

export type NotionCoverage = StatefulCoverage

/** Invalid emulator input from the JS API: a seed, a fault, or an option. A programmer error. */
export class NotionEmulatorInputInvalid extends Data.TaggedError('NotionEmulatorInputInvalid')<{
  readonly input: StatefulInputKind
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid Notion emulator ${this.input}: ${this.reason}`
  }
}

export type NotionEmulatorOptions = {
  /** Typed seed; defaults to the fixture entities (`profile: 'default'`). */
  readonly seed?: NotionEmulatorSeed
  /** Clock in epoch milliseconds (created page timestamps). Defaults to `Date.now`. */
  readonly now?: () => number
  /** Origin of property item `next_url` values. Defaults to `https://api.notion.com`. */
  readonly baseUrl?: string
  /** Drill knobs (tests only): make the emulator disagree with one conformance claim. */
  readonly drills?: NotionEmulatorDrills
}

export type NotionEmulator = StatefulEmulatorApi<NotionEmulatorState, NotionEmulatorSeed> & {
  /** Origin of property item `next_url` values. */
  readonly baseUrl: string
}

const inputInvalid = (input: StatefulInputKind, reason: string) =>
  new NotionEmulatorInputInvalid({ input, reason })

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

/**
 * Create a stateful Notion emulator on the `@emulators/core` custom runtime. Each call has its
 * own state, ledger, and faults. Rejects with `NotionEmulatorInputInvalid` for an invalid seed or
 * option. Every request needs `Notion-Version: 2025-09-03` (else not emulated). See
 * `src/stateful-emulator.ts` for the request precedence.
 */
export const makeNotionEmulator = async (
  options: NotionEmulatorOptions = {}
): Promise<NotionEmulator> => {
  const initial = buildSeedState(options.seed ?? {})

  if (Predicate.isString(initial)) {
    throw inputInvalid('seed', initial)
  }

  const origin = validOrigin(options.baseUrl ?? notionEmulatorDefaultOrigin)

  if (origin === undefined) {
    throw inputInvalid(
      'option',
      'baseUrl must be an http(s) origin without path, query, hash, or credentials'
    )
  }

  checkBooleanDrills(options.drills, notionEmulatorDrillKnobs, inputInvalid)

  const drills = options.drills ?? {}

  const env: NotionApiEnv = {
    now: options.now ?? (() => Date.now()),
    origin,
    drills: {
      searchRepeatsResults: drills.searchRepeatsResults === true,
      botUserAsPerson: drills.botUserAsPerson === true,
      envelopeStatusMismatch: drills.envelopeStatusMismatch === true,
      omitTitlePlainText: drills.omitTitlePlainText === true,
      blockCursorRepeats: drills.blockCursorRepeats === true,
      rejectDoubleEncodedPropertyId: drills.rejectDoubleEncodedPropertyId === true,
      rowParentAsDatabase: drills.rowParentAsDatabase === true,
      trashedPageNotFound: drills.trashedPageNotFound === true
    },
    cursors: new Map(),
    propertyCursorCounter: { next: 1 }
  }

  // Loaded lazily: the core imports Node builtins and reads files at import time.
  const core = await import('@emulators/core')

  const api = await makeStatefulEmulator<NotionEmulatorState, NotionApiEnv, NotionEmulatorSeed>(
    {
      routes: notionApiRoutes,
      env,
      initial,
      buildSeed: buildSeedState,
      requestProblem: header =>
        header('notion-version') === notionEmulatorVersion
          ? undefined
          : `Notion-Version other than ${notionEmulatorVersion} (the version every fixture sends) is not emulated`,
      recordHeaders: [{ name: 'notion-version', json: false }],
      // Property cursor numbers keep advancing, so a cursor from before a reset is never reissued.
      clearRuntime: () => env.cursors.clear(),
      runtimeState: () => ({}),
      seedSummary: state => ({
        pages: state.pages.length,
        blocks: state.blocks.length,
        dataSources: state.dataSources.length
      }),
      inputInvalid
    },
    async dispatch => {
      const definition = core.defineEmulator<NotionEmulatorState>({
        name: 'notion',
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
          const current: EmulatorSnapshot<NotionEmulatorState> = runtime.snapshot()

          return runtime.restore({ ...current, state })
        },
        close: () => runtime.close()
      }
    }
  )

  return { ...api, baseUrl: origin }
}
