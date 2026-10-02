/**
 * HTTP rules shared by the emulators (internal): which statuses and headers a fault or scripted
 * error may answer with, which request header and query parameter names carry credentials, and the
 * marker a stateful core route uses to report a handler that threw.
 *
 * Faults and scripted errors always carry a body and never redirect, so 1xx, 204, 205, and every
 * 3xx (including 304) are rejected when the fault or turn is added, as are invalid header names or
 * values, a `location` header, and the framing headers the server sets itself. Route statuses
 * (for example a fixture's bodiless 204 or its 202 with a `Location`) follow the fixtures instead.
 *
 * Runtime-portable (no Node builtins): the emulators are plain Web fetch handlers.
 */
import { Predicate } from 'effect'
import * as Schema from 'effect/Schema'

/** Why a status cannot answer an emulated request, or `undefined` when it can. */
const emulatorStatusProblem = (status: number): string | undefined =>
  status >= 300 && status <= 399
    ? 'emulators never redirect: 3xx statuses are not allowed'
    : status === 204 || status === 205
      ? 'a 204 or 205 response cannot carry a body'
      : undefined

/** Statuses a fault or scripted error may answer with: 200-599 without 204, 205, and 3xx. */
export const EmulatorResponseStatus = Schema.Int.check(
  Schema.isBetween({ minimum: 200, maximum: 599 }),
  Schema.makeFilter(emulatorStatusProblem)
)

// RFC 9110 token characters for header names.
const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

// Visible ASCII, space, tab, and obs-text: what both web `Headers` and Node's HTTP server accept.
const headerValuePattern = /^[\t\x20-\x7e\x80-\xff]*$/

const framingHeaders: ReadonlySet<string> = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade'
])

/** Why a header record cannot be sent by an emulator, or `undefined` when it can. */
const emulatorHeaderRecordProblem = (
  headers: Readonly<Record<string, string>>
): string | undefined => {
  for (const [name, value] of Object.entries(headers)) {
    if (!headerNamePattern.test(name)) {
      return `header name ${JSON.stringify(name)} is not a valid HTTP token`
    }

    if (name.toLowerCase() === 'location') {
      return 'emulators never redirect: a location header is not allowed'
    }

    // The server frames the body itself; a hand-set framing header would corrupt the response.
    if (framingHeaders.has(name.toLowerCase())) {
      return `header ${name} is set by the server and cannot be scripted`
    }

    if (!headerValuePattern.test(value)) {
      return `header ${name} has a value with control or non-Latin-1 characters`
    }
  }

  return undefined
}

/** Response headers for a fault or scripted error: valid names and values, and no `location`. */
export const EmulatorHeaderRecord = Schema.Record(Schema.String, Schema.String).check(
  Schema.makeFilter(emulatorHeaderRecordProblem)
)

// Header names that carry credentials or session state: the same rule as the conformance wire
// helpers (`isCredentialHeaderName` in `@yolk-sdk/conformance`), copied because emulator source
// never imports SDK packages.
const credentialHeaderNames: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'x-auth-token',
  'x-access-token',
  'x-amz-security-token',
  'x-vercel-oidc-token',
  'x-csrf-token'
])

const credentialHeaderPattern = /(api[-_]?key|secret|password|cookie|authorization)/i

const credentialHeaderSegmentPattern = /(^|[-_])(token|key|auth)([-_]|$)/i

/** True for header names that carry credentials or session state. */
export const isCredentialHeaderName = (name: string): boolean => {
  const lower = name.toLowerCase()

  return (
    credentialHeaderNames.has(lower) ||
    credentialHeaderPattern.test(lower) ||
    credentialHeaderSegmentPattern.test(lower)
  )
}

/** What a redacted credential value becomes in a ledger. */
export const redactedCredentialValue = '<redacted>'

const isJsonRecord = (value: Schema.Json): value is Schema.JsonObject =>
  value !== null && Predicate.isObject(value) && !Array.isArray(value)

/**
 * A JSON value safe to keep in a ledger: every object key that `isCredentialHeaderName` accepts
 * (for example `requests[].headers.Authorization` in a Graph `$batch` body), at any depth, has
 * its value replaced by `<redacted>`. Other values are copied unchanged.
 */
export const redactCredentialFields = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(redactCredentialFields)

  if (!isJsonRecord(value)) return value

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isCredentialHeaderName(key) ? redactedCredentialValue : redactCredentialFields(entry)
    ])
  )
}

// Query parameter names that carry credentials: the same list as the conformance fixture scan
// (`credentialParamPattern` in `@yolk-sdk/conformance`, reported as `credential_query_param`),
// copied because emulator source never imports SDK packages. It adds the presigned-URL
// `x-amz-signature` and `x-amz-credential`, which the header rule does not cover.
const credentialQueryParamPattern =
  /^(api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth|secret|password|client[_-]?secret|x-amz-signature|x-amz-credential|x-amz-security-token)$/i

/**
 * True for query parameter names that carry credentials: every name the conformance fixture scan
 * reports as a credential query parameter, plus every name `isCredentialHeaderName` accepts.
 */
export const isCredentialQueryKey = (name: string): boolean =>
  credentialQueryParamPattern.test(name) || isCredentialHeaderName(name)

/**
 * Query parameters safe to keep in a ledger: the value of every key that `isCredentialQueryKey`
 * accepts (for example `access_token`, `api_key`, or `X-Amz-Signature`) is replaced by
 * `<redacted>`.
 */
export const redactCredentialQuery = (query: URLSearchParams): Readonly<Record<string, string>> =>
  Object.fromEntries(
    [...query].map(([key, value]) => [
      key,
      isCredentialQueryKey(key) ? redactedCredentialValue : value
    ])
  )

/**
 * Internal response header a stateful core route sets on the bodiless 500 it answers when its
 * handler throws. The wrapper never forwards it: it answers its own error envelope 500 instead
 * and records `responseError` in the ledger.
 */
export const handlerFailedHeader = 'x-emulator-handler-failed'

/** The core route's answer when its handler threw (see `handlerFailedHeader`). */
export const handlerFailedResponse = (): Response =>
  new Response(null, { status: 500, headers: { [handlerFailedHeader]: '1' } })

/**
 * Internal request header a stateful wrapper sets on the requests it forwards to its core: the
 * id of the wrapper's job for that request (the fault decision the core route asks for, and what
 * the route decided). Ids come from a counter that never resets (the ledger sequence does), so a
 * ledger clear never makes two jobs share one. Clients cannot set it: wrappers build the core
 * request headers themselves.
 */
export const emulatorJobHeader = 'x-emulator-job-id'

/**
 * What a core route answers when the wrapper returns the real answer itself (a fault, or in the
 * shared wrapper's resolved mode a refusal), so that answer never depends on the core runtime's
 * lifecycle: a reset or a close before it is read never cancels it.
 */
export const answeredOutsideCore = (): Response => new Response(null, { status: 204 })
