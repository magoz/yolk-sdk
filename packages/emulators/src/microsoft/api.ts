/**
 * Microsoft Graph emulator API: the route table (with its evidence and query allowlist), route
 * matching, and the registration of the stateful handlers on the `@emulators/core` app
 * (internal; re-exported by `src/microsoft.ts`).
 *
 * Only the routes the eleven Microsoft conformance cases need are emulated, plus the copy monitor
 * URL they require; everything else fails closed. Each route lists the cases whose claims it
 * follows.
 *
 * @experimental
 */
import type { Hono } from '@emulators/core'
import { handlerFailedResponse } from '../emulator-http.ts'
import type { EmulatorRouteEvidence } from '../route-evidence.ts'
import {
  calendarView,
  cancelEvent,
  createEvent,
  deleteEvent,
  getEvent,
  updateEvent
} from './calendar.ts'
import { copyItem, copyMonitor, createFolder, deleteItem, getItem, listChildren } from './drive.ts'
import {
  codes,
  decodeSegment,
  errorContext,
  graphError,
  microsoftEmulatorBasePath,
  parseJsonText,
  parsePreferences,
  type MicrosoftApiEnv,
  type RouteHandler,
  type RouteRequest
} from './graph.ts'
import {
  batch,
  createDraft,
  getAttachment,
  listAttachments,
  listFolderMessages,
  moveMessage,
  updateMessage
} from './mail.ts'
import type { MicrosoftEmulatorState } from './state.ts'

export { microsoftEmulatorBasePath } from './graph.ts'

type MicrosoftApiRoute = EmulatorRouteEvidence & {
  /**
   * Query parameters the route emulates; any other key answers 400 before the handler runs, so
   * a rejected request never writes. Empty by default.
   */
  readonly queryKeys: ReadonlyArray<string>
  /** `false` only for the copy monitor, a pre-authenticated capability URL. */
  readonly auth: boolean
  readonly handler: RouteHandler
}

const listRangeCase = 'microsoft.calendar.list-range-returns-events'

const precisionCase = 'microsoft.calendar.timestamp-precision'

const createEventCase = 'microsoft.calendar.create-returns-event-id'

const cancelCase = 'microsoft.calendar.cancel-semantics'

const attachmentsCase = 'microsoft.outlook.attachments-listing'

const contentIdCase = 'microsoft.outlook.attachment-content-id'

const pagingCase = 'microsoft.outlook.paging-next-link'

const immutableIdCase = 'microsoft.outlook.immutable-id-survives-move'

const concurrentCase = 'microsoft.outlook.concurrent-writes-same-message'

const folderCase = 'microsoft.onedrive.create-folder-roundtrip'

const copyCase = 'microsoft.onedrive.copy-accepted-monitor'

const route = (
  method: string,
  path: string,
  write: boolean,
  caseIds: ReadonlyArray<string>,
  handler: RouteHandler,
  queryKeys: ReadonlyArray<string> = [],
  auth = true
): MicrosoftApiRoute => ({
  method,
  path,
  kind: 'connector',
  write,
  caseIds,
  evidence: 'unverified',
  queryKeys,
  auth,
  handler
})

const graph = (path: string) => `${microsoftEmulatorBasePath}${path}`

/** Folder message listing: the paging fixture's `$select`, `$top`, and `$skip`. */
const paging: ReadonlyArray<string> = ['$select', '$top', '$skip']

/** Calendar views and children listings: their fixtures send `$select` and `$top`, never `$skip`. */
const onePage: ReadonlyArray<string> = ['$select', '$top']

/** The route table: evidence plus handler. `microsoftEmulatorRoutes` is its evidence part. */
export const microsoftApiRoutes: ReadonlyArray<MicrosoftApiRoute> = [
  route(
    'GET',
    graph('/users/{userId}/calendars/{calendarId}/calendarView'),
    false,
    [listRangeCase, precisionCase],
    calendarView,
    ['startDateTime', 'endDateTime', ...onePage]
  ),
  route(
    'POST',
    graph('/users/{userId}/calendars/{calendarId}/events'),
    true,
    [createEventCase, cancelCase],
    createEvent
  ),
  route(
    'GET',
    graph('/users/{userId}/events/{eventId}'),
    false,
    [precisionCase, createEventCase, cancelCase],
    getEvent,
    ['$select']
  ),
  route('PATCH', graph('/users/{userId}/events/{eventId}'), true, [createEventCase], updateEvent),
  route(
    'DELETE',
    graph('/users/{userId}/events/{eventId}'),
    true,
    [createEventCase, cancelCase],
    deleteEvent
  ),
  route('POST', graph('/users/{userId}/events/{eventId}/cancel'), true, [cancelCase], cancelEvent),
  route(
    'GET',
    graph('/users/{userId}/mailFolders/{folderId}/messages'),
    false,
    [pagingCase],
    listFolderMessages,
    paging
  ),
  route(
    'POST',
    graph('/users/{userId}/messages'),
    true,
    [immutableIdCase, concurrentCase],
    createDraft
  ),
  route(
    'PATCH',
    graph('/users/{userId}/messages/{messageId}'),
    true,
    [immutableIdCase, concurrentCase],
    updateMessage
  ),
  route(
    'POST',
    graph('/users/{userId}/messages/{messageId}/move'),
    true,
    [immutableIdCase],
    moveMessage
  ),
  route(
    'GET',
    graph('/users/{userId}/messages/{messageId}/attachments'),
    false,
    [attachmentsCase, contentIdCase],
    listAttachments,
    ['$select']
  ),
  route(
    'GET',
    graph('/users/{userId}/messages/{messageId}/attachments/{attachmentId}'),
    false,
    [attachmentsCase, contentIdCase],
    getAttachment
  ),
  route('POST', graph('/$batch'), true, [immutableIdCase, concurrentCase], batch),
  route('GET', graph('/drives/{driveId}/items/{itemId}'), false, [folderCase, copyCase], getItem, [
    '$select'
  ]),
  route(
    'GET',
    graph('/drives/{driveId}/items/{itemId}/children'),
    false,
    [folderCase, copyCase],
    listChildren,
    onePage
  ),
  route(
    'POST',
    graph('/drives/{driveId}/items/{itemId}/children'),
    true,
    [folderCase, copyCase],
    createFolder
  ),
  route(
    'DELETE',
    graph('/drives/{driveId}/items/{itemId}'),
    true,
    [folderCase, copyCase],
    deleteItem
  ),
  route('POST', graph('/drives/{driveId}/items/{itemId}/copy'), true, [copyCase], copyItem, [
    '@microsoft.graph.conflictBehavior'
  ]),
  route(
    'GET',
    '/personal/{site}/_api/v2.0/monitor/{monitorId}',
    false,
    [copyCase],
    copyMonitor,
    [],
    false
  )
]

const templatePattern = (template: string): RegExp =>
  new RegExp(
    `^${template
      .split(/(\{[A-Za-z]+\})/)
      .map(part =>
        /^\{[A-Za-z]+\}$/.test(part) ? '([^/]+)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      )
      .join('')}$`
  )

const templateNames = (template: string): ReadonlyArray<string> =>
  [...template.matchAll(/\{([A-Za-z]+)\}/g)].map(match => match[1] ?? '')

const compiledRoutes = microsoftApiRoutes.map(candidate => ({
  route: candidate,
  pattern: templatePattern(candidate.path),
  names: templateNames(candidate.path)
}))

export type MatchedRoute = {
  readonly route: MicrosoftApiRoute
  /** Decoded path parameters. */
  readonly params: Readonly<Record<string, string>>
}

/**
 * The route answering `method` + raw (percent-encoded) `path` with its decoded parameters, or
 * `undefined` (fail closed; also for a parameter that is not valid percent-encoding).
 */
export const matchMicrosoftRoute = (method: string, path: string): MatchedRoute | undefined => {
  for (const candidate of compiledRoutes) {
    if (candidate.route.method !== method.toUpperCase()) continue

    const match = candidate.pattern.exec(path)

    if (match === null) continue

    const params: Record<string, string> = {}

    for (const [index, name] of candidate.names.entries()) {
      const value = decodeSegment(match[index + 1] ?? '')

      if (value === undefined) return undefined

      params[name] = value
    }

    return { route: candidate.route, params }
  }

  return undefined
}

/** Header the wrapper sets on core requests: the ledger sequence number (for error ids). */
export const requestSeqHeader = 'x-emulator-request-seq'

/** Header the wrapper sets on core requests: the job whose fault decision the route asks for. */
export const microsoftJobHeader = 'x-emulator-job-id'

/**
 * The wrapper's fault decision for the core request of job `jobId`, asked only once the route
 * would answer successfully: `true` when a fault answers instead (it is used up, and the wrapper
 * sends its answer), `false` when none applies.
 */
export type MicrosoftFaultDecision = (jobId: string | null) => boolean

/**
 * The core's answer when a fault answered: the wrapper sends the fault's answer itself, outside
 * the core, so a reset or a close before it is read never cancels it.
 */
const answeredOutsideCore = (): Response => new Response(null, { status: 204 })

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms)
  })

/** The first query key the route does not emulate, or `undefined`. */
const unsupportedQueryKey = (
  query: URLSearchParams,
  allowed: ReadonlyArray<string>
): string | undefined => [...query.keys()].find(candidate => !allowed.includes(candidate))

/** `{Name}` path templates become `:Name` core route parameters. */
const corePath = (template: string): string => template.replace(/\{([A-Za-z]+)\}/g, ':$1')

/**
 * One core request: re-match, check the query allowlist and `If-Match`, then plan, fault, and
 * commit. The handler runs on drafts: a shallow copy of the state (handlers replace whole lists
 * and counters, never edit them in place) and copies of the copy monitors and their counter. A
 * refusal (any answer that is not 2xx) is sent as is and uses up no fault; a successful answer asks
 * `decideFault`, and only an unfaulted one commits the drafts (and then holds a written message
 * for `conflictWindowMs`). Plan, fault decision, and commit run synchronously together, so no
 * other request interleaves.
 */
const handle = async (
  raw: Request,
  state: MicrosoftEmulatorState,
  env: MicrosoftApiEnv,
  decideFault: MicrosoftFaultDecision
): Promise<Response> => {
  const url = new URL(raw.url)
  const headers = raw.headers
  const seq = Number(headers.get(requestSeqHeader) ?? '0')

  // Built on demand, so the clock is read only when an error is answered.
  const error = (status: number, code: string, message: string) =>
    graphError(
      errorContext(
        env.now(),
        Number.isSafeInteger(seq) ? seq : 0,
        headers.get('client-request-id')
      ),
      status,
      code,
      message
    )

  const matched = matchMicrosoftRoute(raw.method, url.pathname)

  if (matched === undefined) {
    return error(404, codes.unknownRoute, 'Synthetic: no emulated Microsoft Graph route.')
  }

  const unsupported = unsupportedQueryKey(url.searchParams, matched.route.queryKeys)

  if (unsupported !== undefined) {
    return error(
      400,
      codes.unsupportedQuery,
      `Synthetic: query parameter ${unsupported} is not emulated on this route.`
    )
  }

  if (headers.has('if-match')) {
    return error(
      400,
      codes.unsupportedValue,
      'Synthetic: conditional requests (If-Match) are not emulated.'
    )
  }

  const text = await raw.text()

  const request: RouteRequest = {
    params: matched.params,
    path: url.pathname,
    query: url.searchParams,
    body: text === '' ? undefined : parseJsonText(text),
    prefer: parsePreferences(headers.get('prefer')),
    error
  }

  const draft: MicrosoftEmulatorState = { ...state }
  const monitors = new Map([...env.monitors].map(([id, monitor]) => [id, { ...monitor }]))
  const monitorCounter = { next: env.monitorCounter.next }
  const answer = matched.route.handler(draft, request, { ...env, monitors, monitorCounter })
  const response = answer instanceof Response ? answer : answer.response

  if (!response.ok) return response

  if (decideFault(headers.get(microsoftJobHeader))) return answeredOutsideCore()

  Object.assign(state, draft)
  env.monitors.clear()

  for (const [id, monitor] of monitors) env.monitors.set(id, monitor)

  env.monitorCounter.next = monitorCounter.next

  if (answer instanceof Response) return answer

  env.messageLocks.add(answer.holds)

  try {
    if (env.conflictWindowMs > 0) await delay(env.conflictWindowMs)

    return answer.response
  } finally {
    env.messageLocks.delete(answer.holds)
  }
}

/**
 * Register every route of the table on the core app, over the generation's state. Each handler
 * re-matches the raw request path against the same table the wrapper ledgers (so parameters are
 * decoded once, failing closed on invalid percent-encoding), checks the route's query allowlist
 * and refuses `If-Match` (no fixture sends one) before the handler runs, then plans, faults, and
 * commits (see `handle`). A handler that throws answers `handlerFailedResponse()` (nothing
 * written), which the wrapper turns into its Graph error envelope 500 with `responseError` in the
 * ledger.
 */
export const registerMicrosoftApi = (
  app: Hono,
  state: MicrosoftEmulatorState,
  env: MicrosoftApiEnv,
  decideFault: MicrosoftFaultDecision
): void => {
  for (const apiRoute of microsoftApiRoutes) {
    app.on(apiRoute.method, corePath(apiRoute.path), async context => {
      try {
        return await handle(context.req.raw, state, env, decideFault)
      } catch {
        return handlerFailedResponse()
      }
    })
  }
}
