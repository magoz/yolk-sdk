import * as Schema from 'effect/Schema'

export class LLMError extends Schema.TaggedErrorClass<LLMError>()('LLMError', {
  cause: Schema.Literals(['provider_error', 'rate_limit', 'context_overflow', 'invalid_response']),
  message: Schema.String,
  retryable: Schema.Boolean
}) {}

export class FauxExhaustedError extends Schema.TaggedErrorClass<FauxExhaustedError>()(
  'FauxExhaustedError',
  {
    message: Schema.String
  }
) {}

export class ToolError extends Schema.TaggedErrorClass<ToolError>()('ToolError', {
  tool: Schema.String,
  message: Schema.String,
  cause: Schema.Literals(['validation', 'execution', 'timeout', 'permission'])
}) {}

export class AbortError extends Schema.TaggedErrorClass<AbortError>()('AbortError', {
  reason: Schema.Literals(['user', 'system', 'max_turns'])
}) {}

export type HarnessError = LLMError | FauxExhaustedError | ToolError | AbortError
