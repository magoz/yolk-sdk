import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk-sdk/agent/loop'
import {
  EmptyToolParams,
  toolJsonSchemaFromSchema,
  type InteractionActionHandler,
  type ModelVisibleToolError,
  type InteractionActionResult,
  type ToolAccess,
  type ToolModule,
  type ToolRegistration
} from './registry.ts'
import {
  InteractionActionDescriptor,
  InteractionValidationError,
  InteractionDescriptor,
  ToolDef,
  type ToolCall,
  type ToolJsonSchema
} from '@yolk-sdk/agent/protocol'

import { interactionJsonEquals } from '../protocol/tool.ts'

type SyncSchema = Schema.Schema<unknown> & { readonly DecodingServices: never }

export type { InteractionActionResult }

type InteractionCall<Params> = Omit<ToolCall, 'params'> & { readonly params: Params }

export type InteractionActionValidate<Context, Data = unknown> = (input: {
  readonly data: Data
  readonly context: Context
}) => Effect.Effect<void, InteractionValidationError | Schema.SchemaError>

export type InteractionActionExecute<Context, Data = unknown, Params = unknown> = (input: {
  readonly data: Data
  readonly context: Context
  readonly submissionId: string
  readonly call: InteractionCall<Params>
}) => Effect.Effect<InteractionActionResult, ToolError | ModelVisibleToolError>

export type InteractionActionDefinition<Context, Data = unknown, Params = unknown> = {
  readonly label: string
  readonly description?: string | undefined
  readonly validate?: InteractionActionValidate<Context, Data>
  readonly execute: InteractionActionExecute<Context, Data, Params>
}

/** Original schema decoding must preserve the person's exact JSON values, including
 * nested values. Transforms/defaults that change JSON are not supported in v1. */
const decodeExact = <S extends SyncSchema>(
  schema: S,
  input: unknown
): Effect.Effect<S['Type'], Schema.SchemaError | InteractionValidationError> =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(input).pipe(
    Effect.flatMap(decoded =>
      interactionJsonEquals(decoded, input)
        ? Effect.succeed(decoded)
        : Effect.fail(
            new InteractionValidationError({
              message: 'Interaction schemas must preserve exact JSON values'
            })
          )
    )
  )

export type MakeInteractionToolOptions<
  Context,
  CallSchema extends SyncSchema,
  ResponseSchema extends SyncSchema,
  ActionId extends string = string
> = {
  readonly name: string
  readonly description: string
  /** Host-declared tool access. An action click never bypasses host policy. */
  readonly access: ToolAccess
  /** Model-facing call params (proposal/context). Defaults to no params. */
  readonly callParameters?: CallSchema
  /** Original server Effect Schema validating JSON submitted values. Never lowered for execution. */
  readonly response: ResponseSchema
  /** Stable app-owned renderer key. Defaults to 'custom'. */
  readonly renderer?: string
  readonly title?: string
  readonly interactionDescription?: string
  /** Server-defined named actions. At least one action is required. */
  readonly actions: Readonly<
    Record<
      ActionId,
      InteractionActionDefinition<Context, ResponseSchema['Type'], CallSchema['Type']>
    >
  >
}

export type InteractionToolModule<Context> = ToolModule<Context>

type InteractionToolDefFields = {
  name: string
  description: string
  parameters: ReturnType<typeof toolJsonSchemaFromSchema>
  interaction: InteractionDescriptor
}

type InteractionActionDescriptorFields = {
  id: string
  label: string
  description?: string
}

type InteractionDescriptorFields = {
  kind: string
  title?: string
  description?: string
  schema?: ToolJsonSchema
  actions: readonly [InteractionActionDescriptor, ...Array<InteractionActionDescriptor>]
}

const interactionDescriptorFor = (options: {
  readonly renderer?: string
  readonly title?: string
  readonly interactionDescription?: string
  readonly schema?: ToolJsonSchema
  readonly actions: readonly [InteractionActionDescriptor, ...Array<InteractionActionDescriptor>]
}) => {
  const fields: InteractionDescriptorFields = {
    kind: options.renderer ?? 'custom',
    actions: options.actions
  }

  if (options.schema !== undefined) {
    fields.schema = options.schema
  }

  if (options.title !== undefined) {
    fields.title = options.title
  }

  if (options.interactionDescription !== undefined) {
    fields.description = options.interactionDescription
  }

  return InteractionDescriptor.make(fields)
}

/** Schema-backed action-backed interaction registration. The original Effect schemas own
 * server validation of call parameters and submitted values; ToolDef carries a
 * serializable descriptor (display labels only, never callbacks or permissions).
 * Interaction tools never take approval/background options, never complete through
 * direct dispatch, and execute the selected server handler only with an explicit
 * interaction reference admitted through the host receipt port.
 */
export const makeInteractionTool = <
  Context,
  CallSchema extends SyncSchema = typeof EmptyToolParams,
  ResponseSchema extends SyncSchema = SyncSchema,
  ActionId extends string = string
>(
  options: MakeInteractionToolOptions<Context, CallSchema, ResponseSchema, ActionId>
): ToolRegistration<Context> & { readonly actionIds: ReadonlyArray<ActionId> } => {
  const callSchema: SyncSchema = options.callParameters ?? EmptyToolParams

  const actionIds = Object.keys(options.actions).filter((id): id is ActionId =>
    Object.hasOwn(options.actions, id)
  )

  if (actionIds.length === 0) {
    throw new Error(`Interaction tool ${options.name} requires at least one action`)
  }

  const descriptors = actionIds.map(actionId => {
    const action = options.actions[actionId]

    if (action === undefined) {
      throw new Error(`Interaction tool ${options.name} is missing action ${actionId}`)
    }

    const fields: InteractionActionDescriptorFields = {
      id: actionId,
      label: action.label
    }

    if (action.description !== undefined) {
      fields.description = action.description
    }

    return InteractionActionDescriptor.make(fields)
  })

  const firstDescriptor = descriptors[0]

  if (firstDescriptor === undefined) {
    throw new Error(`Interaction tool ${options.name} requires at least one action`)
  }

  const descriptor = interactionDescriptorFor({
    renderer: options.renderer,
    title: options.title,
    interactionDescription: options.interactionDescription,
    schema: toolJsonSchemaFromSchema(options.response),
    actions: [firstDescriptor, ...descriptors.slice(1)]
  })

  const def = ToolDef.make(
    (() => {
      const fields: InteractionToolDefFields = {
        name: options.name,
        description: options.description,
        parameters: toolJsonSchemaFromSchema(callSchema),
        interaction: descriptor
      }

      return fields
    })()
  )

  const validateCall = (params: unknown) => decodeExact(callSchema, params).pipe(Effect.asVoid)

  const validateResponse = (data: unknown) =>
    decodeExact(options.response, data).pipe(Effect.asVoid)

  // Erase registration types only behind original-schema decoding wrappers. Handlers
  // receive inferred data/params, never unknown masquerading as schema-validated JSON.
  const actions: Record<string, InteractionActionHandler<Context>> = Object.fromEntries(
    actionIds.map(id => {
      const action = options.actions[id]

      const erased: InteractionActionHandler<Context> = {
        label: action.label,
        description: action.description,
        validate: ({ data, context }) =>
          decodeExact(options.response, data).pipe(
            Effect.flatMap(decoded => action.validate?.({ data: decoded, context }) ?? Effect.void)
          ),
        execute: ({ data, context, submissionId, call }) =>
          decodeExact(options.response, data).pipe(
            Effect.flatMap(decoded =>
              decodeExact(options.callParameters ?? EmptyToolParams, call.params).pipe(
                Effect.flatMap(params =>
                  action.execute({
                    data: decoded,
                    context,
                    submissionId,
                    call: { ...call, params }
                  })
                )
              )
            ),
            Effect.mapError(error =>
              error instanceof InteractionValidationError || error instanceof Schema.SchemaError
                ? new ToolError({ tool: options.name, cause: 'validation', message: error.message })
                : error
            )
          )
      }

      return [id, erased]
    })
  )

  const execute = (call: ToolCall) =>
    Effect.fail(
      new ToolError({
        tool: options.name,
        cause: 'unavailable',
        message: `Interaction tool \"${options.name}\" for call ${call.id} requires an accepted interaction and cannot execute directly.`
      })
    )

  return {
    def,
    actionIds,
    access: options.access,
    validate: call =>
      validateCall(call.params).pipe(
        Effect.asVoid,
        Effect.mapError(
          error =>
            new ToolError({
              tool: options.name,
              cause: 'validation',
              message: `Invalid ${options.name} arguments: ${error.message}`
            })
        )
      ),
    execute: ({ call }) => execute(call),
    interaction: { validateCall, validateResponse, actions }
  }
}

export const makeInteractionToolModule = <
  Context,
  CallSchema extends SyncSchema = typeof EmptyToolParams,
  ResponseSchema extends SyncSchema = SyncSchema,
  ActionId extends string = string
>(
  options: MakeInteractionToolOptions<Context, CallSchema, ResponseSchema, ActionId>
): InteractionToolModule<Context> => ({
  id: options.name,
  tools: [makeInteractionTool(options)]
})
