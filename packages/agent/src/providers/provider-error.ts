import { Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ProviderErrorInfo,
  type AgentErrorCode,
  type ProviderFailureKind,
  type ProviderStreamDiagnostics
} from '@yolk-sdk/agent/protocol'

type HeaderMap = Readonly<Record<string, string>>

type ProviderFailureInput = {
  readonly provider: string
  readonly status?: number
  readonly headers?: HeaderMap
  readonly body?: string
  readonly message?: string
  readonly providerCode?: string
  /**
   * Further structured codes, in order, consulted when `providerCode` names no kind: Anthropic
   * reports the specific `details.error_code` as `providerCode` and classifies from `error.type`.
   * They are never reported.
   */
  readonly kindCodes?: ReadonlyArray<string>
  /**
   * Request values the provider may echo back in its error text (the requested model id, the
   * Gateway's `param.modelId`). They are removed from `message` and the decoded `body` before the
   * text fallback, so a model id containing words such as "overload" or "rate_limit" never decides
   * the failure kind. Values shorter than three characters are ignored.
   */
  readonly echoedValues?: ReadonlyArray<string>
  readonly fallbackKind?: ProviderFailureKind
  /** Quota reset already parsed by the vendor adapter; see `ProviderErrorInfo.quotaResetsAtMs`. */
  readonly quotaResetsAtMs?: number
  /** Current time for HTTP-date `Retry-After` values; defaults to `Date.now()`. */
  readonly nowMs?: number
}

type ProviderErrorInfoInput = {
  readonly provider: string
  readonly kind: ProviderFailureKind
  readonly status?: number
  readonly providerCode?: string
  readonly retryAfterMs?: number
  readonly quotaResetsAtMs?: number
  readonly stream?: ProviderStreamDiagnostics
}

export type ProviderLlmErrorCause = Extract<
  AgentErrorCode,
  'provider_error' | 'rate_limit' | 'overloaded' | 'context_overflow' | 'invalid_response'
>

const numericDelayMs = (value: number) =>
  Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined

const headerValue = (headers: HeaderMap, name: string) => {
  const lowerName = name.toLowerCase()

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return value
    }
  }

  return undefined
}

export const parseRetryAfterMs = (value: string | undefined) => {
  if (value === undefined) {
    return undefined
  }

  return numericDelayMs(Number(value.trim()))
}

/** `Retry-After` as delta-seconds or an HTTP-date relative to `nowMs` (default `Date.now()`). */
export const parseRetryAfter = (value: string | undefined, nowMs?: number) => {
  if (value === undefined) {
    return undefined
  }

  const trimmed = value.trim()
  const seconds = Number(trimmed)
  const secondsDelay = numericDelayMs(seconds * 1000)

  if (secondsDelay !== undefined) {
    return secondsDelay
  }

  const timestamp = Date.parse(trimmed)

  if (Number.isNaN(timestamp)) {
    return undefined
  }

  return numericDelayMs(timestamp - (nowMs ?? Date.now()))
}

export const retryAfterMsFromHeaders = (headers: HeaderMap | undefined, nowMs?: number) => {
  if (headers === undefined) {
    return undefined
  }

  return (
    parseRetryAfterMs(headerValue(headers, 'retry-after-ms')) ??
    parseRetryAfter(headerValue(headers, 'retry-after'), nowMs)
  )
}

const kindFromStatus = (status: number | undefined): ProviderFailureKind | undefined => {
  if (status === undefined) {
    return undefined
  }

  if (status === 429) {
    return 'rate_limit'
  }

  if (status === 529) {
    return 'overloaded'
  }

  if (status === 413) {
    return 'context_overflow'
  }

  if (status === 401 || status === 403) {
    return 'auth'
  }

  // A request timeout: the request never got an answer, so it is a transport failure.
  if (status === 408) {
    return 'network'
  }

  if (status >= 500) {
    return 'server_error'
  }

  return undefined
}

/**
 * The request values an error envelope's `param` echoes: the string fields of an object (the
 * Gateway's `{ modelId }`). A string `param` (OpenAI `'input'`, `'messages'`) names the rejected
 * parameter, not a value the request sent, so it echoes nothing; so does anything else.
 */
export const echoedParamValues = (param: unknown): ReadonlyArray<string> =>
  Predicate.isObject(param) ? Object.values(param).filter(Predicate.isString) : []

/** Shorter echoed values could match inside ordinary words, so they are never removed. */
const minEchoedValueLength = 3

const JsonFromString = Schema.fromJsonString(Schema.Json)

const isJsonArray = (value: Schema.JsonArray | Schema.JsonObject): value is Schema.JsonArray =>
  Array.isArray(value)

/**
 * The string values of a decoded JSON body (its keys and the `param` subtree, which holds request
 * values, left out), so echoed values compare against decoded text, never JSON escapes.
 */
const jsonStrings = (value: Schema.Json): ReadonlyArray<string> => {
  if (Predicate.isString(value)) {
    return [value]
  }

  if (value === null || Predicate.isNumber(value) || Predicate.isBoolean(value)) {
    return []
  }

  if (isJsonArray(value)) {
    return value.flatMap(item => jsonStrings(item))
  }

  return Object.entries(value).flatMap(([key, field]) =>
    key === 'param' ? [] : jsonStrings(field)
  )
}

/** A JSON body as its decoded strings; any other body as its text. */
const bodyText = (body: string): string =>
  Option.match(Schema.decodeUnknownOption(JsonFromString)(body), {
    onNone: () => body,
    onSome: json => jsonStrings(json).join(' ')
  })

/** The free text of a failure, lower-cased, with every echoed request value removed. */
const scannedText = (input: ProviderFailureInput) =>
  (input.echoedValues ?? []).reduce(
    (text, value) => {
      const echoed = value.trim().toLowerCase()

      return echoed.length < minEchoedValueLength ? text : text.replaceAll(echoed, ' ')
    },
    [input.message, input.body === undefined ? undefined : bodyText(input.body)]
      .filter(value => value !== undefined)
      .join(' ')
      .toLowerCase()
  )

const kindFromSignal = (signal: string): ProviderFailureKind | undefined => {
  if (
    signal.includes('rate_limit') ||
    signal.includes('rate limit') ||
    signal.includes('too_many_requests') ||
    signal.includes('too many request')
  ) {
    return 'rate_limit'
  }

  if (
    signal.includes('overloaded_error') ||
    signal.includes('overloaded') ||
    signal.includes('overload') ||
    signal.includes('service unavailable')
  ) {
    return 'overloaded'
  }

  if (
    signal.includes('context_length') ||
    signal.includes('context length') ||
    signal.includes('context_window_exceeded') ||
    signal.includes('exceeds the context window') ||
    signal.includes('context window exceeded') ||
    signal.includes('context_overflow') ||
    signal.includes('context overflow') ||
    signal.includes('prompt is too long') ||
    signal.includes('input is too long') ||
    signal.includes('too many tokens') ||
    signal.includes('input_length_error')
  ) {
    return 'context_overflow'
  }

  return undefined
}

export const providerFailureRetryable = (kind: ProviderFailureKind) => {
  switch (kind) {
    case 'rate_limit':
    case 'overloaded':
    case 'server_error':
    case 'network':
    case 'stream':
      return true
    case 'auth':
    case 'context_overflow':
    case 'invalid_response':
    case 'unknown':
      return false
  }
}

/**
 * Classify from structured fields first: the vendor's `providerCode` (`error.type`/`code`), then
 * its `kindCodes`, when one names a kind, then the HTTP status. Free text (`message`, `body`, echoed request values removed)
 * is the fallback when no status exists (stream error events), and otherwise only refines the
 * status: it may name a non-retryable kind (an Anthropic 400 "prompt is too long" is
 * `context_overflow`) or a more specific retryable one for a retryable status (a 503 "service
 * unavailable" is `overloaded`), but never makes a failure retryable that its status (a 404 model
 * error, a 401) leaves non-retryable.
 */
export const providerFailureKind = (input: ProviderFailureInput): ProviderFailureKind => {
  for (const code of [input.providerCode, ...(input.kindCodes ?? [])]) {
    const fromCode = code === undefined ? undefined : kindFromSignal(code.toLowerCase())

    if (fromCode !== undefined) {
      return fromCode
    }
  }

  const fromStatus = kindFromStatus(input.status)
  const fromText = kindFromSignal(scannedText(input))

  if (
    fromText !== undefined &&
    (input.status === undefined ||
      !providerFailureRetryable(fromText) ||
      (fromStatus !== undefined && providerFailureRetryable(fromStatus)))
  ) {
    return fromText
  }

  return fromStatus ?? input.fallbackKind ?? 'unknown'
}

export const providerFailureCause = (kind: ProviderFailureKind): ProviderLlmErrorCause => {
  switch (kind) {
    case 'rate_limit':
      return 'rate_limit'
    case 'overloaded':
      return 'overloaded'
    case 'context_overflow':
      return 'context_overflow'
    case 'invalid_response':
      return 'invalid_response'
    case 'auth':
    case 'network':
    case 'server_error':
    case 'stream':
    case 'unknown':
      return 'provider_error'
  }
}

type ProviderErrorInfoFields = {
  provider: ProviderErrorInfoInput['provider']
  kind: ProviderErrorInfoInput['kind']
  status?: ProviderErrorInfoInput['status']
  providerCode?: ProviderErrorInfoInput['providerCode']
  retryAfterMs?: ProviderErrorInfoInput['retryAfterMs']
  quotaResetsAtMs?: ProviderErrorInfoInput['quotaResetsAtMs']
  stream?: ProviderErrorInfoInput['stream']
}

export const providerErrorInfo = (input: ProviderErrorInfoInput) =>
  ProviderErrorInfo.make(
    (() => {
      const fields: ProviderErrorInfoFields = {
        provider: input.provider,
        kind: input.kind
      }

      if (input.status !== undefined) {
        fields.status = input.status
      }

      if (input.providerCode !== undefined) {
        fields.providerCode = input.providerCode
      }

      if (input.retryAfterMs !== undefined) {
        fields.retryAfterMs = input.retryAfterMs
      }

      if (input.quotaResetsAtMs !== undefined) {
        fields.quotaResetsAtMs = input.quotaResetsAtMs
      }

      if (input.stream !== undefined) {
        fields.stream = input.stream
      }

      return fields
    })()
  )

export const classifyProviderFailure = (input: ProviderFailureInput) => {
  const kind = providerFailureKind(input)

  return providerErrorInfo(
    (() => {
      const fields: ProviderErrorInfoFields = {
        provider: input.provider,
        kind
      }

      if (input.status !== undefined) {
        fields.status = input.status
      }

      if (input.providerCode !== undefined) {
        fields.providerCode = input.providerCode
      }

      if (input.headers !== undefined) {
        fields.retryAfterMs = retryAfterMsFromHeaders(input.headers, input.nowMs)
      }

      if (input.quotaResetsAtMs !== undefined && kind === 'rate_limit') {
        fields.quotaResetsAtMs = input.quotaResetsAtMs
      }

      return fields
    })()
  )
}
