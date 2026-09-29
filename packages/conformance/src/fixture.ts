/**
 * Wire fixture data model: recorded HTTP exchanges with outside services.
 *
 * Fixtures are plain, serializable data. They must contain synthetic or
 * scrubbed content only: never credentials, cookies, or customer data. Use
 * `scanFixtureForSecrets` before committing a fixture.
 *
 * @experimental
 */
import { Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { isCredentialHeaderName } from './wire-internal.ts'

/** `verified` = recorded from a live service; `unverified` = synthetic placeholder. */
export const WireFixtureEvidence = Schema.Literals(['verified', 'unverified'])

export type WireFixtureEvidence = typeof WireFixtureEvidence.Type

/** Lowercase header name to value. Request headers are allowlisted and never credentials. */
export const WireHeaders = Schema.Record(Schema.String, Schema.String)

export type WireHeaders = typeof WireHeaders.Type

const HttpStatus = Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))

export const WireRequest = Schema.Struct({
  method: Schema.NonEmptyString,
  /** Absolute URL including any query string. */
  url: Schema.NonEmptyString,
  headers: Schema.optionalKey(WireHeaders),
  /** Parsed JSON request body, when the request had one. */
  body: Schema.optionalKey(Schema.Json)
})

export type WireRequest = typeof WireRequest.Type

/** A response whose whole body was read as one UTF-8 string. */
export const WireBodyResponse = Schema.Struct({
  status: HttpStatus,
  headers: WireHeaders,
  body: Schema.String
})

export type WireBodyResponse = typeof WireBodyResponse.Type

/**
 * A streamed response (for example `text/event-stream`). Each entry is one
 * network chunk as UTF-8 text; chunk boundaries are preserved on replay.
 */
export const WireStreamResponse = Schema.Struct({
  status: HttpStatus,
  headers: WireHeaders,
  chunks: Schema.Array(Schema.String)
})

export type WireStreamResponse = typeof WireStreamResponse.Type

export const WireResponse = Schema.Union([WireBodyResponse, WireStreamResponse])

export type WireResponse = typeof WireResponse.Type

export const WireExchange = Schema.Struct({
  request: WireRequest,
  response: WireResponse
})

export type WireExchange = typeof WireExchange.Type

const RecordedAtDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))

export const WireFixture = Schema.Struct({
  id: Schema.NonEmptyString,
  caseId: Schema.NonEmptyString,
  evidence: WireFixtureEvidence,
  /** Calendar date of the recording (`YYYY-MM-DD`, UTC). */
  recordedAt: RecordedAtDate,
  /** Synthetic account label, for example `synthetic`; never a real account name. */
  account: Schema.NonEmptyString,
  endpoint: Schema.NonEmptyString,
  model: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
  exchanges: Schema.NonEmptyArray(WireExchange)
})

export type WireFixture = typeof WireFixture.Type

/** Decode unknown input (for example a JSON file) into a `WireFixture`. */
export const decodeWireFixture = Schema.decodeUnknownEffect(WireFixture)

export const isWireStreamResponse = (response: WireResponse): response is WireStreamResponse =>
  Predicate.hasProperty(response, 'chunks')

const millisPerDay = 86_400_000

const recordedAtPattern = /^(\d{4})-(\d{2})-(\d{2})$/

const recordedAtMillis = (recordedAt: string): number => {
  const match = recordedAtPattern.exec(recordedAt)

  if (match === null) {
    return Number.NaN
  }

  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

/**
 * Whole days between `recordedAt` (UTC midnight) and `now`. `NaN` when
 * `recordedAt` is not a `YYYY-MM-DD` date.
 */
export const fixtureAgeDays = (fixture: Pick<WireFixture, 'recordedAt'>, now: Date): number =>
  Math.floor((now.getTime() - recordedAtMillis(fixture.recordedAt)) / millisPerDay)

/**
 * True when the fixture is older than `maxAgeDays` (default 30). Fixtures with
 * an unreadable `recordedAt` are treated as stale.
 */
export const isFixtureStale = (
  fixture: Pick<WireFixture, 'recordedAt'>,
  now: Date,
  maxAgeDays = 30
): boolean => {
  const age = fixtureAgeDays(fixture, now)

  return Number.isNaN(age) || age > maxAgeDays
}

export type FixtureSecretIssueKind =
  | 'credential_header'
  | 'bearer_token'
  | 'api_key'
  | 'credential_query_param'
  | 'credential_field'

/** A secret-scan finding. `location` is a path into the fixture; the secret itself is never echoed. */
export type FixtureSecretIssue = {
  readonly kind: FixtureSecretIssueKind
  readonly location: string
}

const bearerPattern = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i

const apiKeyPatterns: ReadonlyArray<RegExp> = [
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

const credentialQueryPattern =
  /[?&](api[_-]?key|key|token|access[_-]?token|auth|secret|password|client[_-]?secret|x-amz-signature|x-amz-credential|x-amz-security-token)=[^&#]+/i

const credentialFieldPattern =
  /^(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|secret|authorization)$/i

const scanText = (text: string, location: string, issues: Array<FixtureSecretIssue>): void => {
  if (bearerPattern.test(text)) {
    issues.push({ kind: 'bearer_token', location })
  }

  if (apiKeyPatterns.some(pattern => pattern.test(text))) {
    issues.push({ kind: 'api_key', location })
  }
}

const scanHeaders = (
  headers: WireHeaders | undefined,
  location: string,
  issues: Array<FixtureSecretIssue>
): void => {
  for (const [name, value] of Object.entries(headers ?? {})) {
    const headerLocation = `${location}.${name}`

    if (isCredentialHeaderName(name)) {
      issues.push({ kind: 'credential_header', location: headerLocation })
    }

    scanText(value, headerLocation, issues)
  }
}

const scanUrl = (url: string, location: string, issues: Array<FixtureSecretIssue>): void => {
  if (credentialQueryPattern.test(url)) {
    issues.push({ kind: 'credential_query_param', location })
  }

  scanText(url, location, issues)
}

const scanJson = (
  value: Schema.Json,
  location: string,
  issues: Array<FixtureSecretIssue>
): void => {
  if (Predicate.isString(value)) {
    scanText(value, location, issues)

    return
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => scanJson(item, `${location}[${index}]`, issues))

    return
  }

  if (value !== null && !Predicate.isNumber(value) && !Predicate.isBoolean(value)) {
    for (const [key, item] of Object.entries(value)) {
      const itemLocation = `${location}.${key}`

      if (credentialFieldPattern.test(key) && Predicate.isString(item) && item.length > 0) {
        issues.push({ kind: 'credential_field', location: itemLocation })
      }

      scanJson(item, itemLocation, issues)
    }
  }
}

/**
 * Pure secret scan. Flags credential headers, bearer tokens, common API-key
 * prefixes, JWTs, private keys, credential query parameters, and credential
 * JSON fields anywhere in the fixture. Returns an empty array when clean.
 */
export const scanFixtureForSecrets = (fixture: WireFixture): ReadonlyArray<FixtureSecretIssue> => {
  const issues: Array<FixtureSecretIssue> = []

  scanUrl(fixture.endpoint, 'endpoint', issues)

  if (fixture.note !== undefined) {
    scanText(fixture.note, 'note', issues)
  }

  fixture.exchanges.forEach((exchange, index) => {
    const base = `exchanges[${index}]`

    scanUrl(exchange.request.url, `${base}.request.url`, issues)
    scanHeaders(exchange.request.headers, `${base}.request.headers`, issues)

    if (exchange.request.body !== undefined) {
      scanJson(exchange.request.body, `${base}.request.body`, issues)
    }

    const response = exchange.response

    scanHeaders(response.headers, `${base}.response.headers`, issues)

    if (isWireStreamResponse(response)) {
      response.chunks.forEach((chunk, chunkIndex) =>
        scanText(chunk, `${base}.response.chunks[${chunkIndex}]`, issues)
      )
    } else {
      scanText(response.body, `${base}.response.body`, issues)
    }
  })

  return issues
}
