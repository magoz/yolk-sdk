import { Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'

type HeaderMap = Readonly<Record<string, string>>

const headerValue = (headers: HeaderMap, name: string) => {
  const lowerName = name.toLowerCase()

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return value.trim()
    }
  }

  return ''
}

const status = (headers: HeaderMap, window: string) =>
  headerValue(headers, `anthropic-ratelimit-unified${window}-status`).toLowerCase()

const isAllowed = (value: string) => value === 'allowed' || value === 'allowed_warning'

const isHealthyUtilization = (raw: string) => {
  if (raw === '') {
    return false
  }

  const utilization = Number(raw)

  return Number.isFinite(utilization) && utilization >= 0 && utilization < 1
}

/** Unix seconds (possibly fractional), RFC 3339, or an HTTP date; epoch milliseconds. */
const parseResetMs = (raw: string): number | undefined => {
  if (raw === '') {
    return undefined
  }

  const seconds = Number(raw)

  if (Number.isFinite(seconds)) {
    return seconds > 0 ? Math.floor(seconds * 1000) : undefined
  }

  const timestamp = Date.parse(raw)

  return Number.isNaN(timestamp) ? undefined : timestamp
}

type ClaudeWindowStatuses = {
  readonly unified: string
  readonly fiveHour: string
  readonly sevenDay: string
  readonly sevenDayModel: string
}

/**
 * A rejection caused only by overage or a model-scoped weekly window while the shared windows still
 * allow requests: the account itself is not exhausted (CLIProxyAPI `isOverageOrFableOnlyRejection`).
 */
const isOverageOnlyRejection = (headers: HeaderMap, statuses: ClaudeWindowStatuses) => {
  if (statuses.fiveHour === 'rejected' || statuses.sevenDay === 'rejected') {
    return false
  }

  const overageRejected =
    statuses.sevenDayModel === 'rejected' ||
    headerValue(headers, 'anthropic-ratelimit-unified-overage-status').toLowerCase() ===
      'rejected' ||
    headerValue(headers, 'anthropic-ratelimit-unified-overage-disabled-reason') !== '' ||
    headerValue(headers, 'anthropic-ratelimit-unified-representative-claim')
      .toLowerCase()
      .includes('overage')

  if (!overageRejected) {
    return false
  }

  const fiveHourAllowed = isAllowed(statuses.fiveHour)
  const sevenDayAllowed = isAllowed(statuses.sevenDay)

  if (fiveHourAllowed && sevenDayAllowed) {
    return true
  }

  if (
    sevenDayAllowed &&
    statuses.fiveHour === '' &&
    isHealthyUtilization(headerValue(headers, 'anthropic-ratelimit-unified-5h-utilization'))
  ) {
    return true
  }

  return (
    fiveHourAllowed &&
    statuses.sevenDay === '' &&
    isHealthyUtilization(headerValue(headers, 'anthropic-ratelimit-unified-7d-utilization'))
  )
}

/**
 * When an exhausted Claude subscription quota resets, from the unified rate-limit headers of a
 * `429`: the latest reset among the rejected windows (five-hour, weekly, model weekly, unified),
 * ignoring resets that are not in the future. Undefined for transient or overage-only rejections.
 * Mirrors CLIProxyAPI `ParseClaudeRateLimitReset` without its fuzz.
 */
export const anthropicClaudeQuotaResetsAtMs = (input: {
  readonly status: number
  readonly headers: HeaderMap
  readonly nowMs: number
}): number | undefined => {
  if (input.status !== 429) {
    return undefined
  }

  const { headers } = input

  const statuses: ClaudeWindowStatuses = {
    unified: status(headers, ''),
    fiveHour: status(headers, '-5h'),
    sevenDay: status(headers, '-7d'),
    sevenDayModel: status(headers, '-7d_oi')
  }

  const overageOnly = isOverageOnlyRejection(headers, statuses)

  const unifiedRejected =
    !overageOnly &&
    (statuses.unified === 'rejected' ||
      statuses.fiveHour === 'rejected' ||
      statuses.sevenDay === 'rejected' ||
      statuses.sevenDayModel === 'rejected' ||
      (statuses.unified === '' && !isAllowed(statuses.fiveHour) && !isAllowed(statuses.sevenDay)))

  const resetHeaders = [
    statuses.fiveHour === 'rejected' ? 'anthropic-ratelimit-unified-5h-reset' : undefined,
    statuses.sevenDay === 'rejected' ? 'anthropic-ratelimit-unified-7d-reset' : undefined,
    statuses.sevenDayModel === 'rejected' && !overageOnly
      ? 'anthropic-ratelimit-unified-7d_oi-reset'
      : undefined,
    unifiedRejected ? 'anthropic-ratelimit-unified-reset' : undefined
  ].filter(Predicate.isNotUndefined)

  const resets = resetHeaders.flatMap(name => {
    const reset = parseResetMs(headerValue(headers, name))

    return reset !== undefined && reset > input.nowMs ? [reset] : []
  })

  return resets.length === 0 ? undefined : Math.max(...resets)
}

const UsageLimitError = Schema.Struct({
  type: Schema.String,
  resets_at: Schema.optional(Schema.Unknown),
  resets_in_seconds: Schema.optional(Schema.Unknown)
})

const ErrorEnvelope = Schema.Struct({ error: Schema.optional(Schema.Unknown) })

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const decodeUsageLimitError = Schema.decodeUnknownOption(UsageLimitError)

const decodeErrorEnvelope = Schema.decodeUnknownOption(ErrorEnvelope)

const positiveInteger = (value: unknown) =>
  Predicate.isNumber(value) && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined

/**
 * When an exhausted ChatGPT Codex quota resets, from a `429` body whose error type is
 * `usage_limit_reached`: `resets_at` (unix seconds, when in the future), else `now +
 * resets_in_seconds`. Undefined for other bodies, including transient `rate_limit_exceeded`.
 * Mirrors CLIProxyAPI `parseCodexRetryAfter`.
 */
export const openAiCodexQuotaResetsAtMs = (input: {
  readonly status: number
  readonly body: string
  readonly nowMs: number
}): number | undefined => {
  if (input.status !== 429) {
    return undefined
  }

  const parsed = decodeJson(input.body)

  if (Option.isNone(parsed)) {
    return undefined
  }

  const nested = decodeErrorEnvelope(parsed.value).pipe(
    Option.flatMap(envelope => Option.fromUndefinedOr(envelope.error))
  )

  for (const candidate of [nested, Option.some(parsed.value)]) {
    const error = candidate.pipe(Option.flatMap(decodeUsageLimitError))

    if (Option.isNone(error) || error.value.type.trim().toLowerCase() !== 'usage_limit_reached') {
      continue
    }

    const resetsAt = positiveInteger(error.value.resets_at)

    if (resetsAt !== undefined && resetsAt * 1000 > input.nowMs) {
      return resetsAt * 1000
    }

    const resetsIn = positiveInteger(error.value.resets_in_seconds)

    if (resetsIn !== undefined) {
      return input.nowMs + resetsIn * 1000
    }
  }

  return undefined
}
