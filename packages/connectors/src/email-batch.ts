import * as Schema from 'effect/Schema'

/**
 * Shared per-message batch outcome contract for email providers.
 *
 * This module owns provider-independent batch shapes only: ID-list validation,
 * per-ID status/code items, and exact summary counts. It must not import
 * provider implementations, OAuth slots, HTTP ports, or host policy. Generic
 * IMAP move metadata (`EmailBatchMoveResultItem`/`EmailBatchMoveOutput`) stays
 * in `email/index.ts` because its `folder` is an IMAP folder name, not a
 * provider-native destination.
 */

const EmailBatchMessageIdElement = Schema.Trimmed.check(Schema.isNonEmpty())

export const EmailBatchMessageIds = Schema.Array(EmailBatchMessageIdElement).check(
  Schema.isLengthBetween(1, 100),
  Schema.isUnique()
)

export type EmailBatchMessageIds = typeof EmailBatchMessageIds.Type

export const EmailBatchOperationStatus = Schema.Literals([
  'succeeded',
  'failed',
  'unknown',
  'not_attempted'
])

export type EmailBatchOperationStatus = typeof EmailBatchOperationStatus.Type

/**
 * Sanitized connector-owned result codes only (`[a-z0-9][a-z0-9._-]{0,127}`).
 * Never expose provider messages, bodies, headers, URLs, or credentials.
 */
export const EmailBatchResultCode = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/)
)

export type EmailBatchResultCode = typeof EmailBatchResultCode.Type

export class EmailBatchResultItem extends Schema.Class<EmailBatchResultItem>(
  'EmailBatchResultItem'
)({
  messageId: EmailBatchMessageIdElement,
  status: EmailBatchOperationStatus,
  code: Schema.optional(EmailBatchResultCode)
}) {}

const EmailBatchCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export class EmailBatchSummary extends Schema.Class<EmailBatchSummary>('EmailBatchSummary')({
  requested: EmailBatchCount,
  succeeded: EmailBatchCount,
  failed: EmailBatchCount,
  unknown: EmailBatchCount,
  notAttempted: EmailBatchCount
}) {}

export class EmailBatchOperationOutput extends Schema.Class<EmailBatchOperationOutput>(
  'EmailBatchOperationOutput'
)({
  results: Schema.Array(EmailBatchResultItem),
  summary: EmailBatchSummary
}) {}

export type EmailBatchResultItemInput = {
  readonly messageId: string
  readonly status: EmailBatchOperationStatus
  readonly code?: EmailBatchResultCode
}

/**
 * Build an exact summary from final per-ID items. Counts are derived from the
 * items themselves, never from the number submitted.
 */
export const makeEmailBatchSummary = (
  results: ReadonlyArray<{ readonly status: EmailBatchOperationStatus }>
): EmailBatchSummary => {
  let succeeded = 0
  let failed = 0
  let unknown = 0
  let notAttempted = 0

  for (const result of results) {
    if (result.status === 'succeeded') succeeded += 1
    else if (result.status === 'failed') failed += 1
    else if (result.status === 'unknown') unknown += 1
    else notAttempted += 1
  }

  return EmailBatchSummary.make({
    requested: results.length,
    succeeded,
    failed,
    unknown,
    notAttempted
  })
}

/**
 * Verify complete ordered per-ID coverage: exactly one item per requested ID
 * in input order, with no duplicates or foreign IDs, and a matching summary.
 */
export const hasCompleteBatchCoverage = (input: {
  readonly requestedIds: ReadonlyArray<string>
  readonly results: ReadonlyArray<{ readonly messageId: string; readonly status: string }>
  readonly summary: {
    readonly requested: number
    readonly succeeded: number
    readonly failed: number
    readonly unknown: number
    readonly notAttempted: number
  }
}): boolean => {
  if (input.results.length !== input.requestedIds.length) return false

  const counts = { succeeded: 0, failed: 0, unknown: 0, notAttempted: 0 }

  for (const [index, result] of input.results.entries()) {
    if (result.messageId !== input.requestedIds[index]) return false

    if (result.status === 'succeeded') counts.succeeded += 1
    else if (result.status === 'failed') counts.failed += 1
    else if (result.status === 'unknown') counts.unknown += 1
    else if (result.status === 'not_attempted') counts.notAttempted += 1
    else return false
  }

  return (
    input.summary.requested === input.requestedIds.length &&
    input.summary.succeeded === counts.succeeded &&
    input.summary.failed === counts.failed &&
    input.summary.unknown === counts.unknown &&
    input.summary.notAttempted === counts.notAttempted
  )
}
