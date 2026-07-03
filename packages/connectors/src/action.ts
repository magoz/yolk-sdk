import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ConnectorError } from './error.ts'
import type { ActionResult } from './result.ts'
import type { ConnectorIntegration } from './integration.ts'

type ActionInputSchema = Schema.Schema<unknown> & { readonly DecodingServices: never }
type ActionOutputSchema = Schema.Schema<unknown> & { readonly EncodingServices: never }

export type ActionExecutionInput<Input> = {
  readonly integration: ConnectorIntegration
  readonly input: Input
}

export type UnknownActionExecutionInput = {
  readonly integration: ConnectorIntegration
  readonly input: unknown
}

export type ConnectorAction<Env = never, Error = never> = {
  readonly id: string
  readonly description?: string
  readonly inputSchema: ActionInputSchema
  readonly outputSchema: ActionOutputSchema
  readonly execute: (
    input: UnknownActionExecutionInput
  ) => Effect.Effect<ActionResult<unknown>, Error | ConnectorError, Env>
}

export type DefineActionOptions<InputSchema extends ActionInputSchema, Output, Env, Error> = {
  readonly id: string
  readonly description?: string
  readonly inputSchema: InputSchema
  readonly outputSchema: Schema.Schema<Output> & { readonly EncodingServices: never }
  readonly execute: (
    input: ActionExecutionInput<InputSchema['Type']>
  ) => Effect.Effect<ActionResult<Output>, Error | ConnectorError, Env>
}

const validationError = (actionId: string, error: unknown) =>
  new ConnectorError({
    cause: 'validation_failed',
    message: `Invalid input for action: ${actionId}`,
    actionId,
    underlying: error
  })

export const defineAction = <
  InputSchema extends ActionInputSchema,
  Output,
  Env = never,
  Error = never
>(
  options: DefineActionOptions<InputSchema, Output, Env, Error>
): ConnectorAction<Env, Error> => ({
  id: options.id,
  description: options.description,
  inputSchema: options.inputSchema,
  outputSchema: options.outputSchema,
  execute: input =>
    Schema.decodeUnknownEffect(options.inputSchema)(input.input).pipe(
      Effect.mapError(error => validationError(options.id, error)),
      Effect.flatMap(params =>
        options.execute({
          integration: input.integration,
          input: params
        })
      )
    )
})
