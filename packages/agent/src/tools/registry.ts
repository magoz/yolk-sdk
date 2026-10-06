import {
  Array as Arr,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Result,
  type JsonSchema
} from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError, ToolExecutor, type ToolExecutionOptions } from '@yolk-sdk/agent/loop'
import {
  isCodeModeCallable,
  isCodeModeFailClosed,
  isToolStageable,
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
  type InteractionCallValidator,
  type InteractionHostError,
  type InteractionRef,
  type InteractionHost,
  type InteractionOutcome,
  type InteractionPreflight,
  type InteractionResponseValidator,
  type ToolApprovalPolicy,
  type ToolCall,
  type ToolExposure,
  type ToolResult
} from '@yolk-sdk/agent/protocol'
import { questionToolName, subagentToolName } from '../protocol/tool.ts'
import { withToolArgumentsErrorHint } from '../protocol/tool-argument-hints.ts'
import {
  decodeToolArguments,
  isEmptyStructSchema,
  omitNullOptionalToolArguments,
  omitNullOptionalToolCallArguments
} from './arguments.ts'
import {
  backgroundToolDef,
  executeBackgroundTool,
  unsupportedBackgroundSchema,
  type BackgroundToolHost
} from './background.ts'
import {
  executeLedgered,
  resolveToolLedgerOptions,
  toolIdempotencyKey,
  type ToolLedgerAbandonedInput,
  type ToolLedgerOptions
} from './ledger.ts'
import {
  defaultToolPlanMaxArgsBytes,
  defaultToolPlanMaxCalls,
  type ResolvedToolPlans,
  type ToolPlanOptions,
  type ToolPlanRuntime,
  type ToolPlanStaging,
  type ToolStaging,
  type ToolStagingHandlers
} from './plan.ts'
import {
  makeToolPlanRuntime,
  makeToolPlanStaging,
  positiveInteger,
  previewStoredToolPlanWith,
  previewToolPlanWith,
  type ToolPlanResolution
} from './plan-runtime.ts'

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
      'interaction_validation_required',
      'codemode_unsupported_tool',
      'invalid_tool_exposure',
      'staging_unsupported_policy',
      'staging_validation_required',
      'plan_review_duplicate'
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

/** One tool scripts may call, with its module id as the grouping/search namespace. */
export type NestedTool = {
  readonly def: ToolDef
  readonly moduleId: string
  /** The module's `ToolModule.description`, when set. */
  readonly moduleDescription?: string
}

/** Nested tool access for registrations with `nestedToolAccess: true` (for example a code mode
 * tool). Scoped to the same `resolveTools` resolution and host context.
 */
export type NestedToolExecutor = {
  /** Code-mode-callable tools (`callableBy` all or codemode, outside the fail-closed set),
   * excluding every registration with nested tool access (no recursion).
   */
  readonly tools: ReadonlyArray<NestedTool>
  /** Runs through the same path as `ResolvedToolSet.execute` (parameter validation, resolved
   * enablement, registration-level host wrappers, and the tool ledger when one is configured).
   * Unknown, disabled, and non-callable tools and tool failures become model-visible error
   * results; it never fails. The caller assigns call ids `<parentToolCallId>/<seq>`: they are the
   * nested calls' ledger keys (with the parent call id as `parentKey`). Decorators applied outside
   * `ResolvedToolSet.execute` (for example a wrapped ToolExecutor) do not see nested calls.
   */
  readonly execute: (call: ToolCall) => Effect.Effect<ToolResult>
  /** Staged tool plans (ADR 0005), bound to this call: present only when the resolution has
   * `plans`, an `interactionHost`, and one plan review registration.
   */
  readonly staging?: ToolPlanStaging
}

/** What a nested-access description sees of staging: the stageable tools and the review tool. */
export type NestedToolStagingDescription = {
  readonly tools: ReadonlyArray<NestedTool>
  readonly reviewToolName: string
}

type NestedToolExecutorFields = {
  tools: NestedToolExecutor['tools']
  execute: NestedToolExecutor['execute']
  staging?: ToolPlanStaging
}

/** Computes a nested-access registration's resolved description from the tools its scripts can
 * call (for example a code mode catalog). Honored by `resolveTools` only for registrations with
 * `nestedToolAccess: true`; the static `def.description` stays the fallback elsewhere. `staging`
 * is present when the resolution offers staged tool plans.
 */
export type NestedToolDescriber = (input: {
  readonly tools: ReadonlyArray<NestedTool>
  readonly staging?: NestedToolStagingDescription
}) => string

export type ToolExecutionInput<Context> = {
  readonly call: ToolCall
  readonly context: Context
  /** Present only for registrations with `nestedToolAccess: true`. Wrappers must forward it. */
  readonly nested?: NestedToolExecutor
  /** Present when `resolveTools` has a tool ledger: the ledger scope plus the call's ledger key
   * (`call.id`, or `<parentCallId>/<seq>` for nested calls), stable across re-executions. Pass it
   * to external APIs that deduplicate writes. Wrappers must forward it.
   */
  readonly idempotencyKey?: string
}

type ToolExecutionInputFields<Context> = {
  call: ToolCall
  context: Context
  nested?: NestedToolExecutor
  idempotencyKey?: string
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
  /** Receive a `nested` executor over the other code-mode-callable tools of the resolution. */
  readonly nestedToolAccess?: boolean
  /** With `nestedToolAccess: true`, the resolved definition's description is computed from the
   * nested tools of the resolution instead of `def.description`.
   */
  readonly describe?: NestedToolDescriber
  readonly isEnabled?: (context: Context) => Effect.Effect<boolean, ToolRegistryError>
  readonly execute: (input: ToolExecutionInput<Context>) => Effect.Effect<ToolResult, ToolError>
  /** Present only on schema-backed input registrations; owns user-payload validation. */
  readonly input?: InputToolHandler
  /** Present only on action-backed interaction registrations; owns values validation
   * and the selected server action handlers. Never combined with approval/background.
   */
  readonly interaction?: InteractionToolRegistration<Context>
  /** Present only on stageable registrations (`def.staging`): optional preview and precheck hooks
   * over a staged call (ADR 0005).
   */
  readonly staging?: ToolStagingHandlers<Context>
  /** Present only on plan review registrations (`makePlanReviewTool`): builds the interaction
   * handlers from the plan capabilities `resolveTools` binds (plan store, interaction host, and
   * the privileged plan executor). Without `plans` and an `interactionHost`, the tool is
   * unavailable.
   */
  readonly planReview?: (runtime: ToolPlanRuntime<Context>) => InteractionToolRegistration<Context>
  /** Result of a ledgered call found abandoned (claimed earlier, lease expired, no result),
   * instead of the default "may already have been applied" error. Receives the call's nested
   * ledger entries. The call is never executed again either way.
   */
  readonly abandonedResult?: (input: ToolLedgerAbandonedInput) => ToolResult
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
    /** The interaction call (normalized arguments) the response answers. */
    readonly call: ToolCall
  }) => Effect.Effect<void, Schema.SchemaError | InteractionValidationError | InteractionHostError>
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
  /** Validate model-supplied context before opening a request or accepting a response. An
   * `InteractionHostError` means storage the validator reads is unavailable (see
   * `InteractionCallValidator`), never that the call is invalid.
   */
  readonly validateCall: InteractionCallValidator
  readonly validateResponse: InteractionResponseValidator
  /** Server-defined named actions keyed by action id. */
  readonly actions: Readonly<Record<string, InteractionActionHandler<Context>>>
  /** Describes an accepted action that started and has no recorded outcome (for example after a
   * crash), instead of the generic notice. The result stays `unknown`; nothing runs again.
   */
  readonly unknownOutcome?: (input: {
    readonly call: ToolCall
    readonly submissionId: string
  }) => Effect.Effect<{
    readonly content: ToolResult['content']
    readonly structuredContent?: unknown
  }>
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
  /** Schema of `ToolResult.structuredContent`, lowered like `parameters` into
   * `ToolDef.outputSchema` for declarations only. Results are not validated against it.
   */
  readonly output?: Schema.Top
  readonly access: ToolAccess
  readonly approval?: ToolApprovalPolicy
  readonly background?: boolean
  /** Host-mark the tool stageable into reviewed plans (ADR 0005; sets `def.staging`). Requires
   * `approval`. Pass hooks for review previews and selection prechecks, or `true` for none.
   */
  readonly staging?: true | ToolStaging<Context, ParamsSchema['Type']>
  /** Receive a `nested` executor over the other code-mode-callable tools of the resolution. */
  readonly nestedToolAccess?: boolean
  /** With `nestedToolAccess: true`, compute the resolved description from the nested tools. */
  readonly describe?: NestedToolDescriber
  /** See `ToolRegistration.abandonedResult`. */
  readonly abandonedResult?: (input: ToolLedgerAbandonedInput) => ToolResult
  readonly isEnabled?: (context: Context) => Effect.Effect<boolean, ToolRegistryError>
  readonly invalidParamsMessage?: (error: Schema.SchemaError) => string
  readonly execute: (
    input: SchemaToolExecutionInput<Context, ParamsSchema['Type']>
  ) => Effect.Effect<ToolResult, ToolError | ModelVisibleToolError>
} & ToolExposure

export type ToolModule<Context> = {
  readonly id: string
  /** What the module's tools are for; nested-access registrations (for example code mode) show it
   * with the namespace and index it for tool search.
   */
  readonly description?: string
  readonly tools: ReadonlyArray<ToolRegistration<Context>>
}

export type ToolMetadata = {
  readonly moduleId: string
  readonly name: string
  readonly access: ToolAccess
}

type ResolvedRegistration<Context> = {
  readonly moduleId: string
  readonly moduleDescription: string | undefined
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
  /** Staged tool plans of this resolution (ADR 0005), when staging is available. */
  readonly plans?: ResolvedToolPlans
}

const enabled = <Context>(tool: ToolRegistration<Context>, context: Context) =>
  tool.isEnabled === undefined ? Effect.succeed(true) : tool.isEnabled(context)

const resolveModuleTools = <Context>(toolModule: ToolModule<Context>, context: Context) =>
  Effect.forEach(toolModule.tools, tool =>
    enabled(tool, context).pipe(
      Effect.map(isToolEnabled =>
        isToolEnabled
          ? Option.some({
              moduleId: toolModule.id,
              moduleDescription: toolModule.description,
              tool
            })
          : Option.none()
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
// validation still decodes through the original Effect Schema's JSON codec.
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
 * It describes the schema's canonical JSON codec (`Schema.toCodecJson`), which is what tool
 * argument validation decodes with; e.g. `Schema.optional(X)` is advertised and accepted as
 * `X | null`.
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
) =>
  options.invalidParamsMessage?.(error) ??
  withToolArgumentsErrorHint(`Invalid ${options.name} arguments: ${String(error)}`, error)

type MakeToolRegistrationFields<Context> = {
  def: ToolDef
  background?: boolean
  nestedToolAccess?: boolean
  describe?: NestedToolDescriber
  abandonedResult?: (input: ToolLedgerAbandonedInput) => ToolResult
  staging?: ToolStagingHandlers<Context>
}

type MakeToolDefFields<Context, ParamsSchema extends ToolParamsSchema> = {
  name: string
  description: string
  parameters: ReturnType<typeof jsonSchemaFromSchema>
  outputSchema?: ReturnType<typeof jsonSchemaFromSchema>
  callableBy?: ToolDef['callableBy']
  discovery?: ToolDef['discovery']
  approval: MakeToolOptions<Context, ParamsSchema>['approval']
  background?: boolean
  staging?: true
}

type ToolStagingHandlerFields<Context> = {
  preview?: NonNullable<ToolStagingHandlers<Context>['preview']>
  precheck?: NonNullable<ToolStagingHandlers<Context>['precheck']>
}

// Typed staging hooks see decoded arguments; a staged call that no longer decodes fails the hook.
const stagingHandlers = <Context, Params>(
  name: string,
  staging: ToolStaging<Context, Params>,
  decodeParams: (input: unknown) => Effect.Effect<Params, Schema.SchemaError>
): ToolStagingHandlers<Context> => {
  const handlers: ToolStagingHandlerFields<Context> = {}
  const preview = staging.preview
  const precheck = staging.precheck

  if (preview !== undefined) {
    handlers.preview = ({ call, context }) =>
      decodeParams(call.params).pipe(
        Effect.mapError(
          error =>
            new ToolError({
              tool: name,
              cause: 'validation',
              message: `Invalid ${name} arguments: ${error.message}`
            })
        ),
        Effect.flatMap(params => preview({ params, context }))
      )
  }

  if (precheck !== undefined) {
    handlers.precheck = ({ call, context }) =>
      decodeParams(call.params).pipe(
        Effect.mapError(
          error =>
            new InteractionValidationError({
              message: `Invalid ${name} arguments: ${error.message}`
            })
        ),
        Effect.flatMap(params => precheck({ params, context }))
      )
  }

  return handlers
}

export const makeTool = <Context, ParamsSchema extends ToolParamsSchema>(
  options: MakeToolOptions<Context, ParamsSchema>
): ToolRegistration<Context> => {
  // Decode what `def.parameters` advertises: the JSON codec, not the type-side schema.
  const decodeParams = decodeToolArguments(options.parameters)

  const registration: MakeToolRegistrationFields<Context> = {
    def: ToolDef.make(
      (() => {
        const fields: MakeToolDefFields<Context, ParamsSchema> = {
          name: options.name,
          description: options.description,
          parameters: jsonSchemaFromSchema(options.parameters),
          approval: options.approval
        }

        if (options.output !== undefined) {
          fields.outputSchema = jsonSchemaFromSchema(options.output)
        }

        if (options.callableBy !== undefined) {
          fields.callableBy = options.callableBy
        }

        if (options.discovery !== undefined) {
          fields.discovery = options.discovery
        }

        if (options.background !== undefined) {
          fields.background = options.background
        }

        if (options.staging !== undefined) {
          fields.staging = true
        }

        return fields
      })()
    )
  }

  if (options.staging !== undefined && options.staging !== true) {
    registration.staging = stagingHandlers(options.name, options.staging, decodeParams)
  }

  if (options.background !== undefined) {
    registration.background = options.background
  }

  if (options.nestedToolAccess !== undefined) {
    registration.nestedToolAccess = options.nestedToolAccess
  }

  if (options.describe !== undefined) {
    registration.describe = options.describe
  }

  if (options.abandonedResult !== undefined) {
    registration.abandonedResult = options.abandonedResult
  }

  const tails: Pick<
    ToolRegistration<Context>,
    'validate' | 'access' | 'approval' | 'isEnabled' | 'execute'
  > = {
    validate: call =>
      decodeParams(call.params).pipe(
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
    execute: input => {
      const { call } = input

      return decodeParams(call.params).pipe(
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
          // Forwards `nested` and `idempotencyKey` exactly as the registry passed them.
          onSuccess: params =>
            options
              .execute({ ...input, params })
              .pipe(
                Effect.catchTag('ModelVisibleToolError', error =>
                  Effect.succeed(modelVisibleToolErrorResult(call, error))
                )
              )
        })
      )
    }
  }

  return Object.assign(registration, tails)
}

type ToolDefFields = {
  name: ToolDef['name']
  description: ToolDef['description']
  parameters: ToolDef['parameters']
  outputSchema?: ToolDef['outputSchema']
  callableBy?: ToolDef['callableBy']
  discovery?: ToolDef['discovery']
  approval?: ToolDef['approval']
  background?: ToolDef['background']
  execution?: ToolDef['execution']
  input?: ToolDef['input']
  interaction?: ToolDef['interaction']
  staging?: ToolDef['staging']
}

// Explicit field selection: `ToolDef.make` would retain excess own keys of a spread instance.
const withToolDescription = (def: ToolDef, description: string): ToolDef => {
  const fields: ToolDefFields = {
    name: def.name,
    description,
    parameters: def.parameters
  }

  if (def.outputSchema !== undefined) fields.outputSchema = def.outputSchema

  if (def.callableBy !== undefined) fields.callableBy = def.callableBy

  if (def.discovery !== undefined) fields.discovery = def.discovery

  if (def.approval !== undefined) fields.approval = def.approval

  if (def.background !== undefined) fields.background = def.background

  if (def.execution !== undefined) fields.execution = def.execution

  if (def.input !== undefined) fields.input = def.input

  if (def.interaction !== undefined) fields.interaction = def.interaction

  if (def.staging !== undefined) fields.staging = def.staging

  return ToolDef.make(fields)
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

/** Bound of an interaction's `unknownOutcome` description; past it the generic notice is used. */
const interactionUnknownDescriptionTimeout = Duration.seconds(3)

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
  /** The registration's effective handlers (plan review handlers are bound per resolution). */
  readonly handler: InteractionToolRegistration<Context> | undefined
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

    const handler = input.handler

    const genericUnknownResult = () =>
      makeInteractionToolResult({
        toolCallId: stored.call.id,
        requestId: stored.slot,
        slot: stored.slot,
        submissionId: stored.submissionId,
        actionId: stored.actionId ?? '',
        outcome: 'unknown',
        content: 'The accepted action has no acknowledged final outcome.'
      })

    // A started action without a recorded outcome: the registration may describe what it knows
    // (for example a plan review's ledgered calls); any failure keeps the generic notice.
    const unknownResult = (): Effect.Effect<ToolResult> => {
      const describe = handler?.unknownOutcome

      if (describe === undefined) return Effect.succeed(genericUnknownResult())

      return Effect.suspend(() =>
        describe({ call: stored.call, submissionId: stored.submissionId })
      ).pipe(
        // Interruptible only inside its own bound (finalizers run with a pending interrupt).
        Effect.interruptible,
        Effect.timeoutOption(interactionUnknownDescriptionTimeout),
        Effect.map(described =>
          Option.isNone(described)
            ? genericUnknownResult()
            : makeInteractionToolResult({
                toolCallId: stored.call.id,
                requestId: stored.slot,
                slot: stored.slot,
                submissionId: stored.submissionId,
                actionId: stored.actionId ?? '',
                outcome: 'unknown',
                content: described.value.content,
                structuredContent: described.value.structuredContent
              })
        ),
        Effect.catchDefect(defect =>
          Effect.logWarning(
            `Interaction ${stored.slot}: unknownOutcome failed; using the generic notice: ${defect instanceof Error ? defect.message : String(defect)}`
          ).pipe(Effect.as(genericUnknownResult()))
        )
      )
    }

    if (stored.status === 'started') return yield* unknownResult()

    // Receipts bind the original call; validators and handlers see normalized arguments.
    const businessCall =
      input.registration === undefined
        ? stored.call
        : omitNullOptionalToolCallArguments(input.registration.def.parameters, stored.call)

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

    const validateAction = action.validate

    const validated = yield* Effect.gen(function* () {
      yield* handler.validateCall(businessCall.params)
      yield* handler.validateResponse(data)

      if (validateAction !== undefined)
        yield* validateAction({ data, context: input.context, call: businessCall })
    }).pipe(Effect.result)

    if (Result.isFailure(validated)) {
      const failure = validated.failure

      // Storage a validator reads is unavailable: fail closed (nothing runs), like ledger claims.
      if (Predicate.isTagged(failure, 'InteractionHostError'))
        return yield* Effect.fail(
          interactionToolError({
            tool: name,
            cause: 'unavailable',
            message: `Interaction storage is unavailable; no dispatch occurred: ${failure.message}`
          })
        )

      // Another execution may have started or settled this receipt since it was read (for
      // example a redelivered step): report that observation, not an invalid-arguments result.
      const current = yield* host.read(ref.slot).pipe(Effect.mapError(hostErrorToToolError(name)))

      if (current !== undefined && validInteractionReceipt(current, input.call, ref)) {
        if (current.status === 'settled' && current.result !== undefined) return current.result

        if (current.status === 'started') return yield* unknownResult()
      }

      return yield* Effect.fail(
        interactionToolError({ tool: name, cause: 'validation', message: failure.message })
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
            : yield* restore(unknownResult())
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

        const unknown: InteractionOutcome = { status: 'unknown', result: genericUnknownResult() }

        // Bounded finalization attempts durable uncertainty on defects/interruption (described by
        // the registration when it can, for example a plan review's ledgered calls). It does
        // not replace the original Cause, nor mask the business Effect indefinitely.
        // The description has its own bound (falling back to the generic notice), so settlement
        // always keeps its full budget and the receipt is sealed.
        const recoverSettlement = unknownResult().pipe(
          Effect.flatMap(result =>
            Effect.suspend(() => host.settle(claim.token, { status: 'unknown', result })).pipe(
              Effect.interruptible,
              Effect.timeout('5 seconds')
            )
          ),
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
                call: businessCall
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
    /** Durable tool-call ledger: ledgered calls (default every non-`read` tool and the built-in
     * `subagent` tool, top-level and nested) run at most once per ledger key across
     * re-executions. Absent: unchanged behavior.
     */
    readonly ledger?: ToolLedgerOptions
    /** Staged tool plans (ADR 0005): with an `interactionHost` and one plan review registration,
     * nested-access registrations get `nested.staging` and the review tool becomes available.
     * Absent: no staging, and plan review tools are unavailable.
     */
    readonly plans?: ToolPlanOptions
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

      if (tool.def.discovery !== undefined && tool.def.callableBy !== 'codemode') {
        return yield* Effect.fail(
          new ToolRegistryError({
            cause: 'invalid_tool_exposure',
            message: `Tool ${tool.def.name} sets discovery without callableBy 'codemode'.`
          })
        )
      }

      // Fail-closed tools never run from code mode; marking them codemode-only is an error
      // rather than a silently unreachable tool. A nested-access registration is never
      // script-callable itself, so codemode-only would make it unreachable too.
      if (
        tool.def.callableBy === 'codemode' &&
        (isCodeModeFailClosed(tool.def) ||
          activated(tool) ||
          tool.approval !== undefined ||
          tool.input !== undefined ||
          tool.interaction !== undefined ||
          tool.planReview !== undefined ||
          tool.nestedToolAccess === true)
      ) {
        return yield* Effect.fail(
          new ToolRegistryError({
            cause: 'codemode_unsupported_tool',
            message: `Tool ${tool.def.name} cannot be callableBy 'codemode': approval, input, interaction, background, question, subagent, and nested-access tools never run from code mode.`
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

        // Plan review registrations get their handlers bound per resolution instead.
        const handlersMissing =
          tool.planReview === undefined
            ? tool.interaction === undefined || Object.keys(tool.interaction.actions).length === 0
            : tool.interaction !== undefined

        if (handlersMissing || tool.def.interaction.actions.length === 0) {
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

      if (tool.planReview !== undefined && tool.def.interaction === undefined) {
        return yield* Effect.fail(
          new ToolRegistryError({
            cause: 'interaction_validation_required',
            message: `Plan review tool requires an interaction definition: ${tool.def.name}`
          })
        )
      }

      // Staging is host-marked on approval-gated tools only; a staged call is validated by the
      // side-effect-free decoder and applied only through a reviewed plan.
      if (tool.def.staging !== undefined || tool.staging !== undefined) {
        if (
          !isToolStageable(tool.def) ||
          activated(tool) ||
          tool.background === true ||
          tool.input !== undefined ||
          tool.interaction !== undefined ||
          tool.planReview !== undefined ||
          tool.nestedToolAccess === true
        ) {
          return yield* Effect.fail(
            new ToolRegistryError({
              cause: 'staging_unsupported_policy',
              message: `Tool ${tool.def.name} cannot be staged: staging needs def.staging and approval, and no input, interaction, background, nested tool access, or callableBy 'model'.`
            })
          )
        }

        if (tool.validate === undefined) {
          return yield* Effect.fail(
            new ToolRegistryError({
              cause: 'staging_validation_required',
              message: `Stageable tool requires side-effect-free validation: ${tool.def.name}`
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

    const reviewRegistrations = resolved.filter(item => item.tool.planReview !== undefined)

    if (reviewRegistrations.length > 1) {
      return yield* Effect.fail(
        new ToolRegistryError({
          cause: 'plan_review_duplicate',
          message: `At most one plan review tool may resolve: ${reviewRegistrations.map(item => item.tool.def.name).join(', ')}`
        })
      )
    }

    // Script-callable registrations: never fail-closed tools, never nested-access registrations.
    const nestedRegistrations = resolved.filter(
      item =>
        item.tool.nestedToolAccess !== true &&
        item.tool.approval === undefined &&
        item.tool.input === undefined &&
        item.tool.interaction === undefined &&
        item.tool.planReview === undefined &&
        !activated(item.tool) &&
        isCodeModeCallable(item.tool.def)
    )

    const nestedToolOf = (item: ResolvedRegistration<Context>): NestedTool =>
      item.moduleDescription === undefined
        ? { def: item.tool.def, moduleId: item.moduleId }
        : { def: item.tool.def, moduleId: item.moduleId, moduleDescription: item.moduleDescription }

    const nestedTools: ReadonlyArray<NestedTool> = nestedRegistrations.map(nestedToolOf)

    // Staged tool plans need durable plan storage, receipt-backed review, and one review tool.
    const reviewRegistration = reviewRegistrations[0]

    const stageableRegistrations = resolved.filter(
      item => isToolStageable(item.tool.def) && item.tool.validate !== undefined
    )

    const stagingDescription: NestedToolStagingDescription | undefined =
      options.plans !== undefined &&
      options.interactionHost !== undefined &&
      reviewRegistration !== undefined
        ? {
            tools: stageableRegistrations.map(nestedToolOf),
            reviewToolName: reviewRegistration.tool.def.name
          }
        : undefined

    const describedDef = (tool: ToolRegistration<Context>): ToolDef =>
      tool.nestedToolAccess === true && tool.describe !== undefined
        ? withToolDescription(
            tool.def,
            tool.describe(
              stagingDescription === undefined
                ? { tools: nestedTools }
                : { tools: nestedTools, staging: stagingDescription }
            )
          )
        : tool.def

    const tools = Arr.map(resolved, item => {
      const def = describedDef(item.tool)

      return activated(item.tool) ? backgroundToolDef(def) : def
    })

    const metadata = Arr.map(resolved, item => ({
      moduleId: item.moduleId,
      name: item.tool.def.name,
      access: item.tool.access
    }))

    // Registry boundary for model-produced arguments: every validator and handler below sees
    // call params with strict-mode `null`s on optional, non-nullable properties omitted.
    const withArguments =
      (def: ToolDef) =>
      <A, E>(validate: (params: unknown) => Effect.Effect<A, E>) =>
      (params: unknown) =>
        Effect.suspend(() => validate(omitNullOptionalToolArguments(def.parameters, params)))

    const businessCallFor = (def: ToolDef, call: ToolCall) =>
      Effect.sync(() => omitNullOptionalToolCallArguments(def.parameters, call))

    const inputs: Record<string, ResolvedInputTool> = Object.fromEntries(
      resolved.flatMap(({ tool }) =>
        tool.def.input !== undefined && tool.input !== undefined
          ? [
              [
                tool.def.name,
                {
                  def: tool.def,
                  ...tool.input,
                  validateCall: withArguments(tool.def)(tool.input.validateCall)
                }
              ]
            ]
          : []
      )
    )

    const ledger =
      options.ledger === undefined ? undefined : resolveToolLedgerOptions(options.ledger)

    const plans = options.plans
    const interactionHost = options.interactionHost

    // Staged tool plans (ADR 0005): staging and the privileged plan executor exist only with plan
    // storage, receipt-backed review, and one review tool. Applied calls take the single dispatch
    // seam (`executeRegistration`) like any other call, nested under the review call.
    const planResolution: ToolPlanResolution<Context> | undefined =
      plans === undefined || interactionHost === undefined || reviewRegistration === undefined
        ? undefined
        : {
            store: plans.store,
            maxCalls: positiveInteger(plans.maxCalls) ?? defaultToolPlanMaxCalls,
            maxArgsBytes: positiveInteger(plans.maxArgsBytes) ?? defaultToolPlanMaxArgsBytes,
            host: interactionHost,
            context,
            reviewToolName: reviewRegistration.tool.def.name,
            planId: call => (plans.planId === undefined ? call.id : plans.planId({ call })),
            stageableTools: stageableRegistrations.map(nestedToolOf),
            stageable: name =>
              stageableRegistrations.find(item => item.tool.def.name === name)?.tool,
            nestedAccess: name =>
              nestedRegistrations.find(item => item.tool.def.name === name)?.tool.access,
            businessCall: (registration, call) =>
              omitNullOptionalToolCallArguments(registration.def.parameters, call),
            execute: (registration, call, parentCallId) =>
              Option.match(
                Arr.findFirst(stageableRegistrations, item => item.tool === registration),
                {
                  onNone: () => Effect.fail(missingToolError(call.name)),
                  onSome: match => executeRegistration(match, call, undefined, parentCallId)
                }
              ),
            ledgered:
              ledger === undefined
                ? undefined
                : (registration, call, parentCallId) => {
                    const match = stageableRegistrations.find(item => item.tool === registration)

                    return (
                      match !== undefined &&
                      ledger.isLedgered({
                        call,
                        moduleId: match.moduleId,
                        access: registration.access,
                        parentCallId
                      })
                    )
                  },
            listNested: ledger === undefined ? undefined : ledger.store.list
          }

    const boundPlanReview =
      planResolution === undefined || reviewRegistration?.tool.planReview === undefined
        ? undefined
        : reviewRegistration.tool.planReview(makeToolPlanRuntime(planResolution))

    // Effective interaction handlers: plan review handlers exist only when plans are bound.
    const interactionOf = (
      tool: ToolRegistration<Context> | undefined
    ): InteractionToolRegistration<Context> | undefined =>
      tool === undefined
        ? undefined
        : tool.planReview === undefined
          ? tool.interaction
          : tool === reviewRegistration?.tool
            ? boundPlanReview
            : undefined

    const interactions: Record<string, ResolvedInteractionTool> = Object.fromEntries(
      resolved.flatMap(({ tool }) => {
        const handler = interactionOf(tool)

        return tool.def.interaction !== undefined &&
          handler !== undefined &&
          interactionHost !== undefined
          ? [
              [
                tool.def.name,
                {
                  def: tool.def,
                  validateCall: withArguments(tool.def)(handler.validateCall),
                  validateResponse: handler.validateResponse,
                  actionIds: Object.keys(handler.actions),
                  validateAction: ({ actionId, data, call }) => {
                    const action = Object.hasOwn(handler.actions, actionId)
                      ? handler.actions[actionId]
                      : undefined

                    return action === undefined
                      ? Effect.fail(
                          new InteractionValidationError({ message: 'Unknown interaction action' })
                        )
                      : (action.validate?.({
                          data,
                          context,
                          call: omitNullOptionalToolCallArguments(tool.def.parameters, call)
                        }) ?? Effect.void)
                  }
                }
              ]
            ]
          : []
      })
    )

    const codeModeOnlyNames = resolved.flatMap(item =>
      item.tool.def.callableBy === 'codemode' ? [item.tool.def.name] : []
    )

    if (
      codeModeOnlyNames.length > 0 &&
      !resolved.some(item => item.tool.nestedToolAccess === true)
    ) {
      yield* Effect.logWarning(
        `Code-mode-only tools are unreachable without a nested tool access registration: ${codeModeOnlyNames.join(', ')}`
      )
    }

    const executionInput = (
      tool: ToolRegistration<Context>,
      call: ToolCall,
      ledgerCall: ToolCall,
      idempotencyKey: string | undefined
    ): ToolExecutionInput<Context> => {
      const input: ToolExecutionInputFields<Context> = { call, context }

      // Nested calls belong to the original (ledger) call, whatever argument normalization did.
      if (tool.nestedToolAccess === true) input.nested = nestedFor(ledgerCall)

      if (idempotencyKey !== undefined) input.idempotencyKey = idempotencyKey

      return input
    }

    // The single ledger seam: top-level and nested calls of ordinary registrations pass here.
    // Input and interaction tools keep their own HITL receipts and are never ledgered.
    const executeRegistration = (
      match: ResolvedRegistration<Context>,
      call: ToolCall,
      executionOptions?: ToolExecutionOptions,
      parentCallId?: string
    ): Effect.Effect<ToolResult, ToolError> => {
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
          handler: interactionOf(match.tool),
          call,
          context,
          ref: executionOptions?.interaction,
          host: options.interactionHost
        })
      }

      if (ledger === undefined) return runRegistration(match, call, undefined)

      const idempotencyKey = toolIdempotencyKey(ledger.store.scope, call.id)

      const policyInput =
        parentCallId === undefined
          ? { call, moduleId: match.moduleId, access: match.tool.access }
          : { call, moduleId: match.moduleId, access: match.tool.access, parentCallId }

      return ledger.isLedgered(policyInput)
        ? executeLedgered({
            options: ledger,
            call,
            parentKey: parentCallId,
            execute: runRegistration(match, call, idempotencyKey),
            abandonedResult: match.tool.abandonedResult
          })
        : runRegistration(match, call, idempotencyKey)
    }

    const runRegistration = (
      match: ResolvedRegistration<Context>,
      call: ToolCall,
      idempotencyKey: string | undefined
    ): Effect.Effect<ToolResult, ToolError> => {
      const host = options.backgroundHost
      const validate = match.tool.validate
      const def = match.tool.def

      return activated(match.tool) && host !== undefined && validate !== undefined
        ? executeBackgroundTool({
            request: call,
            context,
            host,
            businessCall: businessCall =>
              omitNullOptionalToolCallArguments(def.parameters, businessCall),
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
            execute: businessCall =>
              match.tool.execute(executionInput(match.tool, businessCall, call, idempotencyKey))
          })
        : businessCallFor(def, call).pipe(
            Effect.flatMap(normalized =>
              match.tool.execute(executionInput(match.tool, normalized, call, idempotencyKey))
            )
          )
    }

    // Model-facing dispatch: codemode-only tools are unknown here (fail closed as not found).
    const execute = (call: ToolCall, executionOptions?: ToolExecutionOptions) =>
      executionOptions?.interaction !== undefined
        ? executeInteractionTool({
            registration: resolved.find(item => item.tool.def.name === call.name)?.tool,
            handler: interactionOf(resolved.find(item => item.tool.def.name === call.name)?.tool),
            call,
            context,
            ref: executionOptions.interaction,
            host: options.interactionHost
          })
        : Option.match(
            Arr.findFirst(
              resolved,
              item => item.tool.def.name === call.name && item.tool.def.callableBy !== 'codemode'
            ),
            {
              onNone: () => Effect.fail(missingToolError(call.name)),
              onSome: match => executeRegistration(match, call, executionOptions)
            }
          )

    const nestedFor = (parent: ToolCall): NestedToolExecutor => {
      const executor: NestedToolExecutorFields = {
        tools: nestedTools,
        execute: nestedExecute(parent)
      }

      if (planResolution !== undefined)
        executor.staging = makeToolPlanStaging(planResolution, parent)

      return executor
    }

    const nestedExecute =
      (parent: ToolCall): NestedToolExecutor['execute'] =>
      call =>
        Option.match(
          Arr.findFirst(nestedRegistrations, item => item.tool.def.name === call.name),
          {
            onNone: () => {
              const known = resolved.some(item => item.tool.def.name === call.name)

              return Effect.succeed(
                modelVisibleToolErrorResult(
                  call,
                  modelVisibleToolError({
                    tool: call.name,
                    reason: known ? 'unavailable' : 'not_found',
                    message: known
                      ? `Tool is not callable from code mode: ${call.name}`
                      : `Tool is not configured: ${call.name}`
                  })
                )
              )
            },
            onSome: match =>
              executeRegistration(match, call, undefined, parent.id).pipe(
                Effect.catchTag('ToolError', error =>
                  Effect.succeed(
                    makeErrorToolResult({ toolCallId: call.id, content: error.message })
                  )
                )
              )
          }
        )

    const toolSet: ResolvedToolSet = {
      tools,
      metadata,
      execute,
      inputs,
      interactions,
      interactionHost: options.interactionHost
    }

    return planResolution === undefined
      ? toolSet
      : {
          ...toolSet,
          plans: {
            store: planResolution.store,
            reviewToolName: planResolution.reviewToolName,
            preview: previewToolPlanWith(planResolution),
            previewStored: previewStoredToolPlanWith(planResolution)
          }
        }
  })

export const makeToolExecutorLayer = (toolSet: ResolvedToolSet) =>
  Layer.succeed(ToolExecutor, ToolExecutor.of({ execute: toolSet.execute }))
