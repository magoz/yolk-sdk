/**
 * Stateful Dropbox emulator (the `/2` RPC routes on `https://api.dropboxapi.com` and the upload
 * route on `https://content.dropboxapi.com`), built on the upstream `@emulators/core` custom
 * runtime, with a request ledger, status faults, and an `/_emulate/*` control plane.
 *
 * It never imports SDK code: its wire shapes, error envelopes, and default seed are copied as data
 * from the synthetic Dropbox conformance fixtures, and every route names the conformance cases it
 * follows in `dropboxEmulatorRoutes`. Only the routes those eight cases (with their cleanup) send
 * are emulated, each on the origin its fixtures record. Response behaviour comes only from the
 * fixtures: anything they do not show answers one ledgered 400 not-emulated, writes nothing, and
 * uses up no fault. That includes a listing of an empty folder, so the read-only leftover lookup
 * fails against the default seed's empty work folder (the live runner prints its lookup-failed
 * WARN).
 *
 * Request-shape latitude (`/dropbox`, the only accepted deviations): any bearer value (never
 * checked or stored); extra request headers; JSON key order; `content-type` media-type
 * parameters; any path and search query (looked up in the state); any `list_folder` `limit` from
 * 1 to 2000 and any `search_v2` `options.max_results` from 1 to 1000; and any upload body bytes.
 * Everything else (other keys, booleans, modes, query parameters, another origin, ids or revs
 * where the fixtures send paths, the root folder, and cursors not issued since the last reset or
 * whose listing changed) is not emulated.
 *
 * Node-only: `@emulators/core` imports Node builtins, so the core is loaded lazily by
 * `makeDropboxEmulator` (importing this module has no side effects).
 *
 * @experimental
 */
import type { EmulatorSnapshot } from '@emulators/core'
import { Data, Predicate } from 'effect'
import {
  dropboxApiRoutes,
  dropboxEmulatorDrillKnobs,
  type DropboxApiEnv,
  type DropboxCursor,
  type DropboxEmulatorDrills
} from './dropbox/api.ts'
import {
  buildSeedState,
  decodeState,
  type DropboxEmulatorSeed,
  type DropboxEmulatorState
} from './dropbox/state.ts'
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
  dropboxEmulatorApiOrigin,
  dropboxEmulatorBasePath,
  dropboxEmulatorContentOrigin,
  dropboxEmulatorErrorBodies,
  type DropboxEmulatorDrills
} from './dropbox/api.ts'

export {
  DropboxEmulatorDeleted,
  DropboxEmulatorEntry,
  DropboxEmulatorEntrySeed,
  DropboxEmulatorFile,
  DropboxEmulatorProfile,
  DropboxEmulatorSeed,
  DropboxEmulatorStateSchema,
  type DropboxEmulatorState
} from './dropbox/state.ts'

/**
 * Route evidence manifest: every emulated route, whether it writes, and the conformance cases
 * whose (currently synthetic, unverified) wire claims it follows. Kept in sync with the handlers
 * by construction (both come from one route table).
 */
export const dropboxEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> =
  dropboxApiRoutes.map(routeEvidence)

/** Optional fault filter; an omitted field matches every request. `path` ending in `*` is a prefix. */
export const DropboxFaultMatch = StatefulFaultMatch

export type DropboxFaultMatch = typeof StatefulFaultMatch.Type

/**
 * A status fault (400-599): answer matching requests with this status, headers, and body instead
 * of the route's write, so nothing is written. The body defaults to
 * `{ error: { type: 'emulator_fault', message } }`; `count` limits how many requests it answers.
 * Only a request the emulator would answer reaches a fault: a request that is not emulated, by
 * its shape or by the state, never uses one up.
 */
export const DropboxFault = StatefulFault

export type DropboxFault = StatefulFault

export type DropboxFaultState = StatefulFaultState

export type DropboxLedgerEntry = StatefulLedgerEntry

export type DropboxCoverage = StatefulCoverage

/** Invalid emulator input from the JS API: a seed, a fault, or an option. A programmer error. */
export class DropboxEmulatorInputInvalid extends Data.TaggedError('DropboxEmulatorInputInvalid')<{
  readonly input: StatefulInputKind
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid Dropbox emulator ${this.input}: ${this.reason}`
  }
}

/** A cursor as reported by `cursors()` and `/_emulate/state`. */
export type DropboxCursorState = {
  readonly cursor: string
  readonly kind: DropboxCursor['kind']
  /** Position of the next page in the listing or search. */
  readonly offset: number
}

export type DropboxEmulatorOptions = {
  /** Typed seed; defaults to the fixture entries (`profile: 'default'`). */
  readonly seed?: DropboxEmulatorSeed
  /** Clock in epoch milliseconds (upload timestamps). Defaults to `Date.now`. */
  readonly now?: () => number
  /** Drill knobs (tests only): make the emulator disagree with one conformance claim. */
  readonly drills?: DropboxEmulatorDrills
}

export type DropboxEmulator = StatefulEmulatorApi<DropboxEmulatorState, DropboxEmulatorSeed> & {
  /** The list and search cursors issued since the last reset or seed (runtime data). */
  readonly cursors: () => ReadonlyArray<DropboxCursorState>
}

const inputInvalid = (input: StatefulInputKind, reason: string) =>
  new DropboxEmulatorInputInvalid({ input, reason })

/**
 * Create a stateful Dropbox emulator on the `@emulators/core` custom runtime. Each call has its
 * own state, ledger, faults, and cursors. Rejects with `DropboxEmulatorInputInvalid` for an
 * invalid seed or option. See `src/stateful-emulator.ts` for the request precedence.
 */
export const makeDropboxEmulator = async (
  options: DropboxEmulatorOptions = {}
): Promise<DropboxEmulator> => {
  const initial = buildSeedState(options.seed ?? {})

  if (Predicate.isString(initial)) {
    throw inputInvalid('seed', initial)
  }

  checkBooleanDrills(options.drills, dropboxEmulatorDrillKnobs, inputInvalid)

  const drills = options.drills ?? {}

  const env: DropboxApiEnv = {
    now: options.now ?? (() => Date.now()),
    drills: {
      listFolderSinglePage: drills.listFolderSinglePage === true,
      getMetadataCaseSensitive: drills.getMetadataCaseSensitive === true,
      searchRepeatsMatches: drills.searchRepeatsMatches === true,
      notFoundAsPathLookup: drills.notFoundAsPathLookup === true,
      folderConflictAsFile: drills.folderConflictAsFile === true,
      deleteLeavesNoTombstone: drills.deleteLeavesNoTombstone === true,
      moveMintsNewId: drills.moveMintsNewId === true,
      uploadIgnoresRev: drills.uploadIgnoresRev === true
    },
    cursors: new Map(),
    cursorCounters: { list: 1, search: 1 }
  }

  const cursors = (): ReadonlyArray<DropboxCursorState> =>
    [...env.cursors].map(([cursor, state]) => ({ cursor, kind: state.kind, offset: state.offset }))

  // Loaded lazily: the core imports Node builtins and reads files at import time.
  const core = await import('@emulators/core')

  const api = await makeStatefulEmulator<DropboxEmulatorState, DropboxApiEnv, DropboxEmulatorSeed>(
    {
      routes: dropboxApiRoutes,
      env,
      initial,
      buildSeed: buildSeedState,
      recordHeaders: [{ name: 'dropbox-api-arg', json: true }],
      // Cursor numbers keep advancing, so a cursor issued before a reset is never issued again.
      clearRuntime: () => env.cursors.clear(),
      runtimeState: () => ({ cursors: cursors() }),
      seedSummary: state => ({ entries: state.entries.length }),
      inputInvalid
    },
    async dispatch => {
      const definition = core.defineEmulator<DropboxEmulatorState>({
        name: 'dropbox',
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
          const current: EmulatorSnapshot<DropboxEmulatorState> = runtime.snapshot()

          return runtime.restore({ ...current, state })
        },
        close: () => runtime.close()
      }
    }
  )

  return { ...api, cursors }
}
