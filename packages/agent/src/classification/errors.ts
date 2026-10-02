import * as Schema from 'effect/Schema'
import { ProviderErrorInfo } from '@yolk-sdk/agent/protocol'
import { ClassificationUsage } from './schema.ts'

/**
 * Why an answer does not fit its question:
 *
 * - `missing_answer`: a question has no answer.
 * - `unexpected_answer`: an answer names no question that was asked.
 * - `type_mismatch`: the answer's `type` is not the question's.
 * - `invalid_probability`: a probability is missing, not a number, non-finite, or outside `[0, 1]`.
 * - `invalid_confidence`: a confidence is not a finite number in `[0, 1]`.
 * - `invalid_choice`: a choice answer names no option of its question.
 * - `invalid_score`: a score answer has no finite `score`.
 * - `malformed_answer`: the answer is not an object.
 */
export const ClassificationAnswerIssueReason = Schema.Literals([
  'missing_answer',
  'unexpected_answer',
  'type_mismatch',
  'invalid_probability',
  'invalid_confidence',
  'invalid_choice',
  'invalid_score',
  'malformed_answer'
])

export type ClassificationAnswerIssueReason = typeof ClassificationAnswerIssueReason.Type

/** `malformed_response`: the response body is not the provider's documented envelope. */
export const ClassificationResponseIssue = Schema.Literals([
  'malformed_response',
  ...ClassificationAnswerIssueReason.literals
])

export type ClassificationResponseIssue = typeof ClassificationResponseIssue.Type

/** The request does not satisfy the classification contract; nothing was sent. */
export class ClassificationRequestInvalid extends Schema.TaggedError<ClassificationRequestInvalid>()(
  'ClassificationRequestInvalid',
  {
    message: Schema.String
  }
) {}

/**
 * The provider could not be reached or rejected the request. `message` is safe to show: it never
 * carries provider bodies, headers, or credentials. `provider` classifies the failure (status,
 * provider error code, retry delay).
 */
export class ClassificationProviderError extends Schema.TaggedError<ClassificationProviderError>()(
  'ClassificationProviderError',
  {
    message: Schema.String,
    retryable: Schema.Boolean,
    provider: ProviderErrorInfo
  }
) {}

/**
 * The provider answered, but the response or one of its answers does not fit the request.
 * `usage` is kept when the provider reported it, because the request was billed.
 */
export class ClassificationResponseInvalid extends Schema.TaggedError<ClassificationResponseInvalid>()(
  'ClassificationResponseInvalid',
  {
    message: Schema.String,
    /** Provider id, when a provider (not the typed `classify` check) found the issue. */
    provider: Schema.optional(Schema.String),
    reason: ClassificationResponseIssue,
    questionId: Schema.optional(Schema.String),
    usage: Schema.optional(ClassificationUsage)
  }
) {}

export type ClassificationError =
  | ClassificationRequestInvalid
  | ClassificationProviderError
  | ClassificationResponseInvalid
