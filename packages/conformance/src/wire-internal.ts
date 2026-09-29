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

// Credential text patterns. The fixture secret scan (`scanFixtureForSecrets`) tests them and the
// runner's report sanitizer redacts with them, so both share this one definition.

/** `Bearer <token>` with a token-shaped value. */
export const bearerPattern = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i

/** Common API-key prefixes, JSON Web Tokens, and PEM private keys. */
export const apiKeyPatterns: ReadonlyArray<RegExp> = [
  // OpenAI/Anthropic/DeepSeek-style secret keys (sk-..., sk-ant-..., sk-proj-...)
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}/,
  /\bxai-[A-Za-z0-9]{20,}/,
  /\bvck_[A-Za-z0-9]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  // JSON Web Tokens (OIDC/OAuth access tokens)
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
]

const credentialParamNames =
  'api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth|secret|password|client[_-]?secret|x-amz-signature|x-amz-credential|x-amz-security-token'

/**
 * Query-string or form-encoded credential parameter, anchored at the start of
 * the text or after `?`/`&` (URLs and `application/x-www-form-urlencoded` bodies).
 */
export const credentialParamPattern = new RegExp(`(?:^|[?&])(${credentialParamNames})=[^&#]+`, 'i')

// Singular credential field names (snake, kebab, or camel case). Plural usage
// counters such as `max_tokens` or `prompt_tokens` never match.
const credentialFieldNames =
  '(?:access|refresh|id|auth|api|session|private|bearer|oauth)[_-]?token|token|client[_-]?secret|secret(?:[_-]?key)?|private[_-]?key|password|passwd|api[_-]?key|authorization'

/** A JSON object key (or similar field name) that holds a credential. */
export const credentialFieldPattern = new RegExp(`^(${credentialFieldNames})$`, 'i')

const globally = (pattern: RegExp): RegExp =>
  new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)

// Redaction forms of the patterns above. They are deliberately broader than the scan (any bearer
// value, parameters after whitespace or punctuation, `name: value` field pairs) because
// over-redacting a report message is harmless.
const bearerRedaction = /\bbearer\s+\S+/gi

const apiKeyRedactions: ReadonlyArray<RegExp> = [
  ...apiKeyPatterns.slice(0, -1).map(globally),
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
]

const credentialParamRedaction = new RegExp(
  `(^|[?&\\s;,(])(${credentialParamNames})=[^&#\\s;,)]+`,
  'gi'
)

// `name: value` / `"name": "value"` / `name=value`. An unquoted value may carry an auth scheme
// (`Authorization: Basic <token>`); a value already redacted as `Bearer <redacted>` is kept.
const credentialFieldRedaction = new RegExp(
  `(^|[^A-Za-z0-9_-])(["']?)(${credentialFieldNames})\\2(\\s*[:=]\\s*)(?!bearer <redacted>)(?:"(?:[^"\\\\]|\\\\.)*"?|'[^']*'?|(?:(?:basic|bearer|digest|negotiate|token)\\s+)?[^\\s,;&}\\]]+)`,
  'gi'
)

/**
 * Redact every credential pattern shared with the fixture secret scan: bearer tokens, API-key
 * prefixes, JWTs, private keys, credential query/form parameters, and credential field pairs
 * (`"api_key": "..."`, `password=...`). Best effort; used on report messages.
 */
export const redactCredentialText = (text: string): string => {
  let result = text.replace(bearerRedaction, `Bearer ${redactedHeaderValue}`)

  for (const pattern of apiKeyRedactions) {
    result = result.replace(pattern, redactedHeaderValue)
  }

  return result
    .replace(
      credentialParamRedaction,
      (_match, prefix: string, name: string) => `${prefix}${name}=${redactedHeaderValue}`
    )
    .replace(
      credentialFieldRedaction,
      (_match, prefix: string, quote: string, name: string, separator: string) =>
        `${prefix}${quote}${name}${quote}${separator}${redactedHeaderValue}`
    )
}

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
