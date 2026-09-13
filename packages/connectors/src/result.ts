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

const ActionSuccess = Schema.TaggedStruct('Success', {
  value: Schema.Unknown
})

const ActionFailure = Schema.TaggedStruct('Failure', {
  error: Schema.Unknown
})

export type ActionResult<Output> =
  | {
      readonly _tag: 'Success'
      readonly value: Output
    }
  | {
      readonly _tag: 'Failure'
      readonly error: ProviderFailure
    }

const providerFailure = (failure: ProviderFailure | ProviderFailureInput): ProviderFailure =>
  failure instanceof ProviderFailure ? failure : ProviderFailure.make(failure)

const actionResultSuccess = <Output>(value: Output): ActionResult<Output> => ({
  ...ActionSuccess.make({ value }),
  value
})

const actionResultFailure = (
  failure: ProviderFailure | ProviderFailureInput
): ActionResult<never> => {
  const error = providerFailure(failure)

  return {
    ...ActionFailure.make({ error }),
    error
  }
}

export const ActionResult = {
  success: actionResultSuccess,
  failure: actionResultFailure
}
