/**
 * Fortnox emulator route kit (internal): the route and handler types, the `ErrorInformation`
 * codes and envelope, paging, and the small helpers both route tables share (`src/fortnox/api.ts`
 * for the customer and invoice routes, `src/fortnox/read-api.ts` for the read-only resources).
 *
 * @experimental
 */
import { Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import type { EmulatorRouteEvidence } from '../route-evidence.ts'
import type { FortnoxEmulatorState } from './state.ts'

/**
 * Drill knobs: each flips one observed quirk to the documented-but-wrong behavior, ONLY to prove
 * that the conformance cases catch a disagreement. Defaults follow the observed behavior.
 */
export type FortnoxEmulatorQuirks = {
  /** `false`: a positionally matched row that omits `Discount`/`DiscountType` resets them. */
  readonly stickyRowDiscount?: boolean
  /** `true`: a customer update with `""` clears the stored string instead of keeping it. */
  readonly emptyStringClears?: boolean
  /** `true`: `unpaid`/`unpaidoverdue`/`fullypaid` also match unbooked invoices. */
  readonly paymentFiltersIncludeUnbooked?: boolean
}

export type FortnoxApiEnv = {
  /** Clock in epoch milliseconds (the `unpaidoverdue` "today", new invoice dates, the outbox). */
  readonly now: () => number
  /** Origin used in `@url` links, for example `https://api.fortnox.se`. */
  readonly linkOrigin: string
  readonly quirks: Required<FortnoxEmulatorQuirks>
}

/**
 * `ErrorInformation` codes the emulator answers with. The two customer-not-found codes are copied
 * from the rejection fixture; the `2999xxx` codes are synthetic emulator codes.
 */
export const fortnoxEmulatorErrorCodes = {
  customerNotFound: 2000204,
  invoiceCustomerNotFound: 2000433,
  unauthorized: 2999001,
  invalidBody: 2999002,
  invalidField: 2999003,
  readOnlyField: 2999004,
  notEditable: 2999005,
  invoiceNotFound: 2999006,
  unknownRoute: 2999007,
  unsupportedQuery: 2999008,
  rateLimited: 2999009,
  upstreamError: 2999010,
  /** Any read-only resource (article, price, offer, register entry, ...) the state does not hold. */
  resourceNotFound: 2999011
} as const

/** Fortnox API base path. */
export const fortnoxEmulatorBasePath = '/3'

export const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

/** A Fortnox `ErrorInformation` response with the lowercase fields of the rejection fixture. */
export const errorInformation = (status: number, code: number, message: string): Response =>
  jsonResponse(status, { ErrorInformation: { error: 1, message, code } })

const codes = fortnoxEmulatorErrorCodes

export const invalidField = (message: string): Response =>
  errorInformation(400, codes.invalidField, `Synthetic: ${message}`)

/** The generic not-found answer of the read-only resources (no fixture records theirs). */
export const resourceNotFound = (kind: string): Response =>
  errorInformation(404, codes.resourceNotFound, `Synthetic: ${kind} not found.`)

export const unsupportedQuery = (key: string): Response =>
  errorInformation(
    400,
    codes.unsupportedQuery,
    key === 'lastmodified'
      ? 'Synthetic: query parameter lastmodified is not emulated (the emulator does not track modification times).'
      : `Synthetic: query parameter ${key} is not emulated.`
  )

// The synthetic invoice preview PDF from the preview fixture (`bodyBase64`), copied as data. The
// offer preview (no fixture) answers the same bytes.
const previewPdfBase64 =
  'JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFtdIC9Db3VudCAwID4+CmVuZG9iagp0cmFpbGVyCjw8IC9Sb290IDEgMCBSID4+CiUlRU9GCg=='

/** Bytes of canonical standard base64 (validated where it enters the state). */
export const base64Bytes = (base64: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(base64), character => character.charCodeAt(0))

export const pdfResponse = (): Response =>
  new Response(base64Bytes(previewPdfBase64), {
    status: 200,
    headers: { 'content-type': 'application/pdf' }
  })

export type RouteRequest = {
  readonly params: Readonly<Record<string, string>>
  readonly query: URLSearchParams
  /** Parsed JSON body; `undefined` when absent or not JSON. */
  readonly body: Schema.Json | undefined
}

export const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  value !== undefined && value !== null && Predicate.isObject(value) && !Array.isArray(value)

export type RouteHandler = (
  state: FortnoxEmulatorState,
  request: RouteRequest,
  env: FortnoxApiEnv
) => Response

export type FortnoxApiRoute = EmulatorRouteEvidence & {
  /**
   * Query parameters the route emulates; any other key answers 400 before the handler runs, so
   * a rejected request never writes. Empty by default.
   */
  readonly queryKeys: ReadonlyArray<string>
  readonly handler: RouteHandler
}

/**
 * An unverified connector route under `/3`. `caseIds` lists the conformance cases whose claims it
 * follows; routes without a fixture cite none.
 */
export const connectorRoute = (
  method: string,
  path: string,
  write: boolean,
  caseIds: ReadonlyArray<string>,
  handler: RouteHandler,
  queryKeys: ReadonlyArray<string> = []
): FortnoxApiRoute => ({
  method,
  path: `${fortnoxEmulatorBasePath}${path}`,
  kind: 'connector',
  write,
  caseIds,
  evidence: 'unverified',
  queryKeys,
  handler
})

/** The `@url` of a resource: the link origin, `/3`, and each segment percent-encoded. */
export const resourceUrl = (env: FortnoxApiEnv, ...segments: ReadonlyArray<string>): string =>
  `${env.linkOrigin}${fortnoxEmulatorBasePath}/${segments.map(encodeURIComponent).join('/')}`

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/

/** A real `YYYY-MM-DD` calendar date (no JavaScript rollover such as `2026-02-30`). */
export const isIsoDate = (value: string): boolean => {
  const parsed = Date.parse(`${value}T00:00:00.000Z`)

  return (
    isoDatePattern.test(value) &&
    !Number.isNaN(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === value
  )
}

export const today = (env: FortnoxApiEnv): string => new Date(env.now()).toISOString().slice(0, 10)

/** The `fromdate`/`todate` query values, or the 400 for one that is not a `YYYY-MM-DD` date. */
export const dateRange = (
  query: URLSearchParams
): { readonly from: string | null; readonly to: string | null } | Response => {
  const from = query.get('fromdate')
  const to = query.get('todate')

  for (const [key, value] of [
    ['fromdate', from],
    ['todate', to]
  ] as const) {
    if (value !== null && !isIsoDate(value)) {
      return invalidField(`query parameter ${key} must be a YYYY-MM-DD date.`)
    }
  }

  return { from, to }
}

const positiveInt = (
  query: URLSearchParams,
  key: string,
  fallback: number,
  maximum: number
): number | Response => {
  const raw = query.get(key)

  if (raw === null) {
    return fallback
  }

  const value = Number(raw)

  return /^\d+$/.test(raw) && value >= 1 && value <= maximum
    ? value
    : invalidField(`query parameter ${key} must be an integer from 1 to ${maximum}.`)
}

/** Fortnox default and maximum page sizes. */
const defaultLimit = 100

const maxLimit = 500

/** One page plus `MetaInformation` (`@TotalPages` is at least 1, as the empty-list fixture shows). */
export const paginate = <A>(
  items: ReadonlyArray<A>,
  query: URLSearchParams
): { readonly items: ReadonlyArray<A>; readonly meta: Record<string, number> } | Response => {
  const limit = positiveInt(query, 'limit', defaultLimit, maxLimit)
  const page = positiveInt(query, 'page', 1, Number.MAX_SAFE_INTEGER)

  if (limit instanceof Response) return limit

  if (page instanceof Response) return page

  return {
    items: items.slice((page - 1) * limit, page * limit),
    meta: {
      '@CurrentPage': page,
      '@TotalPages': Math.max(1, Math.ceil(items.length / limit)),
      '@TotalResources': items.length
    }
  }
}

export const contains = (value: string, search: string): boolean =>
  value.toLowerCase().includes(search.toLowerCase())

/** A list search table: query key to the predicate its value must satisfy. */
export type SearchTable<A> = Readonly<Record<string, (item: A, value: string) => boolean>>

/** Whether `item` satisfies every search key present in `query`. */
export const matchesSearch = <A>(item: A, query: URLSearchParams, search: SearchTable<A>) =>
  Object.entries(search).every(([key, matches]) => {
    const value = query.get(key)

    return value === null || matches(item, value)
  })
