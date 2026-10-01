/**
 * Stateful Todoist emulator (API v1 under `https://api.todoist.com/api/v1`), built on the upstream
 * `@emulators/core` custom runtime, with a request ledger, status faults, and an `/_emulate/*`
 * control plane.
 *
 * Fixture-only: it never imports SDK code; its wire shapes and default seed are copied as data
 * from the synthetic Todoist conformance fixtures, and every route names the conformance cases it
 * follows in `todoistEmulatorRoutes`. Only the routes the seven Todoist cases (with their cleanup)
 * need are emulated; anything the fixtures do not record answers one ledgered 400
 * `{ error: { type: 'not_emulated', message } }`. That includes the project listing of the
 * read-only leftover lookup (`findTodoistConformanceLeftovers`), which no fixture records: the
 * lookup fails (`todoist_list_projects_failed`, HTTP 400), and runners print their lookup-failed
 * WARN instead of leftover warnings.
 *
 * Fail closed: a request on no emulated route (or with a raw id segment that is not a Todoist id)
 * is ledgered and answered with constant text only (`/<unrecognised>`, a standard method or
 * `<other>`, no query or body, a constant reason). So is a request whose `Authorization` header is
 * present but is not one recognisable bearer, whatever its route: its credential cannot be
 * extracted and scrubbed.
 *
 * No answer is synthesised: a seeded project (whose object no fixture records) answers
 * not-emulated on a read; only items created through the recorded create flow are updated,
 * closed, or deleted; a case project takes one task and a seeded parent one sub-project (the
 * fixtures record `child_order: 1` only). Minted ids use the reserved prefix `6XEmu`, which seeds
 * may not use. The bearer value is guarded like the Telegram token: scrubbed from everything
 * ledgered or answered, and a path, query, or body that repeats it is refused.
 *
 * Request-shape latitude (the only accepted deviations from the fixture requests): any credential
 * value of at least 8 characters that occurs nowhere else in the request (its path, query, or body;
 * never checked against anything, stored, or ledgered); extra request headers; `content-type`
 * parameters; query parameters in any order; any Todoist id (1-64 of `[A-Za-z0-9_-]`) of an
 * existing item where a fixture has an id (reads: seeded or created tasks and created projects;
 * task listings: the paging project with `limit=2` and case projects created here without `limit`;
 * writes: only items created through the recorded create flow; a new project's `parent_id`: a
 * seeded project); any `run-` run id (at most 40 characters) in a case project name; any non-empty
 * task `content`; a task update sending `content`, `due_datetime`, or both; a label listing `limit`
 * of 1 to 200 that covers every label.
 *
 * Node-only: `@emulators/core` imports Node builtins, so the core is loaded lazily by
 * `makeTodoistEmulator` (importing this module has no side effects).
 *
 * @experimental
 */
import { Data, Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import type { EmulatorRouteEvidence } from './route-evidence.ts'
import {
  makeStatefulFixtureEmulator,
  type StatefulFixtureCoverage,
  type StatefulFixtureFault,
  type StatefulFixtureFaultState,
  type StatefulFixtureLedgerEntry,
  type StatefulFixtureResolution
} from './stateful-fixture.ts'
import {
  matchTodoistRoute,
  registerTodoistApi,
  todoistApiRoutes,
  todoistQueryProblem,
  type TodoistApiEnv,
  type TodoistCursor,
  type TodoistEmulatorDrills
} from './todoist/api.ts'
import {
  buildTodoistSeedState,
  decodeTodoistState,
  type TodoistEmulatorSeed,
  type TodoistEmulatorState
} from './todoist/state.ts'

export type { EmulatorEvidence, EmulatorRouteEvidence } from './route-evidence.ts'

export { emulatorEvidenceHeader } from './route-evidence.ts'

export {
  StatefulFixtureFault as TodoistFault,
  StatefulFixtureFaultMatch as TodoistFaultMatch
} from './stateful-fixture.ts'

export { todoistEmulatorBasePath, type TodoistEmulatorDrills } from './todoist/api.ts'

export {
  TodoistEmulatorDue,
  TodoistEmulatorLabel,
  TodoistEmulatorProfile,
  TodoistEmulatorProject,
  TodoistEmulatorProjectSeed,
  TodoistEmulatorSeed,
  TodoistEmulatorStateSchema,
  TodoistEmulatorTask,
  TodoistEmulatorTaskSeed,
  type TodoistEmulatorState
} from './todoist/state.ts'

/** Origin the connector calls. */
export const todoistEmulatorDefaultOrigin = 'https://api.todoist.com'

/**
 * Route evidence manifest: every emulated route, whether it writes, and the conformance cases
 * whose (currently synthetic, unverified) wire claims it follows. Kept in sync with the handlers
 * by construction (both come from one route table). Every route cites at least one case.
 */
export const todoistEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> = todoistApiRoutes.map(
  ({ handler: _handler, queryKeys: _queryKeys, ...evidence }) => evidence
)

export type TodoistFaultState = StatefulFixtureFaultState

export type TodoistLedgerEntry = StatefulFixtureLedgerEntry

export type TodoistCoverage = StatefulFixtureCoverage

/** Invalid emulator input from the JS API: a seed or a fault. A programmer error. */
export class TodoistEmulatorInputInvalid extends Data.TaggedError('TodoistEmulatorInputInvalid')<{
  readonly input: 'seed' | 'fault'
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid Todoist emulator ${this.input}: ${this.reason}`
  }
}

export type TodoistEmulatorOptions = {
  /** Typed seed; defaults to the fixture entities (`profile: 'default'`). */
  readonly seed?: TodoistEmulatorSeed
  /** Clock in epoch milliseconds (created and closed timestamps). Defaults to `Date.now`. */
  readonly now?: () => number
  /** Drill knobs (tests only): make the emulator disagree with one conformance claim. */
  readonly drills?: TodoistEmulatorDrills
}

export type TodoistEmulator = {
  /** The fetch handler (Todoist routes and `/_emulate/*`). Never rejects. */
  readonly fetch: (request: Request) => Promise<Response>
  readonly ledger: {
    readonly entries: () => ReadonlyArray<TodoistLedgerEntry>
    readonly clear: () => void
  }
  readonly faults: {
    /** Add a fault; throws `TodoistEmulatorInputInvalid` for an invalid fault. */
    readonly add: (fault: StatefulFixtureFault) => TodoistFaultState
    readonly list: () => ReadonlyArray<TodoistFaultState>
    readonly clear: () => void
  }
  /** Task-listing cursors answered since the last reset or seed (runtime data). */
  readonly cursors: () => ReadonlyArray<TodoistCursor>
  /** Restore the current seed and clear the ledger, faults, and cursors. */
  readonly reset: () => Promise<void>
  /**
   * Replace the state with a new seed, which becomes what `reset` restores (cursors are cleared).
   * Rejects with `TodoistEmulatorInputInvalid` for an invalid seed.
   */
  readonly seed: (seed: TodoistEmulatorSeed) => Promise<void>
  /** A deep copy of the current state (entities and counters). */
  readonly snapshot: () => TodoistEmulatorState
  readonly coverage: () => TodoistCoverage
  /** Close the core runtime. Later requests answer 503. Idempotent. */
  readonly close: () => Promise<void>
}

// A bearer credential of at least 8 characters. The value is never checked against anything,
// stored, forwarded, or ledgered; it is guarded like the Telegram token: a path, query, or body
// that repeats it is refused, and it is scrubbed from everything ledgered or answered.
const bearerPattern = /^bearer\s+(\S{8,})\s*$/i

const resolve = (request: Request, url: URL): StatefulFixtureResolution => {
  const ledgerPath = url.pathname
  const authorization = request.headers.get('authorization')
  const bearer = bearerPattern.exec(authorization ?? '')?.[1]

  // Fail closed: an Authorization header that is present but not one recognisable bearer (extra
  // words, duplicated headers) means the credential cannot be extracted and scrubbed, so the
  // request is ledgered and answered with constant text only, whatever the route.
  if (authorization !== null && bearer === undefined) {
    return {
      kind: 'unrecognised',
      reason: 'an unrecognisable Authorization header is not emulated'
    }
  }

  // On a recognised route the bearer value is guarded (scrubbed and never repeated).
  const secrets = bearer === undefined ? [] : [bearer]
  const matched = matchTodoistRoute(request.method, url.pathname)

  // Fail closed: a request on no emulated route is ledgered and answered with constant text only.
  if (matched === undefined) {
    return { kind: 'unrecognised', reason: 'no emulated Todoist route for this method and path' }
  }

  const refuse = (reason: string): StatefulFixtureResolution => ({
    kind: 'not-emulated',
    ledgerPath,
    reason,
    route: matched.route,
    secrets
  })

  if (bearer === undefined) {
    return refuse(
      'requests without Authorization: Bearer <token of at least 8 characters> are not emulated'
    )
  }

  const problem = todoistQueryProblem(matched.route, url.searchParams)

  if (problem !== undefined) return refuse(problem)

  return {
    kind: 'route',
    ledgerPath,
    route: matched.route,
    corePath: `${url.pathname}${url.search}`,
    coreHeaders: {},
    secrets
  }
}

/**
 * Create a stateful Todoist emulator on the `@emulators/core` custom runtime. Each call has its
 * own state, ledger, faults, and cursors. Rejects with `TodoistEmulatorInputInvalid` for an
 * invalid seed.
 *
 * Routes (under `/api/v1`, `Authorization: Bearer <token of at least 8 characters>`): task
 * listing with cursor paging, task read, create, update, and close, label listing, and project
 * create, read, and delete.
 * See `README.md` (Todoist emulator) for the wire claims.
 */
export const makeTodoistEmulator = async (
  options: TodoistEmulatorOptions = {}
): Promise<TodoistEmulator> => {
  const initial = buildTodoistSeedState(options.seed ?? {})

  if (Predicate.isString(initial)) {
    throw new TodoistEmulatorInputInvalid({ input: 'seed', reason: initial })
  }

  const drills = options.drills ?? {}

  const env: TodoistApiEnv = {
    now: options.now ?? (() => Date.now()),
    drills: {
      cursorRestarts: drills.cursorRestarts ?? false,
      notFoundWithoutError: drills.notFoundWithoutError ?? false,
      taskLabelsAsIds: drills.taskLabelsAsIds ?? false,
      listIncludesClosed: drills.listIncludesClosed ?? false,
      ignoreDue: drills.ignoreDue ?? false,
      createOmitsParent: drills.createOmitsParent ?? false,
      deleteKeepsTasks: drills.deleteKeepsTasks ?? false
    },
    cursors: new Map(),
    cursorCounter: { next: 1 }
  }

  // Loaded lazily: the core imports Node builtins and reads files at import time.
  const core = await import('@emulators/core')

  const definition = core.defineEmulator<TodoistEmulatorState>({
    name: 'todoist',
    cors: false,
    state: () => initial,
    validateSeed: value => {
      const decoded = decodeTodoistState(value)

      if (Predicate.isString(decoded)) {
        throw new TodoistEmulatorInputInvalid({ input: 'seed', reason: decoded })
      }

      return decoded
    },
    setup: ({ app, state }) => registerTodoistApi(app, state, env)
  })

  const runtime = await core.createCustomRuntime(definition, { seed: initial })

  const cursorList = (): ReadonlyArray<TodoistCursor> => [...env.cursors.values()]

  const emulator = makeStatefulFixtureEmulator<TodoistEmulatorState, TodoistEmulatorSeed>({
    routes: todoistEmulatorRoutes,
    initial,
    runtime: {
      baseUrl: runtime.baseUrl,
      fetch: request => runtime.fetch(request),
      snapshot: () => runtime.snapshot().state,
      restore: state => runtime.restore({ ...runtime.snapshot(), state }),
      close: () => runtime.close()
    },
    resolve,
    buildSeed: buildTodoistSeedState,
    clearRuntime: () => {
      env.cursors.clear()
      env.cursorCounter.next = 1
    },
    runtimeState: (): Schema.Json => ({ cursors: cursorList().map(cursor => ({ ...cursor })) }),
    seedSummary: state => ({
      projects: state.projects.length,
      tasks: state.tasks.length,
      labels: state.labels.length
    })
  })

  return {
    fetch: emulator.fetch,
    ledger: emulator.ledger,
    faults: {
      add: fault => {
        const added = emulator.faults.add(fault)

        if (Predicate.isString(added)) {
          throw new TodoistEmulatorInputInvalid({ input: 'fault', reason: added })
        }

        return added
      },
      list: emulator.faults.list,
      clear: emulator.faults.clear
    },
    cursors: cursorList,
    reset: emulator.reset,
    seed: async input => {
      const problem = await emulator.seed(input)

      if (problem !== undefined) {
        throw new TodoistEmulatorInputInvalid({ input: 'seed', reason: problem })
      }
    },
    snapshot: emulator.snapshot,
    coverage: emulator.coverage,
    close: emulator.close
  }
}
