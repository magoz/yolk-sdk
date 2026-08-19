import * as Schema from 'effect/Schema'

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))
const PositiveNumber = Schema.Number.pipe(Schema.check(Schema.isGreaterThan(0)))
const isCanonicalInstant = (value: string) => {
  const date = new Date(value)

  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

export const ProviderSubscriptionUsageInstant = NonEmptyTrimmedString.pipe(
  Schema.check(
    Schema.makeFilter(isCanonicalInstant, {
      identifier: 'ProviderSubscriptionUsageInstant'
    })
  )
)

export const ProviderSubscriptionUsagePercent = Schema.Number.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.check(Schema.isLessThanOrEqualTo(100))
)

export class ProviderSubscriptionUsageWindow extends Schema.Class<ProviderSubscriptionUsageWindow>(
  'ProviderSubscriptionUsageWindow'
)({
  id: NonEmptyTrimmedString,
  usedPercent: ProviderSubscriptionUsagePercent,
  resetsAt: Schema.optional(ProviderSubscriptionUsageInstant),
  resetsAfterSeconds: Schema.optional(PositiveNumber),
  windowDurationMinutes: Schema.optional(PositiveNumber)
}) {}

export class ProviderSubscriptionUsageSnapshot extends Schema.Class<ProviderSubscriptionUsageSnapshot>(
  'ProviderSubscriptionUsageSnapshot'
)({
  provider: NonEmptyTrimmedString,
  fetchedAt: ProviderSubscriptionUsageInstant,
  windows: Schema.Chunk(ProviderSubscriptionUsageWindow)
}) {}

export class ProviderSubscriptionUsageRequestError extends Schema.TaggedErrorClass<ProviderSubscriptionUsageRequestError>()(
  'ProviderSubscriptionUsageRequestError',
  {
    provider: Schema.String,
    category: Schema.Literals(['timeout', 'network'])
  }
) {}

export class ProviderSubscriptionUsageResponseError extends Schema.TaggedErrorClass<ProviderSubscriptionUsageResponseError>()(
  'ProviderSubscriptionUsageResponseError',
  {
    provider: Schema.String,
    category: Schema.Literals(['http', 'invalid_response', 'redirect']),
    status: Schema.optional(Schema.Number)
  }
) {}

export class ProviderSubscriptionUsageAuthError extends Schema.TaggedErrorClass<ProviderSubscriptionUsageAuthError>()(
  'ProviderSubscriptionUsageAuthError',
  {
    provider: Schema.String,
    status: Schema.Number
  }
) {}

export class ProviderSubscriptionUsageRateLimitError extends Schema.TaggedErrorClass<ProviderSubscriptionUsageRateLimitError>()(
  'ProviderSubscriptionUsageRateLimitError',
  {
    provider: Schema.String,
    retryAfterMs: Schema.optional(Schema.Number)
  }
) {}

export class ProviderSubscriptionUsageConfigurationError extends Schema.TaggedErrorClass<ProviderSubscriptionUsageConfigurationError>()(
  'ProviderSubscriptionUsageConfigurationError',
  {
    provider: Schema.String,
    reason: Schema.Literals([
      'invalid_request_timeout',
      'missing_account_id',
      'missing_client_version',
      'missing_xai_user_id',
      'provider_mismatch'
    ])
  }
) {}

export type ProviderSubscriptionUsageError =
  | ProviderSubscriptionUsageRequestError
  | ProviderSubscriptionUsageResponseError
  | ProviderSubscriptionUsageAuthError
  | ProviderSubscriptionUsageRateLimitError
  | ProviderSubscriptionUsageConfigurationError
