import * as Schema from 'effect/Schema'

export class ProviderFailure extends Schema.Class<ProviderFailure>('ProviderFailure')({
  code: Schema.String,
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  retryAfterMs: Schema.optional(Schema.Number),
  underlying: Schema.optional(Schema.Unknown)
}) {}

export type ProviderFailureInput = {
  readonly code: string
  readonly message: string
  readonly status?: number
  readonly retryAfterMs?: number
  readonly underlying?: unknown
}

export type ActionResult<Output> =
  | {
      readonly _tag: 'Success'
      readonly value: Output
    }
  | {
      readonly _tag: 'Failure'
      readonly error: ProviderFailure
    }

export const ActionResult = {
  success: <Output>(value: Output): ActionResult<Output> => ({ _tag: 'Success', value }),
  failure: (failure: ProviderFailure | ProviderFailureInput): ActionResult<never> => ({
    _tag: 'Failure',
    error: failure instanceof ProviderFailure ? failure : ProviderFailure.make(failure)
  })
}
