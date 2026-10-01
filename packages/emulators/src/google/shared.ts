/**
 * Shared pieces of the Google emulator API (internal): origins, the environment, drill knobs,
 * response and error-envelope helpers, query checks, run-scoped text, and page tokens.
 *
 * @experimental
 */
import type * as Schema from 'effect/Schema'
import {
  integerIn,
  isNotEmulated,
  notEmulated,
  type Commit,
  type EmulatedRequest,
  type NotEmulated,
  type StatefulRoute
} from '../stateful-emulator.ts'
import type { GoogleEmulatorState } from './state.ts'

/** The origin of every Gmail route (the API and the upload endpoint), as the fixtures record. */
export const googleEmulatorGmailOrigin = 'https://gmail.googleapis.com'

/** The origin of every Calendar and Drive route, as the fixtures record. */
export const googleEmulatorApisOrigin = 'https://www.googleapis.com'

/** Drill knobs (tests only): each makes the emulator disagree with exactly one conformance case. */
export type GoogleEmulatorDrills = {
  /** A later `gmail.list` page starts one message early, repeating the previous page's last. */
  readonly gmailPageRepeats?: boolean
  /** Attachment `data` is answered in the standard base64 alphabet instead of base64url. */
  readonly attachmentStandardBase64?: boolean
  /** Gmail 404 envelopes carry no `error.message`. */
  readonly notFoundWithoutMessage?: boolean
  /** Deleting a label leaves it on the messages that carry it. */
  readonly labelDeleteKeepsOnMessages?: boolean
  /** A draft update keeps the earlier subject and body (it ignores the new message). */
  readonly draftUpdateKeepsContent?: boolean
  /** The trash answer omits `TRASH` from `labelIds` (the state still carries it). */
  readonly trashAnswerOmitsTrash?: boolean
  /** The sent message reads back without its `To` header. */
  readonly sentMessageWithoutTo?: boolean
  /** A later `calendar.list_events` page starts one event early. */
  readonly calendarPageRepeats?: boolean
  /** An event PATCH answers (and keeps) the earlier summary. */
  readonly eventPatchKeepsSummary?: boolean
  /** Deleting a cancelled event answers 409 instead of the recorded 410. */
  readonly repeatedEventDeleteConflict?: boolean
  /** A later `drive.list_files` page starts one file early. */
  readonly drivePageRepeats?: boolean
  /** `drive.get_file` answers no `parents`. */
  readonly getFileWithoutParents?: boolean
  /** Folder listings include trashed children. */
  readonly listIncludesTrashed?: boolean
}

export const googleEmulatorDrillKnobs: ReadonlyArray<keyof GoogleEmulatorDrills> = [
  'gmailPageRepeats',
  'attachmentStandardBase64',
  'notFoundWithoutMessage',
  'labelDeleteKeepsOnMessages',
  'draftUpdateKeepsContent',
  'trashAnswerOmitsTrash',
  'sentMessageWithoutTo',
  'calendarPageRepeats',
  'eventPatchKeepsSummary',
  'repeatedEventDeleteConflict',
  'drivePageRepeats',
  'getFileWithoutParents',
  'listIncludesTrashed'
]

/** A page token this emulator issued: where its list continues, and the list it was issued for. */
export type GoogleIssuedPageToken = {
  /** The list it continues (its key names the list and its page size). */
  readonly listKey: string
  readonly offset: number
  /** The whole list as rendered when the token was issued; any change is not emulated. */
  readonly fingerprint: string
}

export type GoogleApiEnv = {
  /** Clock in epoch milliseconds (created and updated timestamps, the sent `Date` header). */
  readonly now: () => number
  readonly drills: Readonly<Record<keyof GoogleEmulatorDrills, boolean>>
  /**
   * Issued page tokens by value (runtime-only; cleared by reset and seed). A value is bound to
   * exactly one list, position, and rendering, and never rebound.
   */
  readonly pageTokens: Map<string, GoogleIssuedPageToken>
  /**
   * The token generation: advanced by every reset and seed (never rewound). A page token is the
   * fixture's value (`synthetic-<api>-page-<n>`) only in the generation that first issued that
   * value; a later generation issues `<value>.g<generation>`, so no token value ever crosses a
   * reset or seed.
   */
  readonly generation: { current: number }
  /** The generation that first issued each token value (never cleared). */
  readonly firstIssued: Map<string, number>
}

export type GoogleRoute = StatefulRoute<GoogleEmulatorState, GoogleApiEnv>

/** Route evidence of an unverified connector route on `origin`, citing `caseIds`. */
export const evidence = (
  origin: string,
  method: string,
  path: string,
  write: boolean,
  caseIds: ReadonlyArray<string>,
  params: Readonly<Record<string, RegExp>> = {}
) => ({
  method,
  path,
  kind: 'connector' as const,
  write,
  caseIds,
  evidence: 'unverified' as const,
  origin,
  params
})

/** A path parameter, decoded once by the wrapper (empty when absent). */
export const param = (request: EmulatedRequest, name: string): string => request.params[name] ?? ''

/** The `internalDate` every recorded Gmail message carries. */
export const recordedInternalDate = '1790000000000'

/** The raw path segment of a Gmail message, thread, label, attachment, or draft id. */
export const gmailIdSegment = /^[A-Za-z0-9_-]{1,100}$/

// Responses, as the fixtures record them.

const googleContentType = 'application/json; charset=UTF-8'

export const googleJson = (status: number, body: Schema.Json): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': googleContentType } })

/** The bodiless 204 every recorded delete answers. */
export const googleNoContent = (): Response => new Response(null, { status: 204 })

/** The Google JSON error envelope, as the fixtures write it. */
export const googleErrorBody = (
  code: number,
  message: string,
  reason: string,
  status: string
): Schema.JsonObject => ({
  error: { code, message, errors: [{ message, domain: 'global', reason }], status }
})

/** A read-only commit. */
export const answer =
  (response: () => Response): Commit =>
  () =>
    response()

// Queries.

/** A query value that must equal the recorded one. */
export const recordedValue = (
  query: Readonly<Record<string, string>>,
  key: string,
  value: string
): NotEmulated | undefined =>
  query[key] === value ? undefined : notEmulated(`${key} other than ${value} is not emulated`)

/** A decimal page size from `minimum` to `maximum`, or not emulated. */
export const pageSize = (
  raw: string | undefined,
  label: string,
  minimum: number,
  maximum: number
): number | NotEmulated =>
  integerIn(
    raw !== undefined && /^[1-9]\d{0,5}$/.test(raw) ? Number(raw) : null,
    label,
    minimum,
    maximum
  )

/** A request without query parameters, or not emulated. */
export const withoutQuery = (request: EmulatedRequest): NotEmulated | undefined =>
  request.query.size > 0
    ? notEmulated('query parameters are not emulated on this route')
    : undefined

// Run-scoped text.

/** The run id shape of the cases (`GoogleConformanceRunId`): at most 40 characters. */
const runIdPattern = /^run-[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * The well-formed run id of `yolk-conformance <runId> <kind>` (or `... <kind>: <rest>`), or
 * `undefined` when `text` has another form.
 */
export const runIdOf = (text: string, kind: string, rest?: string): string | undefined => {
  const prefix = 'yolk-conformance '
  const suffix = rest === undefined ? ` ${kind}` : ` ${kind}: ${rest}`

  if (!text.startsWith(prefix) || !text.endsWith(suffix)) return undefined

  const runId = text.slice(prefix.length, text.length - suffix.length)

  return runId.length <= 40 && runIdPattern.test(runId) ? runId : undefined
}

/**
 * True when `text` is `yolk-conformance <runId> <kind>` (or `... <kind>: <rest>`) for a
 * well-formed run id: the only latitude in the run-scoped names, subjects, and summaries.
 */
export const isRunText = (text: string, kind: string, rest?: string): boolean =>
  runIdOf(text, kind, rest) !== undefined

/**
 * The length of the fixtures' run id (`run-synthetic`). The draft and sent messages the Gmail
 * fixtures record carry a `sizeEstimate` that covers their subject, so a draft or send subject
 * must carry a run id of exactly this length for that recorded value to stay true.
 */
export const recordedRunIdLength = 13

// Page tokens: the fixture's value on first issuance, validated by issuance only.

/** `value` in this generation (see `GoogleApiEnv.generation`); records its first issuance. */
const generationValue = (env: GoogleApiEnv, value: string): string => {
  const first = env.firstIssued.get(value)
  const generation = env.generation.current

  if (first === undefined) env.firstIssued.set(value, generation)

  return first === undefined || first === generation ? value : `${value}.g${generation}`
}

/**
 * The page token for page `page` of a list (in a commit), bound to `issued` (its list, offset, and
 * fingerprint). The first issuance is the fixture's value (`synthetic-<api>-page-<n>`). Token
 * values are globally unique: a value already bound is reused only for exactly the same list,
 * position, and rendering, and never rebound to anything else, so another list or page size, or a
 * changed list, gets a distinct value (`synthetic-<api>-page-<n>.v<k>`) and an earlier token keeps
 * meaning only what it was issued for.
 */
const issueToken = (
  env: GoogleApiEnv,
  prefix: string,
  page: number,
  issued: GoogleIssuedPageToken
): string => {
  const base = `synthetic-${prefix}-page-${page}`

  for (let variant = 1; ; variant += 1) {
    const value = generationValue(env, variant === 1 ? base : `${base}.v${variant}`)
    const existing = env.pageTokens.get(value)

    if (existing === undefined) {
      env.pageTokens.set(value, issued)

      return value
    }

    if (
      existing.listKey === issued.listKey &&
      existing.fingerprint === issued.fingerprint &&
      existing.offset === issued.offset
    ) {
      return value
    }
  }
}

/** Where a page of a list starts: 0, or an issued token's offset; not emulated otherwise. */
const pageStart = (
  env: GoogleApiEnv,
  listKey: string,
  fingerprint: string,
  token: string | undefined
): number | NotEmulated => {
  if (token === undefined) return 0

  const issued = env.pageTokens.get(token)

  if (issued === undefined || issued.listKey !== listKey) {
    return notEmulated(
      'a pageToken this emulator did not issue for this list since the last reset is not emulated'
    )
  }

  return issued.fingerprint === fingerprint
    ? issued.offset
    : notEmulated('continuing a list that changed since its pageToken was issued is not emulated')
}

/**
 * The commit answering one page of a list: `render(page, nextPageToken)` for the page's rendered
 * items, with a next token (registered for this list) while items remain. `repeats` (a drill)
 * starts a later page one item early.
 */
export const listPage = (
  env: GoogleApiEnv,
  prefix: string,
  listKey: string,
  all: ReadonlyArray<Schema.Json>,
  size: number,
  token: string | undefined,
  repeats: boolean,
  render: (page: ReadonlyArray<Schema.Json>, nextPageToken: string | undefined) => Response
): Commit | NotEmulated => {
  const fingerprint = JSON.stringify(all)
  const offset = pageStart(env, listKey, fingerprint, token)

  if (isNotEmulated(offset)) return offset

  const start = repeats && offset > 0 ? offset - 1 : offset
  const end = start + size

  return () => {
    const next =
      end < all.length
        ? issueToken(env, prefix, Math.floor(end / size) + 1, { listKey, offset: end, fingerprint })
        : undefined

    return render(all.slice(start, end), next)
  }
}
