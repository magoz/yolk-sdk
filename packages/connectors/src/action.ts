import { Effect, Option } from 'effect'
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

/** One file an action yields (ADR 0009): standard base64 bytes the agent bridge turns into a
 * `FilePart`, so tool resolution stores them and the model only sees a `fileId`. */
export type ConnectorActionFile = {
  readonly base64: string
  readonly mimeType: string
  readonly filename?: string
}

/**
 * How the agent bridge splits an action output that carries file bytes: `schema` is the
 * model-facing output (the action output without the bytes, declared as the tool output) and
 * `split` returns that value plus the files. `connector.invoke` is unchanged and still returns the
 * full output to hosts.
 */
export type ConnectorActionFileOutput<Output> = {
  readonly schema: ActionOutputSchema
  readonly split: (output: Output) => {
    readonly value: unknown
    readonly files: ReadonlyArray<ConnectorActionFile>
  }
}

/** `ConnectorActionFileOutput` over an unknown output: `split` is `None` when the value is not
 * the action's output. */
export type UnknownConnectorActionFileOutput = {
  readonly schema: ActionOutputSchema
  readonly split: (output: unknown) => Option.Option<{
    readonly value: unknown
    readonly files: ReadonlyArray<ConnectorActionFile>
  }>
}

export type ConnectorAction<Env = never, Error = never> = {
  readonly id: string
  readonly description?: string
  readonly access?: ConnectorActionAccess
  readonly inputSchema: ActionInputSchema
  readonly outputSchema: ActionOutputSchema
  readonly fileOutput?: UnknownConnectorActionFileOutput
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
  /** Set when the output carries file bytes (ADR 0009). */
  readonly fileOutput?: ConnectorActionFileOutput<Output>
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
  fileOutput?: UnknownConnectorActionFileOutput
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

    const fileOutput = options.fileOutput

    if (fileOutput !== undefined) {
      const isOutput = Schema.is(Schema.toType(options.outputSchema))

      fields.fileOutput = {
        schema: fileOutput.schema,
        split: output => (isOutput(output) ? Option.some(fileOutput.split(output)) : Option.none())
      }
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
