import {
  Array as Arr,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Result,
  type JsonSchema
} from 'effect'
import * as Schema from 'effect/Schema'
import * as SchemaAST from 'effect/SchemaAST'
import { ToolError, ToolExecutor, type ToolExecutionOptions } from '@yolk-sdk/agent/loop'
import {
  isToolJsonSchemaObject,
  makeErrorToolResult,
  makeInteractionToolResult,
  ToolDef,
  ToolJsonSchema,
  ToolJsonSchemaObject,
  InteractionValidationError,
  interactionRequestId,
  sameInteractionBinding,
  validInteractionReceipt,
  type InputToolHandler,
  type InteractionBusinessOutcome,
  type InteractionRef,
  type InteractionHost,
  type InteractionOutcome,
  type InteractionPreflight,
  type InteractionResponseValidator,
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
      'background_unsupported_schema',
      'input_unsupported_policy',
      'input_validation_required',
      'interaction_unsupported_policy',
      'interaction_validation_required'
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
  /** Present only on schema-backed input registrations; owns user-payload validation. */
  readonly input?: InputToolHandler
  /** Present only on action-backed interaction registrations; owns values validation
   * and the selected server action handlers. Never combined with approval/background.
   */
  readonly interaction?: InteractionToolRegistration<Context>
}

/** Server-owned per-action handlers for one interaction registration. `validate`
 * is side-effect-free and runs before acceptance; `execute` runs the chosen
 * handler on accepted values behind the ToolExecutor with an explicit
 * interaction reference. Hosts own auth, scope, policy, and idempotency.
 */
export type InteractionActionHandler<Context> = {
  readonly label: string
  readonly description?: string | undefined
  readonly validate?: (input: {
    readonly data: unknown
    readonly context: Context
  }) => Effect.Effect<void, Schema.SchemaError | InteractionValidationError>
  readonly execute: (input: {
    readonly data: unknown
    readonly context: Context
    readonly submissionId: string
    readonly call: ToolCall
  }) => Effect.Effect<InteractionActionResult, ToolError | ModelVisibleToolError>
}

export type InteractionActionResult = {
  readonly outcome: InteractionBusinessOutcome
  readonly content: ToolResult['content']
  readonly structuredContent?: unknown
}

export type InteractionToolRegistration<Context> = {
  /** Validate model-supplied context before opening a request or accepting a response. */
  readonly validateCall: InteractionResponseValidator
  readonly validateResponse: InteractionResponseValidator
  /** Server-defined named actions keyed by action id. */
  readonly actions: Readonly<Record<string, InteractionActionHandler<Context>>>
}

export type { ToolExecutionOptions } from '@yolk-sdk/agent/loop'

/** Preflight-safe view of one resolved interaction tool: original validators
 * plus the server-defined action ids. Handlers stay server-side in the
 * executor closure; the loop never executes actions directly.
 */
export type ResolvedInteractionTool = InteractionPreflight & {
  readonly def: ToolDef
}

export type ResolvedInputTool = InputToolHandler & {
  readonly def: ToolDef
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
  readonly execute: (
    call: ToolCall,
    options?: ToolExecutionOptions
  ) => Effect.Effect<ToolResult, ToolError>
  /** Server-side input validators by tool name. Hosts pass these explicitly to loop configs.
   * Direct execute never completes input tools; they resolve only through HITL resume.
   */
  readonly inputs: Readonly<Record<string, ResolvedInputTool>>
  /** Preflight-safe interaction views by tool name. Hosts pass these explicitly to loop
   * configs. Selected actions execute only through `execute` with an explicit
   * interaction binding admitted through the host receipt port.
   */
  readonly interactions: Readonly<Record<string, ResolvedInteractionTool>>
  readonly interactionHost?: InteractionHost
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

// Strict OpenAI-compatible upstreams reject union roots without an explicit
// object type. Stamp only typeless combinators whose members are all objects
// (local $refs resolved): every other root keeps its prior shape, so
// primitive, unknown, and already-typed schemas are untouched, and call
// validation still decodes against the original Effect Schema.
const isObjectCombinatorMember = (
  member: Schema.Json | undefined,
  definitions: typeof ToolJsonSchemaObject.Type
): boolean => {
  const schema = jsonObject(member)

  if (schema === undefined) return false

  const type = jsonField(schema, 'type')

  if (type === 'object') return true

  if (type !== undefined) return false

  const ref = jsonField(schema, '$ref')

  if (Predicate.isString(ref)) {
    const name = localDefinitionName(ref)

    if (name === undefined) return false

    return isObjectCombinatorRoot(jsonField(definitions, name), definitions)
  }

  const nested = jsonField(schema, 'anyOf') ?? jsonField(schema, 'oneOf')

  if (!Array.isArray(nested)) return false

  return (
    nested.length > 0 &&
    nested.every((item: Schema.Json) => isObjectCombinatorMember(item, definitions))
  )
}

const isObjectCombinatorRoot = (
  schema: Schema.Json | undefined,
  definitions: typeof ToolJsonSchemaObject.Type
): boolean => {
  const root = jsonObject(schema)

  if (root === undefined || jsonField(root, 'type') !== undefined) return false

  const combinators = jsonField(root, 'anyOf') ?? jsonField(root, 'oneOf')

  if (!Array.isArray(combinators) || combinators.length === 0) return false

  return combinators.every((member: Schema.Json) => isObjectCombinatorMember(member, definitions))
}

const stampObjectCombinatorRoot = (
  schema: typeof ToolJsonSchema.Type,
  definitions: typeof ToolJsonSchemaObject.Type
): typeof ToolJsonSchema.Type => {
  const root = jsonObject(schema)

  if (root === undefined || !isObjectCombinatorRoot(root, definitions)) return schema

  return { ...root, type: 'object' }
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
    return stampObjectCombinatorRoot(jsonSchema, definitions)
  }

  if (!isToolJsonSchemaObject(jsonSchema)) {
    return { allOf: [jsonSchema], $defs: remainingDefinitions }
  }

  return stampObjectCombinatorRoot({ ...jsonSchema, $defs: remainingDefinitions }, definitions)
}

/** JSON Schema lowering of an Effect Schema for model guidance and display hints.
 * Guidance only: execution validation always decodes against the original Effect Schema.
 */
export const toolJsonSchemaFromSchema = (schema: Schema.Top): typeof ToolJsonSchema.Type =>
  jsonSchemaFromSchema(schema)

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

const interactionToolError = (input: {
  readonly tool: string
  readonly cause: ToolError['cause']
  readonly message: string
}) => new ToolError({ tool: input.tool, cause: input.cause, message: input.message })

const hostErrorToToolError = (tool: string) => (error: unknown) =>
  interactionToolError({
    tool,
    cause: 'execution',
    message:
      error instanceof Error
        ? `Interaction host failed: ${error.message}`
        : 'Interaction host failed'
  })

/** Explicit refs select only already accepted immutable host records. Historical
 * observations precede current validators/actions; no raw browser payload enters here. */
const executeInteractionTool = <Context>(input: {
  readonly registration: ToolRegistration<Context> | undefined
  readonly call: ToolCall
  readonly context: Context
  readonly ref: InteractionRef | undefined
  readonly host: InteractionHost | undefined
}): Effect.Effect<ToolResult, ToolError> =>
  Effect.gen(function* () {
    const name = input.call.name
    const host = input.host
    const ref = input.ref

    const denied = (message: string) =>
      interactionToolError({ tool: name, cause: 'denied', message })

    if (host === undefined || ref === undefined) {
      return yield* Effect.fail(
        interactionToolError({
          tool: name,
          cause: 'unavailable',
          message: `Interaction "${name}" requires a scoped host and accepted reference.`
        })
      )
    }

    if (ref.slot !== interactionRequestId(input.call)) {
      return yield* Effect.fail(denied('Interaction reference does not match the original call.'))
    }

    const stored = yield* host.read(ref.slot).pipe(Effect.mapError(hostErrorToToolError(name)))

    if (stored === undefined || !validInteractionReceipt(stored, input.call, ref)) {
      return yield* Effect.fail(
        denied('Missing, foreign, or malformed accepted interaction receipt.')
      )
    }

    if (stored.status === 'settled' && stored.result !== undefined) return stored.result

    const unknownResult = () =>
      makeInteractionToolResult({
        toolCallId: stored.call.id,
        requestId: stored.slot,
        slot: stored.slot,
        submissionId: stored.submissionId,
        actionId: stored.actionId ?? '',
        outcome: 'unknown',
        content: 'The accepted action has no acknowledged final outcome.'
      })

    if (stored.status === 'started') return unknownResult()

    const handler = input.registration?.interaction
    const actionId = stored.actionId
    const data = stored.data

    const action =
      handler !== undefined && actionId !== undefined && Object.hasOwn(handler.actions, actionId)
        ? handler.actions[actionId]
        : undefined

    if (handler === undefined || action === undefined || data === undefined) {
      return yield* Effect.fail(
        interactionToolError({
          tool: name,
          cause: 'unavailable',
          message: 'The accepted interaction action is unavailable; no dispatch occurred.'
        })
      )
    }

    yield* handler
      .validateCall(stored.call.params)
      .pipe(
        Effect.mapError(error =>
          interactionToolError({ tool: name, cause: 'validation', message: error.message })
        )
      )
    yield* handler
      .validateResponse(data)
      .pipe(
        Effect.mapError(error =>
          interactionToolError({ tool: name, cause: 'validation', message: error.message })
        )
      )

    if (action.validate !== undefined) {
      yield* action
        .validate({ data, context: input.context })
        .pipe(
          Effect.mapError(error =>
            interactionToolError({ tool: name, cause: 'validation', message: error.message })
          )
        )
    }

    return yield* Effect.uninterruptibleMask(restore =>
      Effect.gen(function* () {
        const claim = yield* restore(host.claim(ref)).pipe(
          Effect.mapError(hostErrorToToolError(name))
        )

        // Recheck the full binding after the atomic claim, not just its opaque identity.
        if (
          !validInteractionReceipt(claim.receipt, input.call, ref) ||
          !sameInteractionBinding(stored, claim.receipt)
        ) {
          return yield* Effect.fail(
            denied('Claim returned a changed or malformed interaction receipt.')
          )
        }

        if (Predicate.isTagged(claim, 'Existing')) {
          return claim.receipt.status === 'settled' && claim.receipt.result !== undefined
            ? claim.receipt.result
            : unknownResult()
        }

        if (
          claim.receipt.status !== 'started' ||
          !Predicate.isString(claim.token) ||
          claim.token.trim().length === 0
        ) {
          return yield* Effect.fail(
            denied('Claim did not grant fenced ownership of a started receipt.')
          )
        }

        const unknown: InteractionOutcome = { status: 'unknown', result: unknownResult() }

        // Bounded finalization attempts durable uncertainty on defects/interruption. It does
        // not replace the original Cause, nor mask the business Effect indefinitely.
        const recoverSettlement = Effect.suspend(() => host.settle(claim.token, unknown)).pipe(
          Effect.interruptible,
          Effect.timeout('5 seconds'),
          Effect.exit
        )

        const sealUnknown = recoverSettlement.pipe(Effect.asVoid)

        return yield* Effect.gen(function* () {
          const actionResult = yield* restore(
            Effect.suspend(() =>
              action.execute({
                data,
                context: input.context,
                submissionId: stored.submissionId,
                call: stored.call
              })
            )
          ).pipe(
            Effect.catch(() =>
              Effect.succeed({
                outcome: 'unknown',
                content: 'The action escaped without a definitive business outcome.',
                structuredContent: undefined
              } satisfies InteractionActionResult)
            )
          )

          const outcome: InteractionOutcome = {
            status: actionResult.outcome,
            result: makeInteractionToolResult({
              toolCallId: stored.call.id,
              requestId: stored.slot,
              slot: stored.slot,
              submissionId: stored.submissionId,
              actionId: actionId ?? '',
              outcome: actionResult.outcome,
              content: actionResult.content,
              structuredContent: actionResult.structuredContent
            })
          }

          const settled = yield* restore(
            Effect.suspend(() => host.settle(claim.token, outcome))
          ).pipe(
            Effect.timeout('5 seconds'),
            Effect.catch(() =>
              recoverSettlement.pipe(
                Effect.map(exit => (Exit.isSuccess(exit) ? exit.value : unknown))
              )
            )
          )

          if (
            !validInteractionReceipt(
              { ...stored, status: 'settled', result: settled.result },
              input.call,
              ref
            ) ||
            !Schema.is(Schema.Record(Schema.String, Schema.Unknown))(
              settled.result.structuredContent
            ) ||
            settled.result.structuredContent.outcome !== settled.status
          ) {
            yield* sealUnknown

            return unknown.result
          }

          return settled.result
        }).pipe(Effect.onExit(exit => (Exit.isFailure(exit) ? sealUnknown : Effect.void)))
      })
    )
  })

export const resolveTools = <Context>(
  modules: ReadonlyArray<ToolModule<Context>>,
  context: Context,
  options: {
    readonly backgroundHost?: BackgroundToolHost<Context>
    /** Mandatory for interaction tools: callbacks over host-owned receipt storage.
     * No adapter means interaction tools are unavailable, never an in-memory fallback.
     */
    readonly interactionHost?: InteractionHost
  } = {}
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

      // Action-backed interaction tools pause for a person's selected action on final
      // values and never grant authorization or run detached execution; they require a
      // schema-backed registration with server-defined actions (fail closed).
      if (tool.def.interaction !== undefined) {
        if (
          activated(tool) ||
          tool.background === true ||
          tool.def.background === true ||
          tool.def.execution !== undefined ||
          tool.approval !== undefined ||
          tool.def.approval !== undefined ||
          tool.def.input !== undefined
        ) {
          return yield* Effect.fail(
            new ToolRegistryError({
              cause: 'interaction_unsupported_policy',
              message: `Interaction tool ${tool.def.name} cannot use approval, background execution, or input; interaction never grants ambient authorization.`
            })
          )
        }

        if (
          tool.interaction === undefined ||
          Object.keys(tool.interaction.actions).length === 0 ||
          tool.def.interaction.actions.length === 0
        ) {
          return yield* Effect.fail(
            new ToolRegistryError({
              cause: 'interaction_validation_required',
              message: `Interaction tool requires a schema-backed registration with server actions: ${tool.def.name}`
            })
          )
        }
      }

      // Generalized input tools pause for user data and never grant authorization or run
      // detached execution; they also require a schema-backed registration (fail closed).
      if (tool.def.input !== undefined) {
        if (
          activated(tool) ||
          tool.background === true ||
          tool.def.background === true ||
          tool.approval !== undefined ||
          tool.def.approval !== undefined
        ) {
          return yield* Effect.fail(
            new ToolRegistryError({
              cause: 'input_unsupported_policy',
              message: `Input tool ${tool.def.name} cannot use approval or background execution; input never grants authorization.`
            })
          )
        }

        if (tool.input === undefined) {
          return yield* Effect.fail(
            new ToolRegistryError({
              cause: 'input_validation_required',
              message: `Input tool requires a schema-backed registration: ${tool.def.name}`
            })
          )
        }
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

    const inputs: Record<string, ResolvedInputTool> = Object.fromEntries(
      resolved.flatMap(({ tool }) =>
        tool.def.input !== undefined && tool.input !== undefined
          ? [[tool.def.name, { def: tool.def, ...tool.input }]]
          : []
      )
    )

    const interactions: Record<string, ResolvedInteractionTool> = Object.fromEntries(
      resolved.flatMap(({ tool }) =>
        tool.def.interaction !== undefined &&
        tool.interaction !== undefined &&
        options.interactionHost !== undefined
          ? [
              [
                tool.def.name,
                {
                  def: tool.def,
                  validateCall: tool.interaction.validateCall,
                  validateResponse: tool.interaction.validateResponse,
                  actionIds: Object.keys(tool.interaction.actions),
                  validateAction: ({ actionId, data }) => {
                    const action = tool.interaction?.actions[actionId]

                    return action === undefined
                      ? Effect.fail(
                          new InteractionValidationError({ message: 'Unknown interaction action' })
                        )
                      : (action.validate?.({ data, context }) ?? Effect.void)
                  }
                }
              ]
            ]
          : []
      )
    )

    const execute = (call: ToolCall, executionOptions?: ToolExecutionOptions) =>
      executionOptions?.interaction !== undefined
        ? executeInteractionTool({
            registration: resolved.find(item => item.tool.def.name === call.name)?.tool,
            call,
            context,
            ref: executionOptions.interaction,
            host: options.interactionHost
          })
        : Option.match(
            Arr.findFirst(resolved, item => item.tool.def.name === call.name),
            {
              onNone: () => Effect.fail(missingToolError(call.name)),
              onSome: match => {
                if (match.tool.def.input !== undefined) {
                  return Effect.fail(
                    new ToolError({
                      tool: call.name,
                      cause: 'unavailable',
                      message: `Input tool "${call.name}" requires user input and cannot execute directly.`
                    })
                  )
                }

                if (match.tool.def.interaction !== undefined) {
                  return executeInteractionTool({
                    registration: match.tool,
                    call,
                    context,
                    ref: executionOptions?.interaction,
                    host: options.interactionHost
                  })
                }

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

    return {
      tools,
      metadata,
      execute,
      inputs,
      interactions,
      interactionHost: options.interactionHost
    }
  })

export const makeToolExecutorLayer = (toolSet: ResolvedToolSet) =>
  Layer.succeed(ToolExecutor, ToolExecutor.of({ execute: toolSet.execute }))
