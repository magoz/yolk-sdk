import * as Schema from 'effect/Schema'

export const SandboxInputErrorCause = Schema.Literals([
  'empty_command',
  'invalid_cwd',
  'invalid_timeout'
])
export type SandboxInputErrorCause = typeof SandboxInputErrorCause.Type

export class SandboxInputError extends Schema.TaggedErrorClass<SandboxInputError>()(
  'SandboxInputError',
  {
    cause: SandboxInputErrorCause,
    message: Schema.String
  }
) {}

export class SandboxConfigError extends Schema.TaggedErrorClass<SandboxConfigError>()(
  'SandboxConfigError',
  {
    message: Schema.String,
    cause: Schema.String
  }
) {}

export class SandboxExpiredError extends Schema.TaggedErrorClass<SandboxExpiredError>()(
  'SandboxExpiredError',
  {
    message: Schema.String,
    expiredAtMs: Schema.Number
  }
) {}

export class SandboxStateError extends Schema.TaggedErrorClass<SandboxStateError>()(
  'SandboxStateError',
  {
    message: Schema.String,
    cause: Schema.String,
    underlying: Schema.optional(Schema.Unknown)
  }
) {}

export class SandboxStateStoreError extends Schema.TaggedErrorClass<SandboxStateStoreError>()(
  'SandboxStateStoreError',
  {
    message: Schema.String,
    operation: Schema.String,
    underlying: Schema.optional(Schema.Unknown)
  }
) {}

export class SandboxProviderError extends Schema.TaggedErrorClass<SandboxProviderError>()(
  'SandboxProviderError',
  {
    provider: Schema.Literal('vercel'),
    operation: Schema.String,
    message: Schema.String,
    underlying: Schema.optional(Schema.Unknown)
  }
) {}

export type SandboxError =
  | SandboxInputError
  | SandboxConfigError
  | SandboxExpiredError
  | SandboxStateError
  | SandboxStateStoreError
  | SandboxProviderError

export const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)
