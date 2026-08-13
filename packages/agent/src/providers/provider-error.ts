import {
  ProviderErrorInfo,
  type AgentErrorCode,
  type ProviderFailureKind
} from '@yolk-sdk/agent/protocol'

type HeaderMap = Readonly<Record<string, string>>

type ProviderFailureInput = {
  readonly provider: string
  readonly status?: number
  readonly headers?: HeaderMap
  readonly body?: string
  readonly message?: string
  readonly providerCode?: string
  readonly fallbackKind?: ProviderFailureKind
}

type ProviderErrorInfoInput = {
  readonly provider: string
  readonly kind: ProviderFailureKind
  readonly status?: number
  readonly providerCode?: string
  readonly retryAfterMs?: number
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

export const parseRetryAfter = (value: string | undefined) => {
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

  return numericDelayMs(timestamp - Date.now())
}

export const retryAfterMsFromHeaders = (headers: HeaderMap | undefined) => {
  if (headers === undefined) {
    return undefined
  }

  return (
    parseRetryAfterMs(headerValue(headers, 'retry-after-ms')) ??
    parseRetryAfter(headerValue(headers, 'retry-after'))
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

  if (status >= 500) {
    return 'server_error'
  }

  return undefined
}

const normalizedSignal = (input: ProviderFailureInput) =>
  [input.providerCode, input.message, input.body]
    .filter(value => value !== undefined)
    .join(' ')
    .toLowerCase()

const kindFromSignal = (input: ProviderFailureInput): ProviderFailureKind | undefined => {
  const signal = normalizedSignal(input)

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

export const providerFailureKind = (input: ProviderFailureInput): ProviderFailureKind =>
  kindFromSignal(input) ?? kindFromStatus(input.status) ?? input.fallbackKind ?? 'unknown'

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

export const providerErrorInfo = (input: ProviderErrorInfoInput) =>
  ProviderErrorInfo.make({
    provider: input.provider,
    kind: input.kind,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.providerCode === undefined ? {} : { providerCode: input.providerCode }),
    ...(input.retryAfterMs === undefined ? {} : { retryAfterMs: input.retryAfterMs })
  })

export const classifyProviderFailure = (input: ProviderFailureInput) => {
  const kind = providerFailureKind(input)

  return providerErrorInfo({
    provider: input.provider,
    kind,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.providerCode === undefined ? {} : { providerCode: input.providerCode }),
    ...(input.headers === undefined ? {} : { retryAfterMs: retryAfterMsFromHeaders(input.headers) })
  })
}
