/**
 * Shared Microsoft Graph emulator wire helpers (internal): the error envelope and codes, JSON
 * responses, `@odata.context`, `$select` projection, `$top`/`$skip` paging with
 * `@odata.nextLink`, the `Prefer` header, strict nested body objects, and the route handler
 * contract.
 *
 * @experimental
 */
import { Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import type { MicrosoftEmulatorState, MicrosoftEmulatorUser } from './state.ts'

/**
 * Error codes the emulator answers with. `ErrorItemNotFound`, `itemNotFound`, and
 * `ErrorIrresolvableConflict` are copied from the fixtures; `InvalidAuthenticationToken` (missing
 * bearer), `ErrorInvalidUser` (a user other than the seeded mailbox), and `TooManyRequests` (the
 * default 429 fault body) are documented Graph codes no fixture records; the `Synthetic*` codes
 * are emulator codes for requests it refuses to emulate (fail closed) or cannot answer.
 */
export const microsoftEmulatorErrorCodes = {
  mailItemNotFound: 'ErrorItemNotFound',
  driveItemNotFound: 'itemNotFound',
  conflict: 'ErrorIrresolvableConflict',
  unauthenticated: 'InvalidAuthenticationToken',
  invalidUser: 'ErrorInvalidUser',
  rateLimited: 'TooManyRequests',
  unknownRoute: 'SyntheticRouteNotEmulated',
  unsupportedQuery: 'SyntheticQueryNotEmulated',
  unsupportedValue: 'SyntheticValueNotEmulated',
  invalidRequest: 'SyntheticInvalidRequest',
  invalidBody: 'SyntheticInvalidBody',
  upstreamError: 'SyntheticUpstreamError'
} as const

export const codes = microsoftEmulatorErrorCodes

/** Graph JSON content type, as the fixtures record it. */
export const graphContentType =
  'application/json; odata.metadata=minimal; odata.streaming=true; IEEE754Compatible=false; charset=utf-8'

export const jsonResponse = (
  status: number,
  body: unknown,
  headers: HeadersInit = {}
): Response => {
  const responseHeaders = new Headers(headers)

  if (!responseHeaders.has('content-type')) responseHeaders.set('content-type', graphContentType)

  return new Response(JSON.stringify(body), { status, headers: responseHeaders })
}

/** Graph API version prefix of every Graph route. */
export const microsoftEmulatorBasePath = '/v1.0'

/** A percent-decoded path segment, or `undefined` for invalid percent-encoding. */
export const decodeSegment = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

/**
 * An OData key segment as the fixtures write it in `@odata.context`: `('ada%40example.test')`,
 * `('b%21synthetic-drive-0001')` (percent-encoded, including `!'()*`).
 */
export const odataKey = (value: string): string =>
  `('${encodeURIComponent(value).replace(
    /[!'()*]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )}')`

/** `(a,b,c)` for a `$select`, empty without one, as the fixture contexts write it. */
export const selectSuffix = (fields: ReadonlyArray<string> | undefined): string =>
  fields === undefined ? '' : `(${fields.join(',')})`

/** The fixture `@odata.context` URL: `{graphOrigin}/v1.0/$metadata#{path}`. */
export const metadataContext = (env: MicrosoftApiEnv, path: string): string =>
  `${env.graphOrigin}${microsoftEmulatorBasePath}/$metadata#${path}`

/** An entity body with its `@odata.context` first, as the fixtures record it. */
export const entity = (context: string, body: Schema.JsonObject): Schema.JsonObject => ({
  '@odata.context': context,
  ...body
})

/** A bodiless success (204 delete, 202 cancel/copy), as the fixtures record them. */
export const emptyResponse = (status: number, headers: HeadersInit = {}): Response =>
  new Response(null, { status, headers })

/** Where a Graph error envelope's `innerError` values come from. */
export type ErrorContext = {
  /** `innerError.date` (`YYYY-MM-DDTHH:MM:SS`, UTC). */
  readonly date: string
  readonly requestId: string
  readonly clientRequestId: string
}

/** The Graph error envelope `{ error: { code, message, innerError } }`. */
export const graphError = (
  context: ErrorContext,
  status: number,
  code: string,
  message: string
): Response =>
  jsonResponse(status, {
    error: {
      code,
      message,
      innerError: {
        date: context.date,
        'request-id': context.requestId,
        'client-request-id': context.clientRequestId
      }
    }
  })

export const padded = (value: number, width: number): string => String(value).padStart(width, '0')

/** A synthetic request id for ledger sequence `seq`. */
export const syntheticRequestId = (seq: number): string =>
  `00000000-0000-4000-8000-${padded(seq % 1_000_000_000_000, 12)}`

const clientRequestIdPattern = /^[A-Za-z0-9-]{1,64}$/

/** The error context of one request; `client-request-id` is echoed only when it is plain. */
export const errorContext = (
  now: number,
  seq: number,
  clientRequestId: string | null
): ErrorContext => {
  const requestId = syntheticRequestId(seq)

  return {
    date: new Date(Math.floor(now / 1000) * 1000).toISOString().slice(0, 19),
    requestId,
    clientRequestId:
      clientRequestId !== null && clientRequestIdPattern.test(clientRequestId)
        ? clientRequestId
        : requestId
  }
}

/** The parsed `Prefer` preferences the emulator reads (others are ignored, as Graph does). */
export type Preferences = {
  /** `IdType="ImmutableId"`: answer message ids in immutable form. */
  readonly immutableId: boolean
  /** `outlook.timezone`, when sent. */
  readonly timezone: string | undefined
}

const unquote = (value: string): string =>
  value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value

/** Parse `Prefer`: comma-separated `name=value` preferences. */
export const parsePreferences = (header: string | null): Preferences => {
  let immutableId = false
  let timezone: string | undefined

  for (const part of (header ?? '').split(',')) {
    const separator = part.indexOf('=')
    const name = (separator === -1 ? part : part.slice(0, separator)).trim().toLowerCase()
    const value = separator === -1 ? '' : unquote(part.slice(separator + 1).trim())

    if (name === 'idtype' && value.toLowerCase() === 'immutableid') immutableId = true

    if (name === 'outlook.timezone') timezone = value
  }

  return { immutableId, timezone }
}

/** One routed API request, as the handlers see it. */
export type RouteRequest = {
  /** Decoded path parameters. */
  readonly params: Readonly<Record<string, string>>
  /** Raw (still percent-encoded) path, for example `/v1.0/users/ada%40example.test/...`. */
  readonly path: string
  readonly query: URLSearchParams
  /** Parsed JSON body; `undefined` when absent. */
  readonly body: Schema.Json | undefined
  readonly prefer: Preferences
  /** A Graph error envelope response for this request. */
  readonly error: (status: number, code: string, message: string) => Response
}

/** Drill knobs (tests only): each makes the emulator disagree with one conformance claim. */
export type MicrosoftEmulatorDrills = {
  /** `true`: `calendarView` answers an empty `value` for every range. */
  readonly calendarRangeEmpty?: boolean
  /** `true`: event create answers 201 without the new event's `id` (the event is still created). */
  readonly createOmitsId?: boolean
  /** Fractional digits of event `dateTime` values (Graph uses 7); `3` drills the precision case. */
  readonly timestampPrecisionDigits?: number
  /** `true`: collection pages never carry `@odata.nextLink`. */
  readonly omitNextLink?: boolean
}

/** A OneDrive copy the monitor reports on (runtime-only, like the ledger; not in the state). */
export type CopyMonitor = {
  readonly id: string
  readonly sourceId: string
  readonly destinationParentId: string
  readonly name: string | undefined
  /** In-progress answers left before the copy runs and completes. */
  pollsLeft: number
  /** Set once the copy ran and completed. */
  resourceId: string | undefined
}

export type MicrosoftApiEnv = {
  /** Clock in epoch milliseconds (timestamps of created items). */
  readonly now: () => number
  /** Origin of `@odata.nextLink` values, for example `https://graph.microsoft.com`. */
  readonly graphOrigin: string
  /** Origin of OneDrive `webUrl` values and copy monitor URLs. */
  readonly sharePointOrigin: string
  readonly drills: Required<MicrosoftEmulatorDrills>
  /** In-progress monitor answers before a copy completes (default 0: the first poll completes). */
  readonly copyInProgressPolls: number
  /** How long a message write holds its message; a concurrent write in that time loses (409). */
  readonly conflictWindowMs: number
  /** Immutable ids of messages with a write in flight (runtime-only). */
  readonly messageLocks: Set<string>
  /** Copy monitors by id (runtime-only; cleared by reset and seed). */
  readonly monitors: Map<string, CopyMonitor>
  readonly monitorCounter: { next: number }
}

export type RouteHandler = (
  state: MicrosoftEmulatorState,
  request: RouteRequest,
  env: MicrosoftApiEnv
) => Response | Promise<Response>

export const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  value !== undefined && value !== null && Predicate.isObject(value) && !Array.isArray(value)

const decodeJsonText = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))

/** Parsed JSON, or `undefined` for invalid JSON. */
export const parseJsonText = (text: string): Schema.Json | undefined => {
  const result = decodeJsonText(text)

  return Result.isSuccess(result) ? result.success : undefined
}

/** The user a `/users/{userId}` segment names (id, `mail`, or UPN, case-insensitive). */
export const resolveUser = (
  state: MicrosoftEmulatorState,
  request: RouteRequest
): MicrosoftEmulatorUser | Response => {
  const userId = (request.params.userId ?? '').toLowerCase()
  const user = state.user

  return [user.id, user.mail, user.userPrincipalName].some(
    candidate => candidate.toLowerCase() === userId
  )
    ? user
    : request.error(404, codes.invalidUser, 'Synthetic: the requested user is not emulated.')
}

/** The `$select` fields, `undefined` without `$select`, or a 400 for a field not emulated. */
export const selectedFields = (
  request: RouteRequest,
  allowed: ReadonlyArray<string>
): ReadonlyArray<string> | undefined | Response => {
  const raw = request.query.get('$select')

  if (raw === null) return undefined

  const fields = raw.split(',').map(field => field.trim())
  const unknown = fields.find(field => !allowed.includes(field))

  return unknown === undefined
    ? fields
    : request.error(
        400,
        codes.unsupportedQuery,
        `Synthetic: $select field '${unknown}' is not emulated on this resource.`
      )
}

/** Annotations and the id are always returned, whatever `$select` names. */
const alwaysReturned: ReadonlyArray<string> = [
  '@odata.etag',
  '@odata.type',
  '@odata.mediaContentType',
  'id'
]

/** Keep only the selected keys (plus annotations and `id`); everything without `$select`. */
export const project = (
  full: Schema.JsonObject,
  fields: ReadonlyArray<string> | undefined
): Schema.JsonObject =>
  fields === undefined
    ? full
    : Object.fromEntries(
        Object.entries(full).filter(([key]) => alwaysReturned.includes(key) || fields.includes(key))
      )

const integerQuery = (
  request: RouteRequest,
  key: string,
  minimum: number,
  maximum: number
): number | undefined | Response => {
  const raw = request.query.get(key)

  if (raw === null) return undefined

  const value = Number(raw)

  return /^\d+$/.test(raw) && value >= minimum && value <= maximum
    ? value
    : request.error(
        400,
        codes.invalidRequest,
        `Synthetic: ${key} must be an integer from ${minimum} to ${maximum}.`
      )
}

export type Page<A> = {
  readonly items: ReadonlyArray<A>
  readonly top: number
  /** `$skip` of the next page, when there is one. */
  readonly nextSkip: number | undefined
}

/** One `$top`/`$skip` page of `items`. */
export const pageOf = <A>(
  items: ReadonlyArray<A>,
  request: RouteRequest,
  limits: { readonly defaultTop: number; readonly maxTop: number }
): Page<A> | Response => {
  const top = integerQuery(request, '$top', 1, limits.maxTop)
  const skip = integerQuery(request, '$skip', 0, Number.MAX_SAFE_INTEGER)

  if (top instanceof Response) return top

  if (skip instanceof Response) return skip

  const size = top ?? limits.defaultTop
  const start = skip ?? 0
  const end = start + size

  return {
    items: items.slice(start, end),
    top: size,
    nextSkip: end < items.length ? end : undefined
  }
}

/**
 * The `@odata.nextLink` of a page: the configured Graph origin, the request's raw path (so
 * `/users/ada%40example.test` keeps its `%40`), the carried query keys, then `$top` and `$skip`,
 * encoded like the fixtures (`%24select=id%2Csubject...`). `undefined` on the last page or when
 * the `omitNextLink` drill knob is set. Clients follow it unchanged (opaque).
 */
export const nextLinkOf = (
  env: MicrosoftApiEnv,
  request: RouteRequest,
  page: Page<unknown>,
  carried: ReadonlyArray<string>
): string | undefined => {
  if (page.nextSkip === undefined || env.drills.omitNextLink) return undefined

  const params = new URLSearchParams()

  for (const key of carried) {
    const value = request.query.get(key)

    if (value !== null) params.set(key, value)
  }

  params.set('$top', String(page.top))
  params.set('$skip', String(page.nextSkip))

  return `${env.graphOrigin}${request.path}?${params.toString()}`
}

/** `{ @odata.context, value, @odata.nextLink? }`, as the fixture pages record them. */
export const collection = (
  context: string,
  value: ReadonlyArray<unknown>,
  nextLink: string | undefined
) =>
  nextLink === undefined
    ? { '@odata.context': context, value }
    : { '@odata.context': context, value, '@odata.nextLink': nextLink }

/** A write body that is a JSON object with only `allowed` keys, or a 400. */
export const bodyObject = (
  request: RouteRequest,
  allowed: ReadonlyArray<string>
): Schema.JsonObject | Response => {
  if (!isJsonObject(request.body)) {
    return request.error(
      400,
      codes.invalidBody,
      'Synthetic: the request body must be a JSON object.'
    )
  }

  const unknown = Object.keys(request.body).find(key => !allowed.includes(key))

  return unknown === undefined
    ? request.body
    : request.error(
        400,
        codes.unsupportedValue,
        `Synthetic: property '${unknown}' is not emulated on this request.`
      )
}

/** 400 for an invalid value. */
export const invalidValue = (request: RouteRequest, message: string): Response =>
  request.error(400, codes.invalidRequest, `Synthetic: ${message}`)

/** 400 for a valid Graph request the emulator does not emulate (fail closed). */
export const notEmulated = (request: RouteRequest, message: string): Response =>
  request.error(400, codes.unsupportedValue, `Synthetic: ${message}`)

/**
 * A nested JSON object with only `allowed` keys (fail closed on anything else, before any write),
 * or a 400. `expected` names the expected object in the error message.
 */
export const nestedObject = (
  request: RouteRequest,
  value: Schema.Json | undefined,
  allowed: ReadonlyArray<string>,
  expected: string
): Schema.JsonObject | Response => {
  if (!isJsonObject(value)) return invalidValue(request, `expected ${expected}.`)

  const unknown = Object.keys(value).find(key => !allowed.includes(key))

  return unknown === undefined
    ? value
    : notEmulated(request, `property '${unknown}' is not emulated in ${expected}.`)
}

/**
 * An `itemBody` write value, `{ contentType, content }` with only those keys. The fixtures write
 * text bodies only (`Text`/`text`); any other content type is not emulated.
 */
export const textBody = (
  request: RouteRequest,
  value: Schema.Json | undefined
): string | Response => {
  const body = nestedObject(
    request,
    value,
    ['contentType', 'content'],
    'body { contentType, content }'
  )

  if (body instanceof Response) return body

  if (!Predicate.isString(body.contentType) || !Predicate.isString(body.content)) {
    return invalidValue(request, 'body must be { contentType, content } with string values.')
  }

  return body.contentType.toLowerCase() === 'text'
    ? body.content
    : notEmulated(request, `body contentType ${body.contentType} is not emulated (text only).`)
}

/** A Graph timestamp (`2026-09-29T10:00:00Z`) from the emulator clock. */
export const nowTimestamp = (env: MicrosoftApiEnv): string =>
  new Date(Math.floor(env.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z')

/** The next change key (bumps the counter). */
export const nextChangeKey = (state: MicrosoftEmulatorState, prefix: string): string => {
  const number = state.counters.nextChangeKeyNumber

  state.counters = { ...state.counters, nextChangeKeyNumber: number + 1 }

  return `${prefix}${padded(number, 4)}`
}

/** The `personal/{site}` segment of the mailbox owner (`ada@example.test` → `ada_example_test`). */
export const personalSite = (user: MicrosoftEmulatorUser): string =>
  user.mail.toLowerCase().replace(/[^a-z0-9]/g, '_')
