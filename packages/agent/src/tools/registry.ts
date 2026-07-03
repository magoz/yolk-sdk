import { Array as Arr, Effect, Layer, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError, ToolExecutor } from '@yolk-sdk/agent/loop'
import {
  makeErrorToolResult,
  ToolDef,
  type ToolApprovalPolicy,
  type ToolCall,
  type ToolResult
} from '@yolk-sdk/agent/protocol'

export const ToolAccess = Schema.Literals(['read', 'write', 'destructive'])
export type ToolAccess = typeof ToolAccess.Type

export class ToolRegistryError extends Schema.TaggedErrorClass<ToolRegistryError>()(
  'ToolRegistryError',
  {
    message: Schema.String,
    cause: Schema.Literals(['duplicate_tool'])
  }
) {}

export const ModelVisibleToolErrorReason = Schema.Literals([
  'validation',
  'invalid_input',
  'permission',
  'denied',
  'not_found',
  'unavailable',
  'timeout'
])
export type ModelVisibleToolErrorReason = typeof ModelVisibleToolErrorReason.Type

export class ModelVisibleToolError extends Schema.TaggedErrorClass<ModelVisibleToolError>()(
  'ModelVisibleToolError',
  {
    tool: Schema.String,
    message: Schema.String,
    reason: ModelVisibleToolErrorReason,
    details: Schema.optional(Schema.Unknown)
  }
) {}

export const ModelVisibleToolErrorStructuredContentSchema = Schema.Struct({
  type: Schema.Literal('model_visible_tool_error'),
  tool: Schema.String,
  reason: ModelVisibleToolErrorReason,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown)
})
export type ModelVisibleToolErrorStructuredContent =
  typeof ModelVisibleToolErrorStructuredContentSchema.Type

export type ModelVisibleToolErrorInput = {
  readonly tool: string
  readonly message: string
  readonly reason: ModelVisibleToolErrorReason
  readonly details?: unknown
}

export const modelVisibleToolError = (input: ModelVisibleToolErrorInput) =>
  new ModelVisibleToolError(input)

export const modelVisibleToolErrorStructuredContent = (
  error: ModelVisibleToolError
): ModelVisibleToolErrorStructuredContent => ({
  type: 'model_visible_tool_error',
  tool: error.tool,
  reason: error.reason,
  message: error.message,
  ...(error.details === undefined ? {} : { details: error.details })
})

export const modelVisibleToolErrorResult = (call: ToolCall, error: ModelVisibleToolError) =>
  makeErrorToolResult({
    toolCallId: call.id,
    content: error.message,
    structuredContent: modelVisibleToolErrorStructuredContent(error)
  })

export type ToolExecutionInput<Context> = {
  readonly call: ToolCall
  readonly context: Context
}

export type SchemaToolExecutionInput<Context, Params> = ToolExecutionInput<Context> & {
  readonly params: Params
}

export type ToolRegistration<Context> = {
  readonly def: ToolDef
  readonly access: ToolAccess
  readonly approval?: ToolApprovalPolicy
  readonly isEnabled?: (context: Context) => Effect.Effect<boolean, ToolRegistryError>
  readonly execute: (input: ToolExecutionInput<Context>) => Effect.Effect<ToolResult, ToolError>
}

type ToolParamsSchema = Schema.Schema<unknown> & { readonly DecodingServices: never }

export const EmptyToolParams = Schema.Record(Schema.String, Schema.Never)

export type MakeToolOptions<Context, ParamsSchema extends ToolParamsSchema> = {
  readonly name: string
  readonly description: string
  readonly parameters: ParamsSchema
  readonly access: ToolAccess
  readonly approval?: ToolApprovalPolicy
  readonly isEnabled?: (context: Context) => Effect.Effect<boolean, ToolRegistryError>
  readonly invalidParamsMessage?: (error: unknown) => string
  readonly execute: (
    input: SchemaToolExecutionInput<Context, ParamsSchema['Type']>
  ) => Effect.Effect<ToolResult, ToolError | ModelVisibleToolError>
}

export type ToolModule<Context> = {
  readonly id: string
  readonly tools: ReadonlyArray<ToolRegistration<Context>>
}

export type ToolMetadata = {
  readonly moduleId: string
  readonly name: string
  readonly access: ToolAccess
}

type ResolvedRegistration<Context> = {
  readonly moduleId: string
  readonly tool: ToolRegistration<Context>
}

export type ResolvedToolSet = {
  readonly tools: ReadonlyArray<ToolDef>
  readonly metadata: ReadonlyArray<ToolMetadata>
  readonly execute: (call: ToolCall) => Effect.Effect<ToolResult, ToolError>
}

const enabled = <Context>(tool: ToolRegistration<Context>, context: Context) =>
  tool.isEnabled === undefined ? Effect.succeed(true) : tool.isEnabled(context)

const resolveModuleTools = <Context>(toolModule: ToolModule<Context>, context: Context) =>
  Effect.forEach(toolModule.tools, tool =>
    enabled(tool, context).pipe(
      Effect.map(isToolEnabled =>
        isToolEnabled ? Option.some({ moduleId: toolModule.id, tool }) : Option.none()
      )
    )
  ).pipe(Effect.map(Arr.getSomes))

const duplicateToolError = (name: string) =>
  new ToolRegistryError({
    cause: 'duplicate_tool',
    message: `Duplicate tool registered: ${name}`
  })

const missingToolError = (name: string) =>
  new ToolError({
    tool: name,
    message: `Tool is not configured: ${name}`,
    cause: 'not_found'
  })

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const objectField = (input: unknown, key: string) =>
  input !== null && typeof input === 'object'
    ? Object.getOwnPropertyDescriptor(input, key)?.value
    : undefined

const isObjectRecord = (input: unknown): input is Readonly<Record<string, unknown>> =>
  input !== null && typeof input === 'object' && !Array.isArray(input)

const localDefinitionName = (ref: unknown) => {
  if (typeof ref !== 'string') {
    return undefined
  }

  const prefix = '#/$defs/'

  return ref.startsWith(prefix) ? ref.slice(prefix.length) : undefined
}

const hasJsonSchemaType = (input: unknown, type: string) => objectField(input, 'type') === type

const isEmptyStructJsonSchema = (schema: unknown) => {
  const anyOf = objectField(schema, 'anyOf')

  return (
    Array.isArray(anyOf) &&
    anyOf.length === 2 &&
    anyOf.some(item => hasJsonSchemaType(item, 'object')) &&
    anyOf.some(item => hasJsonSchemaType(item, 'array'))
  )
}

const isEmptyRecordJsonSchema = (schema: unknown) =>
  hasJsonSchemaType(schema, 'object') &&
  objectField(schema, 'additionalProperties') === false &&
  objectField(schema, 'properties') === undefined &&
  objectField(schema, 'required') === undefined

const emptyObjectJsonSchema = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false
}

const jsonSchemaFromSchema = (schema: Schema.Top) => {
  const document = Schema.toJsonSchemaDocument(schema)
  const definitionName = localDefinitionName(objectField(document.schema, '$ref'))
  const localDefinition =
    definitionName === undefined
      ? undefined
      : Object.getOwnPropertyDescriptor(document.definitions, definitionName)?.value
  const rootSchema = isObjectRecord(localDefinition) ? localDefinition : document.schema
  const remainingDefinitions =
    definitionName === undefined
      ? document.definitions
      : Object.fromEntries(
          Object.entries(document.definitions).filter(([name]) => name !== definitionName)
        )
  const jsonSchema =
    isEmptyStructJsonSchema(rootSchema) || isEmptyRecordJsonSchema(rootSchema)
      ? emptyObjectJsonSchema
      : rootSchema

  return Object.keys(remainingDefinitions).length > 0
    ? { ...jsonSchema, $defs: remainingDefinitions }
    : jsonSchema
}

export const makeTool = <Context, ParamsSchema extends ToolParamsSchema>(
  options: MakeToolOptions<Context, ParamsSchema>
): ToolRegistration<Context> => ({
  def: ToolDef.make({
    name: options.name,
    description: options.description,
    parameters: jsonSchemaFromSchema(options.parameters),
    approval: options.approval
  }),
  access: options.access,
  approval: options.approval,
  isEnabled: options.isEnabled,
  execute: ({ call, context }) =>
    Schema.decodeUnknownEffect(options.parameters)(call.params).pipe(
      Effect.matchEffect({
        onFailure: error => {
          const message =
            options.invalidParamsMessage?.(error) ??
            `Invalid ${options.name} arguments: ${unknownToMessage(error)}`

          return Effect.succeed(
            modelVisibleToolErrorResult(
              call,
              modelVisibleToolError({
                tool: options.name,
                message,
                reason: 'validation'
              })
            )
          )
        },
        onSuccess: params =>
          options
            .execute({ call, context, params })
            .pipe(
              Effect.catchTag('ModelVisibleToolError', error =>
                Effect.succeed(modelVisibleToolErrorResult(call, error))
              )
            )
      })
    )
})

const findDuplicateToolName = <Context>(resolved: ReadonlyArray<ResolvedRegistration<Context>>) => {
  const names = Arr.map(resolved, item => item.tool.def.name)

  return Arr.findFirst(names, (name, index) => names.indexOf(name) !== index)
}

export const resolveTools = <Context>(
  modules: ReadonlyArray<ToolModule<Context>>,
  context: Context
): Effect.Effect<ResolvedToolSet, ToolRegistryError> =>
  Effect.gen(function* () {
    const resolvedByModule = yield* Effect.forEach(modules, toolModule =>
      resolveModuleTools(toolModule, context)
    )
    const resolved = Arr.flatten(resolvedByModule)
    const duplicateName = findDuplicateToolName(resolved)

    if (Option.isSome(duplicateName)) {
      return yield* Effect.fail(duplicateToolError(duplicateName.value))
    }

    const tools = Arr.map(resolved, item => item.tool.def)
    const metadata = Arr.map(resolved, item => ({
      moduleId: item.moduleId,
      name: item.tool.def.name,
      access: item.tool.access
    }))

    const execute = (call: ToolCall) =>
      Option.match(
        Arr.findFirst(resolved, item => item.tool.def.name === call.name),
        {
          onNone: () => Effect.fail(missingToolError(call.name)),
          onSome: match => match.tool.execute({ call, context })
        }
      )

    return { tools, metadata, execute }
  })

export const makeToolExecutorLayer = (toolSet: ResolvedToolSet) =>
  Layer.succeed(ToolExecutor, ToolExecutor.of({ execute: toolSet.execute }))
