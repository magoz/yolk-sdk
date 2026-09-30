import { Effect, Encoding, Option, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import type { HttpClientRequest } from 'effect/unstable/http'

// Header names that carry credentials or session state. Fixtures must never
// contain them and replay ledgers redact them.
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

// A `-`/`_`-separated name segment that is exactly `token`, `key`, or `auth`
// (`x-auth-token`, `private-token`, `x-figma-token`, `x-*-key`). Plural
// segments such as `x-ratelimit-remaining-tokens` do not match.
const credentialHeaderSegmentPattern = /(^|[-_])(token|key|auth)([-_]|$)/i

/**
 * True for header names that carry credentials or session state. Used by the
 * fixture secret scan, recorder drop rules, and ledger redaction.
 */
export const isCredentialHeaderName = (name: string): boolean => {
  const lower = name.toLowerCase()

  return (
    credentialHeaderNames.has(lower) ||
    credentialHeaderPattern.test(lower) ||
    credentialHeaderSegmentPattern.test(lower)
  )
}

export const redactedHeaderValue = '<redacted>'

export const redactHeaders = (headers: Readonly<Record<string, string>>) => {
  const redacted: Record<string, string> = {}

  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = isCredentialHeaderName(name) ? redactedHeaderValue : value
  }

  return redacted
}

const compareStrings = (left: string, right: string): number => {
  if (left < right) {
    return -1
  }

  return left > right ? 1 : 0
}

/**
 * Canonical absolute URL used for matching: hash removed and query parameters
 * sorted by name, then value. Unparseable input is returned unchanged.
 */
export const normalizeWireUrl = (input: string): string => {
  if (!URL.canParse(input)) {
    return input
  }

  const url = new URL(input)
  url.hash = ''

  const params = [...url.searchParams.entries()].sort(
    ([leftName, leftValue], [rightName, rightValue]) =>
      leftName === rightName
        ? compareStrings(leftValue, rightValue)
        : compareStrings(leftName, rightName)
  )

  url.search = ''

  for (const [name, value] of params) {
    url.searchParams.append(name, value)
  }

  return url.toString()
}

/**
 * Match an optional URL filter. A pattern ending in `*` is a prefix match on
 * the normalized URL; otherwise the normalized URLs must be equal.
 */
export const urlMatchesPattern = (pattern: string, normalizedUrl: string): boolean =>
  pattern.endsWith('*')
    ? normalizedUrl.startsWith(pattern.slice(0, -1))
    : normalizeWireUrl(pattern) === normalizedUrl

/** Request body as UTF-8 text when it is an in-memory body; otherwise undefined. */
export const requestBodyText = (
  request: HttpClientRequest.HttpClientRequest
): string | undefined => {
  const body = request.body

  if (Predicate.isTagged(body, 'Uint8Array')) {
    return new TextDecoder().decode(body.body)
  }

  if (Predicate.isTagged(body, 'Raw') && Predicate.isString(body.body)) {
    return body.body
  }

  return undefined
}

/** Exact bytes of standard base64 text; `None` when the text is not valid base64. */
export const decodeBase64Bytes = (text: string): Option.Option<Uint8Array> =>
  Result.getSuccess(Encoding.decodeBase64(text))

/**
 * Decode bytes as UTF-8 only when they are valid UTF-8 on their own. A leading
 * byte-order mark is kept so that re-encoding yields the same bytes.
 */
export const decodeUtf8Strict = (bytes: Uint8Array): Option.Option<string> =>
  Option.liftThrowable(() =>
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  )()

/** Lossless recording of bytes: readable text when valid UTF-8, otherwise base64. */
export const recordBytes = (
  bytes: Uint8Array
): { readonly text: string } | { readonly base64: string } =>
  Option.match(decodeUtf8Strict(bytes), {
    onNone: () => ({ base64: Encoding.encodeBase64(bytes) }),
    onSome: text => ({ text })
  })

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

/** Parse text as JSON; `None` when it is not valid JSON. */
export const parseJsonText = (text: string): Effect.Effect<Option.Option<Schema.Json>> =>
  decodeJsonText(text).pipe(Effect.option)

export const headerRecord = (headers: Readonly<Record<string, string | undefined>>) => {
  const record: Record<string, string> = {}

  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      record[name.toLowerCase()] = value
    }
  }

  return record
}

export const mediaType = (contentType: string | undefined): string | undefined =>
  contentType?.split(';', 1)[0]?.trim().toLowerCase()

// Web `Response` rejects a body for these statuses.
const nullBodyStatuses: ReadonlySet<number> = new Set([101, 103, 204, 205, 304])

export const isNullBodyStatus = (status: number): boolean => nullBodyStatuses.has(status)
