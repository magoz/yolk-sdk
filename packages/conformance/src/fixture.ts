/**
 * Wire fixture data model: recorded HTTP exchanges with outside services.
 *
 * Fixtures are plain, serializable data. They must contain synthetic or
 * scrubbed content only: never credentials, cookies, or customer data. Use
 * `scanFixtureForSecrets` before committing a fixture.
 *
 * @experimental
 */
import { Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { decodeBase64Bytes, isCredentialHeaderName } from './wire-internal.ts'

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
  /** Parsed JSON request body, or the raw text when it is not JSON (for example a form body). */
  body: Schema.optionalKey(Schema.Json)
})

export type WireRequest = typeof WireRequest.Type

const Base64String = Schema.String.check(Schema.isBase64())

/**
 * One recorded network chunk. A chunk that is valid UTF-8 on its own is stored
 * as readable text (empty chunks as `""`); any other chunk is stored as
 * `{ base64 }` holding its exact bytes. Replay emits exactly these bytes.
 */
export const WireChunk = Schema.Union([Schema.String, Schema.Struct({ base64: Base64String })])

export type WireChunk = typeof WireChunk.Type

// `Never` keys keep the response shapes mutually exclusive when decoding: a
// response carries exactly one of `body`, `bodyBase64`, or `chunks`.
const absent = Schema.optionalKey(Schema.Never)

/** A response whose whole body is valid UTF-8, stored as one string. */
export const WireTextBodyResponse = Schema.Struct({
  status: HttpStatus,
  headers: WireHeaders,
  body: Schema.String,
  bodyBase64: absent,
  chunks: absent
})

export type WireTextBodyResponse = typeof WireTextBodyResponse.Type

/** A response whose whole body is not valid UTF-8 (for example a PDF), stored as base64 bytes. */
export const WireBase64BodyResponse = Schema.Struct({
  status: HttpStatus,
  headers: WireHeaders,
  bodyBase64: Base64String,
  body: absent,
  chunks: absent
})

export type WireBase64BodyResponse = typeof WireBase64BodyResponse.Type

/** A response recorded as one whole body: exactly one of `body` or `bodyBase64`. */
export const WireBodyResponse = Schema.Union([WireTextBodyResponse, WireBase64BodyResponse])

export type WireBodyResponse = typeof WireBodyResponse.Type

/**
 * A streamed response (for example `text/event-stream`). Each entry is one
 * network chunk (see `WireChunk`); chunk boundaries and bytes are preserved on
 * replay.
 */
export const WireStreamResponse = Schema.Struct({
  status: HttpStatus,
  headers: WireHeaders,
  chunks: Schema.Array(WireChunk),
  body: absent,
  bodyBase64: absent
})

export type WireStreamResponse = typeof WireStreamResponse.Type

export const WireResponse = Schema.Union([
  WireTextBodyResponse,
  WireBase64BodyResponse,
  WireStreamResponse
])

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

export const isWireBase64BodyResponse = (
  response: WireResponse
): response is WireBase64BodyResponse => Predicate.hasProperty(response, 'bodyBase64')

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

// Query-string or form-encoded credential parameter, anchored at the start of
// the text or after `?`/`&` (URLs and `application/x-www-form-urlencoded` bodies).
const credentialParamPattern =
  /(?:^|[?&])(api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth|secret|password|client[_-]?secret|x-amz-signature|x-amz-credential|x-amz-security-token)=[^&#]+/i

// Singular credential field names (snake, kebab, or camel case). Plural usage
// counters such as `max_tokens` or `prompt_tokens` never match.
const credentialFieldPattern =
  /^((access|refresh|id|auth|api|session|private|bearer|oauth)[_-]?token|token|client[_-]?secret|secret([_-]?key)?|private[_-]?key|password|passwd|api[_-]?key|authorization)$/i

type IssueSink = Array<FixtureSecretIssue>

const scanText = (text: string, location: string, issues: IssueSink): void => {
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
  issues: IssueSink
): void => {
  for (const [name, value] of Object.entries(headers ?? {})) {
    const headerLocation = `${location}.${name}`

    if (isCredentialHeaderName(name)) {
      issues.push({ kind: 'credential_header', location: headerLocation })
    }

    scanText(value, headerLocation, issues)
  }
}

const scanUrl = (url: string, location: string, issues: IssueSink): void => {
  if (credentialParamPattern.test(url)) {
    issues.push({ kind: 'credential_query_param', location })
  }

  scanText(url, location, issues)
}

const scanJson = (value: Schema.Json, location: string, issues: IssueSink): void => {
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

const parseJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

// `data:` payloads of each server-sent event, multi-line data joined with `\n`.
const sseDataPayloads = (text: string): ReadonlyArray<string> =>
  text.split(/\r?\n\r?\n/).flatMap(event => {
    const data = event
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice('data:'.length).replace(/^ /, ''))

    return data.length > 0 ? [data.join('\n')] : []
  })

/**
 * Scan a whole payload (request/response body or reassembled stream): token
 * patterns, form-encoded credential parameters, and credential fields in the
 * payload itself when it is JSON, or in each SSE `data:` payload that is JSON
 * (located as `<location>.events[n]`).
 */
const scanPayload = (text: string, location: string, issues: IssueSink): void => {
  scanText(text, location, issues)

  if (credentialParamPattern.test(text)) {
    issues.push({ kind: 'credential_query_param', location })
  }

  const json = parseJsonOption(text)

  if (Option.isSome(json)) {
    scanJson(json.value, location, issues)

    return
  }

  sseDataPayloads(text).forEach((payload, index) => {
    const event = parseJsonOption(payload)

    if (Option.isSome(event)) {
      scanJson(event.value, `${location}.events[${index}]`, issues)
    }
  })
}

const lossyText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

const chunkBytes = (chunk: WireChunk): Uint8Array =>
  Predicate.isString(chunk)
    ? new TextEncoder().encode(chunk)
    : Option.getOrElse(decodeBase64Bytes(chunk.base64), () => new Uint8Array())

const concatBytes = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0

  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }

  return joined
}

const scanStream = (
  chunks: ReadonlyArray<WireChunk>,
  location: string,
  issues: IssueSink
): void => {
  const parts = chunks.map(chunkBytes)

  parts.forEach((bytes, index) => scanText(lossyText(bytes), `${location}[${index}]`, issues))

  // The reassembled stream catches secrets split across chunks and JSON
  // credential fields inside SSE events. Bytes are decoded non-fatally.
  scanPayload(lossyText(concatBytes(parts)), location, issues)
}

const uniqueIssues = (issues: IssueSink): ReadonlyArray<FixtureSecretIssue> => {
  const seen = new Set<string>()

  return issues.filter(issue => {
    const key = `${issue.kind} ${issue.location}`

    if (seen.has(key)) {
      return false
    }

    seen.add(key)

    return true
  })
}

/**
 * Pure secret scan. Flags credential headers, bearer tokens, common API-key
 * prefixes, JWTs, private keys, credential query/form parameters, and
 * credential JSON fields anywhere in the fixture: metadata, URLs, headers,
 * request bodies, response bodies (text or decodable base64), each stream
 * chunk, and the reassembled stream (so a secret split across chunks is still
 * found). JSON bodies and SSE `data:` payloads get the credential-field scan.
 * Issues name locations only. Returns an empty array when clean.
 */
export const scanFixtureForSecrets = (fixture: WireFixture): ReadonlyArray<FixtureSecretIssue> => {
  const issues: IssueSink = []

  scanText(fixture.id, 'id', issues)
  scanText(fixture.caseId, 'caseId', issues)
  scanText(fixture.account, 'account', issues)
  scanUrl(fixture.endpoint, 'endpoint', issues)

  if (fixture.model !== undefined) {
    scanText(fixture.model, 'model', issues)
  }

  if (fixture.note !== undefined) {
    scanText(fixture.note, 'note', issues)
  }

  fixture.exchanges.forEach((exchange, index) => {
    const base = `exchanges[${index}]`
    const requestBody = exchange.request.body

    scanUrl(exchange.request.url, `${base}.request.url`, issues)
    scanHeaders(exchange.request.headers, `${base}.request.headers`, issues)

    if (Predicate.isString(requestBody)) {
      scanPayload(requestBody, `${base}.request.body`, issues)
    } else if (requestBody !== undefined) {
      scanJson(requestBody, `${base}.request.body`, issues)
    }

    const response = exchange.response

    scanHeaders(response.headers, `${base}.response.headers`, issues)

    if (isWireStreamResponse(response)) {
      scanStream(response.chunks, `${base}.response.chunks`, issues)
    } else if (isWireBase64BodyResponse(response)) {
      const bytes = decodeBase64Bytes(response.bodyBase64)

      if (Option.isSome(bytes)) {
        scanPayload(lossyText(bytes.value), `${base}.response.bodyBase64`, issues)
      }
    } else {
      scanPayload(response.body, `${base}.response.body`, issues)
    }
  })

  return uniqueIssues(issues)
}
