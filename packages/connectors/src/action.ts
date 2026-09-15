import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ConnectorError } from './error.ts'
import type { ActionResult } from './result.ts'
import type { ConnectorIntegration } from './integration.ts'

type ActionInputSchema = Schema.Schema<unknown> & { readonly DecodingServices: never }

type ActionOutputSchema = Schema.Schema<unknown> & { readonly EncodingServices: never }

export type ConnectorActionAccess = 'read' | 'write' | 'destructive'

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
  readonly access?: ConnectorActionAccess
  readonly inputSchema: ActionInputSchema
  readonly outputSchema: ActionOutputSchema
  readonly execute: (
    input: UnknownActionExecutionInput
  ) => Effect.Effect<ActionResult<unknown>, Error | ConnectorError, Env>
}

export type TypedConnectorAction<
  InputSchema extends ActionInputSchema,
  Output,
  Env = never,
  Error = never
> = ConnectorAction<Env, Error> & {
  readonly inputSchema: InputSchema
  readonly outputSchema: Schema.Schema<Output> & { readonly EncodingServices: never }
  /** Validates decoded input on the type side, without replaying wire transforms.
   * Implementations remain responsible for validating external output data. */
  readonly executeTyped: (
    input: ActionExecutionInput<InputSchema['Type']>
  ) => Effect.Effect<ActionResult<Output>, Error | ConnectorError, Env>
}

export type DefineActionOptions<InputSchema extends ActionInputSchema, Output, Env, Error> = {
  readonly id: string
  readonly description?: string
  readonly access?: ConnectorActionAccess
  readonly inputSchema: InputSchema
  readonly outputSchema: Schema.Schema<Output> & { readonly EncodingServices: never }
  readonly execute: (
    input: ActionExecutionInput<InputSchema['Type']>
  ) => Effect.Effect<ActionResult<Output>, Error | ConnectorError, Env>
}

const validationError = (actionId: string, error: Schema.SchemaError) =>
  new ConnectorError({
    cause: 'validation_failed',
    message: `Invalid input for action: ${actionId}`,
    actionId,
    underlying: error
  })

type ConnectorActionPrefixFields = {
  readonly id: string
  description?: string
  access?: ConnectorActionAccess
}

export const defineAction = <
  InputSchema extends ActionInputSchema,
  Output,
  Env = never,
  Error = never
>(
  options: DefineActionOptions<InputSchema, Output, Env, Error>
): TypedConnectorAction<InputSchema, Output, Env, Error> =>
  (() => {
    const fields: ConnectorActionPrefixFields = {
      id: options.id,
      description: options.description
    }

    if (options.access !== undefined) {
      fields.access = options.access
    }

    const run = (
      input: UnknownActionExecutionInput,
      schema: Schema.Schema<InputSchema['Type']> & { readonly DecodingServices: never }
    ): Effect.Effect<ActionResult<Output>, Error | ConnectorError, Env> =>
      Schema.decodeUnknownEffect(schema)(input.input).pipe(
        Effect.mapError(error => validationError(options.id, error)),
        Effect.flatMap(params =>
          options.execute({
            integration: input.integration,
            input: params
          })
        )
      )

    return {
      ...fields,
      inputSchema: options.inputSchema,
      outputSchema: options.outputSchema,
      execute: input => run(input, options.inputSchema),
      executeTyped: input => run(input, Schema.toType(options.inputSchema))
    }
  })()
