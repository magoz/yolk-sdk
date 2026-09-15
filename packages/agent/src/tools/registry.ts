import { Array as Arr, Effect, Layer, Option, Predicate, Result, type JsonSchema } from 'effect'
import * as Schema from 'effect/Schema'
import * as SchemaAST from 'effect/SchemaAST'
import { ToolError, ToolExecutor } from '@yolk-sdk/agent/loop'
import {
  isToolJsonSchemaObject,
  makeErrorToolResult,
  ToolDef,
  ToolJsonSchema,
  ToolJsonSchemaObject,
  type ToolApprovalPolicy,
  type ToolCall,
  type ToolResult
} from '@yolk-sdk/agent/protocol'
import { questionToolName, subagentToolName } from '../protocol/tool.ts'
import {
  backgroundToolDef,
  executeBackgroundTool,
  unsupportedBackgroundSchema,
  type BackgroundToolHost
} from './background.ts'

export const ToolAccess = Schema.Literals(['read', 'write', 'destructive'])

export type ToolAccess = typeof ToolAccess.Type

export class ToolRegistryError extends Schema.TaggedError<ToolRegistryError>()(
  'ToolRegistryError',
  {
    message: Schema.String,
    cause: Schema.Literals([
      'duplicate_tool',
      'background_validation_required',
      'background_definition_already_active',
      'background_unsupported_tool',
      'background_unsupported_schema'
    ])
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

export class ModelVisibleToolError extends Schema.TaggedError<ModelVisibleToolError>()(
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

type ModelVisibleToolErrorStructuredContentFields = {
  type: 'model_visible_tool_error'
  tool: ModelVisibleToolError['tool']
  reason: ModelVisibleToolError['reason']
  message: ModelVisibleToolError['message']
  details?: ModelVisibleToolError['details']
}

export const modelVisibleToolErrorStructuredContent = (
  error: ModelVisibleToolError
): ModelVisibleToolErrorStructuredContent => {
  const fields: ModelVisibleToolErrorStructuredContentFields = {
    type: 'model_visible_tool_error',
    tool: error.tool,
    reason: error.reason,
    message: error.message
  }

  if (error.details !== undefined) {
    fields.details = error.details
  }

  return fields
}

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
  /** Required for raw background registrations; must validate without business effects. */
  readonly validate?: (call: ToolCall) => Effect.Effect<void, ToolError>
  readonly def: ToolDef
  readonly access: ToolAccess
  readonly approval?: ToolApprovalPolicy
  readonly background?: boolean
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
  readonly background?: boolean
  readonly isEnabled?: (context: Context) => Effect.Effect<boolean, ToolRegistryError>
  readonly invalidParamsMessage?: (error: Schema.SchemaError) => string
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

const jsonField = (input: Schema.JsonObject, key: string): Schema.Json | undefined =>
  Object.hasOwn(input, key) ? input[key] : undefined

const isJsonObject = (input: Schema.Json | undefined): input is Schema.JsonObject =>
  Predicate.isObject(input)

const jsonObject = (input: Schema.Json | undefined): Schema.JsonObject | undefined =>
  isJsonObject(input) ? input : undefined

type ToolJsonSchemaDocument = JsonSchema.Document<'draft-2020-12'>

const requireToolJsonSchema = (
  input: ToolJsonSchemaDocument['schema']
): typeof ToolJsonSchema.Type => {
  const result = Schema.decodeUnknownResult(ToolJsonSchema)(input)

  if (Result.isSuccess(result)) {
    return result.success
  }

  throw new Error(new Schema.SchemaError(result.failure.issue).message, {
    cause: result.failure.issue
  })
}

const requireToolJsonSchemaObject = (
  input: ToolJsonSchemaDocument['definitions']
): typeof ToolJsonSchemaObject.Type => {
  const result = Schema.decodeUnknownResult(ToolJsonSchemaObject)(input)

  if (Result.isSuccess(result)) {
    return result.success
  }

  throw new Error(new Schema.SchemaError(result.failure.issue).message, {
    cause: result.failure.issue
  })
}

const localDefinitionName = (ref: string) => {
  const prefix = '#/$defs/'

  return ref.startsWith(prefix) ? ref.slice(prefix.length) : undefined
}

const hasJsonSchemaType = (input: Schema.Json, type: string) => {
  const schema = jsonObject(input)

  return schema !== undefined && jsonField(schema, 'type') === type
}

const isEmptyStructSchema = (schema: Schema.Top) => {
  const ast = Schema.toEncoded(schema).ast

  return (
    SchemaAST.isObjects(ast) &&
    ast.propertySignatures.length === 0 &&
    ast.indexSignatures.length === 0
  )
}

const isEmptyRecordJsonSchema = (schema: typeof ToolJsonSchema.Type) =>
  isToolJsonSchemaObject(schema) &&
  hasJsonSchemaType(schema, 'object') &&
  jsonField(schema, 'additionalProperties') === false &&
  jsonField(schema, 'properties') === undefined &&
  jsonField(schema, 'required') === undefined

const emptyObjectJsonSchema: typeof ToolJsonSchemaObject.Type = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false
}

const jsonSchemaFromSchema = (schema: Schema.Top): typeof ToolJsonSchema.Type => {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: 'error' })
  const documentSchema = requireToolJsonSchema(document.schema)

  const rootRef = isToolJsonSchemaObject(documentSchema)
    ? jsonField(documentSchema, '$ref')
    : undefined

  const definitionName = Predicate.isString(rootRef) ? localDefinitionName(rootRef) : undefined
  const definitions = requireToolJsonSchemaObject(document.definitions)

  const localDefinition =
    definitionName === undefined ? undefined : jsonField(definitions, definitionName)

  const rootSchema = jsonObject(localDefinition) ?? documentSchema

  const remainingDefinitions =
    definitionName === undefined
      ? definitions
      : Object.fromEntries(Object.entries(definitions).filter(([name]) => name !== definitionName))

  const jsonSchema =
    isEmptyStructSchema(schema) || isEmptyRecordJsonSchema(rootSchema)
      ? emptyObjectJsonSchema
      : rootSchema

  if (Object.keys(remainingDefinitions).length === 0) {
    return jsonSchema
  }

  if (!isToolJsonSchemaObject(jsonSchema)) {
    return { allOf: [jsonSchema], $defs: remainingDefinitions }
  }

  return { ...jsonSchema, $defs: remainingDefinitions }
}

// Distinguishes makeTool's model-visible schema failures from raw/host ToolErrors.
class InvalidToolParamsError extends ToolError {}

const invalidParamsMessage = (
  options: {
    readonly name: string
    readonly invalidParamsMessage?: (error: Schema.SchemaError) => string
  },
  error: Schema.SchemaError
) => options.invalidParamsMessage?.(error) ?? `Invalid ${options.name} arguments: ${String(error)}`

type MakeToolRegistrationFields = {
  def: ToolDef
  background?: boolean
}

type MakeToolDefFields<Context, ParamsSchema extends ToolParamsSchema> = {
  name: string
  description: string
  parameters: ReturnType<typeof jsonSchemaFromSchema>
  approval: MakeToolOptions<Context, ParamsSchema>['approval']
  background?: boolean
}

export const makeTool = <Context, ParamsSchema extends ToolParamsSchema>(
  options: MakeToolOptions<Context, ParamsSchema>
): ToolRegistration<Context> => {
  const registration: MakeToolRegistrationFields = {
    def: ToolDef.make(
      (() => {
        const fields: MakeToolDefFields<Context, ParamsSchema> = {
          name: options.name,
          description: options.description,
          parameters: jsonSchemaFromSchema(options.parameters),
          approval: options.approval
        }

        if (options.background !== undefined) {
          fields.background = options.background
        }

        return fields
      })()
    )
  }

  if (options.background !== undefined) {
    registration.background = options.background
  }

  const tails: Pick<
    ToolRegistration<Context>,
    'validate' | 'access' | 'approval' | 'isEnabled' | 'execute'
  > = {
    validate: call =>
      Schema.decodeUnknownEffect(options.parameters)(call.params).pipe(
        Effect.asVoid,
        Effect.mapError(
          error =>
            new InvalidToolParamsError({
              tool: options.name,
              cause: 'validation',
              message: invalidParamsMessage(options, error)
            })
        )
      ),
    access: options.access,
    approval: options.approval,
    isEnabled: options.isEnabled,
    execute: ({ call, context }) =>
      Schema.decodeUnknownEffect(options.parameters)(call.params).pipe(
        Effect.matchEffect({
          onFailure: error => {
            const message = invalidParamsMessage(options, error)

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
  }

  return Object.assign(registration, tails)
}

const findDuplicateToolName = <Context>(resolved: ReadonlyArray<ResolvedRegistration<Context>>) => {
  const names = Arr.map(resolved, item => item.tool.def.name)

  return Arr.findFirst(names, (name, index) => names.indexOf(name) !== index)
}

// Protocol owns names without importing registrations back into this module.
const loopOwnedToolNames: ReadonlySet<string> = new Set([questionToolName, subagentToolName])

export const resolveTools = <Context>(
  modules: ReadonlyArray<ToolModule<Context>>,
  context: Context,
  options: { readonly backgroundHost?: BackgroundToolHost<Context> } = {}
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

    const activated = (tool: ToolRegistration<Context>) =>
      options.backgroundHost !== undefined && (tool.background ?? tool.def.background) === true

    for (const { tool } of resolved) {
      // Resolved definitions are advertisements, not reusable business registrations.
      if (tool.def.execution !== undefined) {
        return yield* Effect.fail(
          new ToolRegistryError({
            cause: 'background_definition_already_active',
            message: `Register the original business definition, not an activated definition: ${tool.def.name}`
          })
        )
      }

      // Loop-owned tool names keep their own lifecycle: `question` is intercepted before dispatch
      // and `subagent` already owns an explicit acknowledgement helper keyed on its top-level params.
      if (activated(tool) && loopOwnedToolNames.has(tool.def.name)) {
        return yield* Effect.fail(
          new ToolRegistryError({
            cause: 'background_unsupported_tool',
            message: `The loop-owned ${tool.def.name} tool cannot activate envelope background execution.`
          })
        )
      }

      const unsupportedSchema = activated(tool)
        ? unsupportedBackgroundSchema(tool.def.parameters)
        : undefined

      if (unsupportedSchema !== undefined) {
        return yield* Effect.fail(
          new ToolRegistryError({
            cause: 'background_unsupported_schema',
            message: `Background tool ${tool.def.name} has unsupported schema keyword: ${unsupportedSchema}`
          })
        )
      }

      if (activated(tool) && tool.validate === undefined) {
        return yield* Effect.fail(
          new ToolRegistryError({
            cause: 'background_validation_required',
            message: `Background tool requires side-effect-free validation: ${tool.def.name}`
          })
        )
      }
    }

    const tools = Arr.map(resolved, item =>
      activated(item.tool) ? backgroundToolDef(item.tool.def) : item.tool.def
    )

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
          onSome: match => {
            const host = options.backgroundHost
            const validate = match.tool.validate

            return activated(match.tool) && host !== undefined && validate !== undefined
              ? executeBackgroundTool({
                  request: call,
                  context,
                  host,
                  validate: businessCall =>
                    validate(businessCall).pipe(
                      Effect.catchIf(
                        (error): error is InvalidToolParamsError =>
                          error instanceof InvalidToolParamsError,
                        error =>
                          Effect.succeed(
                            modelVisibleToolErrorResult(
                              businessCall,
                              modelVisibleToolError({
                                tool: error.tool,
                                message: error.message,
                                reason: 'validation'
                              })
                            )
                          )
                      )
                    ),
                  execute: businessCall => match.tool.execute({ call: businessCall, context })
                })
              : match.tool.execute({ call, context })
          }
        }
      )

    return { tools, metadata, execute }
  })

export const makeToolExecutorLayer = (toolSet: ResolvedToolSet) =>
  Layer.succeed(ToolExecutor, ToolExecutor.of({ execute: toolSet.execute }))
