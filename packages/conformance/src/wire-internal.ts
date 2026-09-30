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

/** PEM private key header. */
const privateKeyPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----/

/** Common API-key prefixes and JSON Web Tokens. */
const tokenPrefixPatterns: ReadonlyArray<RegExp> = [
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
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/
]

/** Common API-key prefixes, JSON Web Tokens, and PEM private keys. */
export const apiKeyPatterns: ReadonlyArray<RegExp> = [...tokenPrefixPatterns, privateKeyPattern]

const credentialParamNames =
  'api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth|secret|password|client[_-]?secret|x-amz-signature|x-amz-credential|x-amz-security-token'

/**
 * Query-string or form-encoded credential parameter, anchored at the start of
 * the text or after `?`/`&` (URLs and `application/x-www-form-urlencoded` bodies).
 */
export const credentialParamPattern = new RegExp(`(?:^|[?&])(${credentialParamNames})=[^&#]+`, 'i')

// Every `name=` of a credential parameter, found on its own: the pattern stops at `=` and never
// consumes the value, so a later `?name=` or `&name=` is always found, whatever the value holds.
const credentialParamNamesAt = new RegExp(`(?:^|[?&])(${credentialParamNames})=`, 'gi')

// What ends a raw parameter value: a character that cannot appear raw inside a URL query value
// (RFC 3986): `&`, `#`, whitespace, `"`, `<`, `>`. `?` and `'` are NOT boundaries (both are legal
// raw inside a query value), and neither is any percent-encoded delimiter.
const valueBoundary = /[&#\s"<>]/

/**
 * The exact synthetic credential values a `PortFixture` may carry, keyed by lower-case parameter
 * name: SigV4 presigned-URL placeholders for S3-compatible ports (the R2 conformance fixtures sign
 * with them). `scanPortFixtureForSecrets` exempts a credential parameter only when its name is a
 * key here and its whole raw value (up to `&`, `#`, whitespace, `"`, `<`, `>`, or the end),
 * percent-decoded, equals that key's value exactly; anything else inside the value (a raw `?`, an
 * encoded delimiter, any suffix), another parameter name, or another scope is flagged.
 * `scanFixtureForSecrets` exempts nothing. Never build a placeholder by prefixing or suffixing a
 * real value.
 */
export const syntheticPortCredentialParams = Object.freeze({
  'x-amz-signature': 'yolk-synthetic-signature',
  'x-amz-credential': 'yolk-synthetic-access-key-id/20260930/auto/s3/aws4_request'
})

const exactPlaceholders = new Map<string, string>(Object.entries(syntheticPortCredentialParams))

/** `text` with `%XX` escapes decoded, repeatedly (at most three layers, then left as it is). */
const percentDecodedLayers = (text: string): string => {
  let current = text

  for (let round = 0; round < 3 && /%[0-9A-Fa-f]{2}/.test(current); round++) {
    current = current.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
  }

  return current
}

/** The raw, undecoded value starting at `start`: up to the first structural boundary. */
const rawParamValueAt = (text: string, start: number): string => {
  const rest = text.slice(start)
  const end = rest.search(valueBoundary)

  return end === -1 ? rest : rest.slice(0, end)
}

/**
 * True when `text` carries a credential query or form parameter that is not an exact synthetic
 * placeholder (`syntheticPortCredentialParams`). Every `name=` is found and judged on its own: its
 * raw value runs to the next structural boundary (see `rawParamValueAt`), is percent-decoded
 * (`percentDecodedLayers`), and is exempt only when it equals that name's placeholder exactly. It
 * flags at least whatever `credentialParamPattern` flags (a `name=` followed by any character but
 * `&` or `#`), except the exact placeholders.
 */
export const hasLiveCredentialParam = (text: string): boolean =>
  [...text.matchAll(credentialParamNamesAt)].some(match => {
    const name = (match[1] ?? '').toLowerCase()
    const start = match.index + match[0].length
    const value = rawParamValueAt(text, start)
    const next = text.charAt(start)
    const present = value.length > 0 || (next !== '' && next !== '&' && next !== '#')

    return present && exactPlaceholders.get(name) !== percentDecodedLayers(value)
  })

// Singular credential field names (snake, kebab, or camel case), including the AWS-style
// `accessKeyId` / `secretAccessKey` / `sessionToken` of S3-compatible signing inputs. Plural usage
// counters such as `max_tokens` or `prompt_tokens` never match.
const credentialFieldNames =
  '(?:access|refresh|id|auth|api|session|private|bearer|oauth)[_-]?token|token|client[_-]?secret|secret(?:[_-]?key)?|private[_-]?key|password|passwd|api[_-]?key|access[_-]?key[_-]?id|secret[_-]?access[_-]?key|authorization'

/** A JSON object key (or similar field name) that holds a credential. */
export const credentialFieldPattern = new RegExp(`^(${credentialFieldNames})$`, 'i')

const globally = (pattern: RegExp): RegExp =>
  new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)

// Redaction forms of the patterns above. They are deliberately broader than the scan (any bearer
// value, parameters after whitespace or punctuation, `name: value` field pairs) because
// over-redacting a report message is harmless.
const bearerRedaction = /\bbearer\s+\S+/gi

const apiKeyRedactions: ReadonlyArray<RegExp> = [
  ...tokenPrefixPatterns.map(globally),
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

// Candidate unquoted `Name:` header-like names inside one line (colon only). Quoted keys such
// as `"x-api-key": "..."` are handled by `quotedCredentialHeaderRedaction`; `name=value` pairs
// are left to the quote-aware field and parameter passes.
const headerLikeNamePattern = /(?:^|[^A-Za-z0-9_-])([A-Za-z][A-Za-z0-9_-]*)\s*:/g

/**
 * Redact the rest of a line after the first header-like `Name:` that `isCredentialHeaderName`
 * accepts (`X-Api-Key: ...`, `Proxy-Authorization: Basic ...`, `Cookie: ...`), so every header the
 * fixture scan flags is also redacted in report text. Runs on the raw text before any other pass,
 * so a partially matched value (for example a key-shaped cookie name) never shields the rest of
 * the line.
 */
const redactCredentialHeaderLines = (text: string): string =>
  text
    .split(/(\r\n|\r|\n)/)
    .map(line => {
      headerLikeNamePattern.lastIndex = 0

      for (let match = headerLikeNamePattern.exec(line); match !== null;) {
        const name = match[1]

        if (name !== undefined && isCredentialHeaderName(name)) {
          return `${line.slice(0, match.index + match[0].length)} ${redactedHeaderValue}`
        }

        match = headerLikeNamePattern.exec(line)
      }

      return line
    })
    .join('')

// A quoted key that `isCredentialHeaderName` accepts (`"x-api-key": "..."`,
// `'Proxy-Authorization': '...'`): only the value is redacted, so JSON stays balanced.
const quotedCredentialHeaderRedaction =
  /(["'])([A-Za-z][A-Za-z0-9_-]*)\1(\s*:\s*)("(?:[^"\\]|\\.)*"?|'[^']*'?|[^\s,;&{}[\]]+)/g

const redactQuotedCredentialHeaders = (text: string): string =>
  text.replace(
    quotedCredentialHeaderRedaction,
    (match, quote: string, name: string, separator: string) =>
      isCredentialHeaderName(name)
        ? `${quote}${name}${quote}${separator}${redactedHeaderValue}`
        : match
  )

/**
 * Redact every credential pattern shared with the fixture secret scan: credential header lines
 * (first, to the end of the line), quoted credential header keys (value only), bearer tokens,
 * API-key prefixes, JWTs, private keys, credential field pairs (`"api_key": "..."`,
 * `password="..."`), and credential query/form parameters. Best effort; used on report messages.
 * Known gap: escaped JSON inside a quoted string value (`"body":"{\\"x-api-key\\":...}"`) is not
 * parsed.
 * Quote-aware field redaction runs before parameter redaction so a quoted value with spaces is
 * removed whole.
 */
export const redactCredentialText = (text: string): string => {
  let result = redactCredentialHeaderLines(text).replace(
    bearerRedaction,
    `Bearer ${redactedHeaderValue}`
  )

  for (const pattern of apiKeyRedactions) {
    result = result.replace(pattern, redactedHeaderValue)
  }

  return redactQuotedCredentialHeaders(result)
    .replace(
      credentialFieldRedaction,
      (_match, prefix: string, quote: string, name: string, separator: string) =>
        `${prefix}${quote}${name}${quote}${separator}${redactedHeaderValue}`
    )
    .replace(
      credentialParamRedaction,
      (_match, prefix: string, name: string) => `${prefix}${name}=${redactedHeaderValue}`
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
