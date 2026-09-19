import { Data, Effect, Match, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'
import { Content, TextPart } from './content.ts'

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

const isPlainObjectPrototype = (value: object) => {
  const proto = Object.getPrototypeOf(value)

  return proto === Object.prototype || proto === null
}

const dataOwnValue = (value: object, key: string): PropertyDescriptor | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)

  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    return undefined
  }

  return descriptor
}

const isPortableJsonArray = (
  value: Array<unknown>,
  onPath: Set<object>,
  validated: Set<object>
): boolean => {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    return false
  }

  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') {
      continue
    }

    if (!Predicate.isString(key)) {
      return false
    }

    const index = Number(key)

    if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
      return false
    }
  }

  for (let index = 0; index < value.length; index++) {
    const owned = dataOwnValue(value, String(index))

    if (owned === undefined || !isPortableJson(owned.value, onPath, validated)) {
      return false
    }
  }

  return true
}

const isPortableJsonObjectNode = (
  value: object,
  onPath: Set<object>,
  validated: Set<object>
): boolean => {
  if (!isPlainObjectPrototype(value)) {
    return false
  }

  for (const key of Reflect.ownKeys(value)) {
    if (!Predicate.isString(key)) {
      return false
    }

    const owned = dataOwnValue(value, key)

    if (owned === undefined || !isPortableJson(owned.value, onPath, validated)) {
      return false
    }
  }

  return true
}

/** Plain JSON data: null, boolean, string, finite number, dense Array.prototype arrays,
 * and plain/null-prototype objects with enumerable data-only own string keys (including
 * own `__proto__` / `constructor`). Cycles fail; DAG aliases reuse memoized nodes.
 * Accessors are rejected via descriptors and are not invoked. Identity of admitted
 * values is preserved (not a Record snapshot). Not JSON Schema meta-schema validation.
 * Proxy traps on ownKeys/getOwnPropertyDescriptor are not claimed immune.
 */
const isPortableJson = (
  value: unknown,
  onPath: Set<object>,
  validated: Set<object>
): value is Schema.Json => {
  if (value === null || Predicate.isString(value) || Predicate.isBoolean(value)) {
    return true
  }

  if (Predicate.isNumber(value)) {
    return Number.isFinite(value)
  }

  if (!Predicate.isObjectOrArray(value)) {
    return false
  }

  if (onPath.has(value)) {
    return false
  }

  if (validated.has(value)) {
    return true
  }

  onPath.add(value)

  const portable = Array.isArray(value)
    ? isPortableJsonArray(value, onPath, validated)
    : Predicate.isObject(value) && isPortableJsonObjectNode(value, onPath, validated)

  onPath.delete(value)

  if (portable) {
    validated.add(value)
  }

  return portable
}

const isPortableJsonObject = (value: unknown): value is Schema.JsonObject =>
  Predicate.isObject(value) && isPortableJson(value, new Set(), new Set())

/** Provider-facing JSON Schema object node. Unknown annotation keywords are legal
 * JSON values. Root shape is not a claim of full JSON Schema semantic validity.
 * Failure issues omit the unsafe input: constructor error formatting must not
 * walk it again and invoke rejected accessors.
 */
export const ToolJsonSchemaObject = Schema.declareConstructor<Schema.JsonObject>()(
  [],
  () => input =>
    isPortableJsonObject(input)
      ? Effect.succeed(input)
      : Effect.fail(
          new SchemaIssue.InvalidValue({
            message: 'Expected a plain JSON Schema object'
          })
        ),
  {
    identifier: 'ToolJsonSchemaObject',
    title: 'JSON Schema object',
    description:
      'Plain JSON object representation for tool parameter documents. Identity-preserving; accessors, exotic prototypes, nonfinite values, and cycles are rejected.',
    expected: 'plain JSON Schema object'
  }
)

export type ToolJsonSchemaObject = typeof ToolJsonSchemaObject.Type

/** JSON Schema representation: boolean schema or plain JSON object.
 * One admission avoids a failing Boolean union branch retaining unsafe input.
 */
export const ToolJsonSchema = Schema.declareConstructor<boolean | Schema.JsonObject>()(
  [],
  () => input =>
    Predicate.isBoolean(input) || isPortableJsonObject(input)
      ? Effect.succeed(input)
      : Effect.fail(
          new SchemaIssue.InvalidValue({
            message: 'Expected a boolean or plain JSON Schema object'
          })
        ),
  { identifier: 'ToolJsonSchema', title: 'JSON Schema representation' }
)

export type ToolJsonSchema = typeof ToolJsonSchema.Type

export const decodeToolJsonSchema = Schema.decodeUnknownOption(ToolJsonSchema)

export const decodeToolJsonSchemaObject = Schema.decodeUnknownOption(ToolJsonSchemaObject)

export const isToolJsonSchemaObject = (schema: ToolJsonSchema): schema is ToolJsonSchemaObject =>
  !Predicate.isBoolean(schema)

export const HitlResponseSource = Schema.Literals(['user', 'policy', 'replay'])

export type HitlResponseSource = typeof HitlResponseSource.Type

export const ToolApprovalDecision = Schema.Literals(['approved', 'denied'])

export type ToolApprovalDecision = typeof ToolApprovalDecision.Type

export const ToolApprovalMode = Schema.Literals(['manual'])

export type ToolApprovalMode = typeof ToolApprovalMode.Type

export class ToolApprovalPolicy extends Schema.Class<ToolApprovalPolicy>('ToolApprovalPolicy')({
  mode: ToolApprovalMode,
  reason: Schema.optional(Schema.String)
}) {}

export class ToolCall extends Schema.Class<ToolCall>('ToolCall')({
  id: NonEmptyTrimmedString,
  name: NonEmptyTrimmedString,
  params: Schema.Unknown
}) {}

/** Serializable input descriptor for generalized typed input tools. Display metadata only:
 * user payloads are JSON-only and validated server-side against the registration's original
 * Effect Schema, never against this lowered hint. Renderer components remain app-owned;
 * `kind` is an opaque stable renderer key chosen at registration time.
 */
export class InputDescriptor extends Schema.Class<InputDescriptor>('InputDescriptor')({
  kind: NonEmptyTrimmedString,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  schema: Schema.optional(ToolJsonSchema)
}) {}

/** One server-defined action offered by an interaction. Display information only:
 * never credentials, callbacks, or executable permissions.
 */
export class InteractionActionDescriptor extends Schema.Class<InteractionActionDescriptor>(
  'InteractionActionDescriptor'
)({
  id: NonEmptyTrimmedString,
  label: NonEmptyTrimmedString,
  description: Schema.optional(Schema.String)
}) {}

/** Serializable interaction descriptor for action-backed interaction tools.
 * Display metadata only: submitted values are JSON-only and validated server-side
 * against the registration's original Effect Schemas, never against this lowered hint.
 * Renderer components remain app-owned; `kind` is an opaque stable renderer key
 * chosen at registration time. Action ids, labels, validators, and handlers are
 * server-defined; only ids and display labels travel to the client.
 */
export class InteractionDescriptor extends Schema.Class<InteractionDescriptor>(
  'InteractionDescriptor'
)({
  kind: NonEmptyTrimmedString,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  schema: Schema.optional(ToolJsonSchema),
  actions: Schema.NonEmptyArray(InteractionActionDescriptor)
}) {}

export class ToolDef extends Schema.Class<ToolDef>('ToolDef')({
  name: NonEmptyTrimmedString,
  description: Schema.String,
  /** JSON Schema representation only (boolean | plain object). Not tool args, results, or HITL. */
  parameters: ToolJsonSchema,
  approval: Schema.optional(ToolApprovalPolicy),
  background: Schema.optional(Schema.Boolean),
  execution: Schema.optional(Schema.Literal('background-v1')),
  /** Present only on generalized typed input tools. Never combined with approval/background. */
  input: Schema.optional(InputDescriptor),
  /** Present only on action-backed interaction tools. Never combined with approval/background/input. */
  interaction: Schema.optional(InteractionDescriptor)
}) {}

export const BackgroundToolExecution = Schema.Literals(['foreground', 'background'])

export type BackgroundToolExecution = typeof BackgroundToolExecution.Type

/** Model-facing envelope of an activated (`execution: 'background-v1'`) tool call. Control fields
 * never reach business params; `arguments` carries the original tool parameters unchanged.
 */
export class BackgroundToolInput extends Schema.Class<BackgroundToolInput>('BackgroundToolInput')({
  execution: BackgroundToolExecution,
  arguments: Schema.Json
}) {}

/** Exact envelope decode: omitted, unknown, or extra control fields are rejected. */
export const decodeBackgroundToolInput = Schema.decodeUnknownOption(BackgroundToolInput, {
  onExcessProperty: 'error'
})

/** Admission receipt, not a terminal execution result. Handles are opaque and host-scoped. */
export class BackgroundToolAccepted extends Schema.Class<BackgroundToolAccepted>(
  'BackgroundToolAccepted'
)({
  version: Schema.Literal(1),
  executionId: NonEmptyTrimmedString
}) {}

export class ToolResult extends Schema.Class<ToolResult>('ToolResult')({
  toolCallId: NonEmptyTrimmedString,
  content: Content,
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
  acceptance: Schema.optional(BackgroundToolAccepted)
}) {}

/** One provider-facing acknowledgement for the original call; never append its terminal result again. */
export const makeBackgroundToolAcceptedResult = (input: {
  readonly toolCallId: string
  readonly acceptance: BackgroundToolAccepted
}) =>
  ToolResult.make({
    toolCallId: input.toolCallId,
    acceptance: input.acceptance,
    content: `Background execution accepted: ${input.acceptance.executionId}. This is not completion. Use host-provided status/wait tools or await host delivery.`,
    structuredContent: {
      type: 'background_tool_accepted',
      version: input.acceptance.version,
      executionId: input.acceptance.executionId
    }
  })

export type ErrorToolResultInput = {
  readonly toolCallId: string
  readonly content: Content
  readonly structuredContent?: unknown
}

type ErrorToolResultFields = {
  toolCallId: ErrorToolResultInput['toolCallId']
  content: ErrorToolResultInput['content']
  isError: true
  structuredContent?: ErrorToolResultInput['structuredContent']
}

export const makeErrorToolResult = (input: ErrorToolResultInput) =>
  ToolResult.make(
    (() => {
      const fields: ErrorToolResultFields = {
        toolCallId: input.toolCallId,
        content: input.content,
        isError: true
      }

      if (input.structuredContent !== undefined) {
        fields.structuredContent = input.structuredContent
      }

      return fields
    })()
  )

export class ToolApprovalRequest extends Schema.TaggedClass<ToolApprovalRequest>()(
  'ToolApprovalRequest',
  {
    requestId: NonEmptyTrimmedString,
    toolCallId: NonEmptyTrimmedString,
    call: ToolCall,
    policy: Schema.optional(ToolApprovalPolicy)
  }
) {}

export class ToolApprovalResponse extends Schema.TaggedClass<ToolApprovalResponse>()(
  'ToolApprovalResponse',
  {
    requestId: NonEmptyTrimmedString,
    toolCallId: NonEmptyTrimmedString,
    decision: ToolApprovalDecision,
    source: HitlResponseSource,
    reason: Schema.optional(Schema.String)
  }
) {}

export class QuestionOption extends Schema.Class<QuestionOption>('QuestionOption')({
  id: NonEmptyTrimmedString,
  label: NonEmptyTrimmedString,
  description: Schema.optional(Schema.String)
}) {}

export class QuestionPrompt extends Schema.Class<QuestionPrompt>('QuestionPrompt')({
  id: NonEmptyTrimmedString,
  prompt: NonEmptyTrimmedString,
  options: Schema.optional(Schema.Array(QuestionOption)),
  multiple: Schema.optional(Schema.Boolean),
  allowCustom: Schema.optional(Schema.Boolean),
  required: Schema.optional(Schema.Boolean)
}) {}

export class QuestionToolParams extends Schema.Class<QuestionToolParams>('QuestionToolParams')({
  questions: Schema.NonEmptyArray(QuestionPrompt)
}) {}

export class QuestionRequest extends Schema.TaggedClass<QuestionRequest>()('QuestionRequest', {
  requestId: NonEmptyTrimmedString,
  toolCallId: NonEmptyTrimmedString,
  call: ToolCall,
  questions: Schema.NonEmptyArray(QuestionPrompt)
}) {}

export class QuestionAnswer extends Schema.Class<QuestionAnswer>('QuestionAnswer')({
  questionId: NonEmptyTrimmedString,
  optionIds: Schema.optional(Schema.Array(NonEmptyTrimmedString)),
  customAnswer: Schema.optional(Schema.String)
}) {}

export type PlainQuestionAnswer = {
  readonly questionId: string
  readonly optionIds?: ReadonlyArray<string>
  readonly customAnswer?: string
}

export const QuestionResponseOutcome = Schema.Literals(['answered', 'cancelled'])

export type QuestionResponseOutcome = typeof QuestionResponseOutcome.Type

export class QuestionResponse extends Schema.TaggedClass<QuestionResponse>()('QuestionResponse', {
  requestId: NonEmptyTrimmedString,
  toolCallId: NonEmptyTrimmedString,
  outcome: QuestionResponseOutcome,
  source: HitlResponseSource,
  answers: Schema.optional(Schema.Array(QuestionAnswer)),
  reason: Schema.optional(Schema.String)
}) {}

export const InputResponseOutcome = Schema.Literals(['submitted', 'cancelled'])

export type InputResponseOutcome = typeof InputResponseOutcome.Type

export class InputRequest extends Schema.TaggedClass<InputRequest>()('InputRequest', {
  requestId: NonEmptyTrimmedString,
  toolCallId: NonEmptyTrimmedString,
  call: ToolCall,
  input: InputDescriptor
}) {}

export class InputResponse extends Schema.TaggedClass<InputResponse>()('InputResponse', {
  requestId: NonEmptyTrimmedString,
  toolCallId: NonEmptyTrimmedString,
  outcome: InputResponseOutcome,
  source: HitlResponseSource,
  /** JSON-only user payload. Validated server-side against the original Effect Schema. */
  data: Schema.optional(Schema.Json),
  reason: Schema.optional(Schema.String)
}) {}

export const InteractionResponseOutcome = Schema.Literals(['submitted', 'cancelled'])

export type InteractionResponseOutcome = typeof InteractionResponseOutcome.Type

/** Distinct request for an action-backed interaction. Never overload `InputRequest`:
 * old clients must not downgrade an interaction to data-only completion.
 * Execution scope and pending-generation identity come from the host, never the model.
 */
export class InteractionRequest extends Schema.TaggedClass<InteractionRequest>()(
  'InteractionRequest',
  {
    requestId: NonEmptyTrimmedString,
    toolCallId: NonEmptyTrimmedString,
    call: ToolCall,
    interaction: InteractionDescriptor
  }
) {}

/** Distinct response for an action-backed interaction. A submission selects one
 * server-defined action with final edited values; cancellation selects nothing
 * and executes no business handler. A raw `submitted` response is only a candidate,
 * never authenticated acceptance or business success.
 */
export class InteractionResponse extends Schema.TaggedClass<InteractionResponse>()(
  'InteractionResponse',
  {
    requestId: NonEmptyTrimmedString,
    toolCallId: NonEmptyTrimmedString,
    outcome: InteractionResponseOutcome,
    source: HitlResponseSource,
    /** Selected server-defined action. Absent on cancellation; never inferred. */
    actionId: Schema.optional(NonEmptyTrimmedString),
    /** JSON-only final values. Validated server-side against the original Effect Schema. */
    data: Schema.optional(Schema.Json),
    reason: Schema.optional(Schema.String)
  }
) {}

export type PlainHitlResponse = Data.TaggedEnum<{
  QuestionResponse: {
    readonly requestId: string
    readonly toolCallId: string
    readonly outcome: QuestionResponseOutcome
    readonly source: HitlResponseSource
    readonly answers?: ReadonlyArray<PlainQuestionAnswer>
    readonly reason?: string
  }
  ToolApprovalResponse: {
    readonly requestId: string
    readonly toolCallId: string
    readonly decision: ToolApprovalDecision
    readonly source: HitlResponseSource
    readonly reason?: string
  }
  InputResponse: {
    readonly requestId: string
    readonly toolCallId: string
    readonly outcome: InputResponseOutcome
    readonly source: HitlResponseSource
    readonly data?: Schema.Json
    readonly reason?: string
  }
  InteractionResponse: {
    readonly requestId: string
    readonly toolCallId: string
    readonly outcome: InteractionResponseOutcome
    readonly source: HitlResponseSource
    readonly actionId?: string
    readonly data?: Schema.Json
    readonly reason?: string
  }
}>

export const PlainHitlResponse = Data.taggedEnum<PlainHitlResponse>()

export type PlainInputResponse = Extract<PlainHitlResponse, { readonly _tag: 'InputResponse' }>

export type PlainInteractionResponse = Extract<
  PlainHitlResponse,
  { readonly _tag: 'InteractionResponse' }
>

export type PlainQuestionResponse = Extract<
  PlainHitlResponse,
  { readonly _tag: 'QuestionResponse' }
>

export type PlainToolApprovalResponse = Extract<
  PlainHitlResponse,
  { readonly _tag: 'ToolApprovalResponse' }
>

export type QuestionResponseStructuredContent = {
  readonly type: 'question_response'
  readonly outcome: QuestionResponseOutcome
  readonly answers: ReadonlyArray<PlainQuestionAnswer>
  readonly reason?: string
  readonly source: HitlResponseSource
}

export const plainQuestionAnswer = (answer: QuestionAnswer): PlainQuestionAnswer => {
  type PlainQuestionAnswerFields = {
    questionId: PlainQuestionAnswer['questionId']
    optionIds?: PlainQuestionAnswer['optionIds']
    customAnswer?: PlainQuestionAnswer['customAnswer']
  }

  const fields: PlainQuestionAnswerFields = {
    questionId: answer.questionId
  }

  if (answer.optionIds !== undefined) {
    fields.optionIds = [...answer.optionIds]
  }

  if (answer.customAnswer !== undefined) {
    fields.customAnswer = answer.customAnswer
  }

  return fields
}

export const plainQuestionResponse = (response: QuestionResponse): PlainQuestionResponse => {
  type PlainQuestionResponseFields = {
    requestId: PlainQuestionResponse['requestId']
    toolCallId: PlainQuestionResponse['toolCallId']
    outcome: PlainQuestionResponse['outcome']
    source: PlainQuestionResponse['source']
    answers?: PlainQuestionResponse['answers']
    reason?: PlainQuestionResponse['reason']
  }

  const fields: PlainQuestionResponseFields = {
    requestId: response.requestId,
    toolCallId: response.toolCallId,
    outcome: response.outcome,
    source: response.source
  }

  if (response.answers !== undefined) {
    fields.answers = response.answers.map(answer => plainQuestionAnswer(answer))
  }

  if (response.reason !== undefined) {
    fields.reason = response.reason
  }

  return PlainHitlResponse.QuestionResponse(fields)
}

export const plainToolApprovalResponse = (
  response: ToolApprovalResponse
): PlainToolApprovalResponse => {
  type PlainToolApprovalResponseFields = {
    requestId: PlainToolApprovalResponse['requestId']
    toolCallId: PlainToolApprovalResponse['toolCallId']
    decision: PlainToolApprovalResponse['decision']
    source: PlainToolApprovalResponse['source']
    reason?: PlainToolApprovalResponse['reason']
  }

  const fields: PlainToolApprovalResponseFields = {
    requestId: response.requestId,
    toolCallId: response.toolCallId,
    decision: response.decision,
    source: response.source
  }

  if (response.reason !== undefined) {
    fields.reason = response.reason
  }

  return PlainHitlResponse.ToolApprovalResponse(fields)
}

export const plainInputResponse = (response: InputResponse): PlainInputResponse => {
  type PlainInputResponseFields = {
    requestId: PlainInputResponse['requestId']
    toolCallId: PlainInputResponse['toolCallId']
    outcome: PlainInputResponse['outcome']
    source: PlainInputResponse['source']
    data?: PlainInputResponse['data']
    reason?: PlainInputResponse['reason']
  }

  const fields: PlainInputResponseFields = {
    requestId: response.requestId,
    toolCallId: response.toolCallId,
    outcome: response.outcome,
    source: response.source
  }

  if (response.data !== undefined) {
    fields.data = response.data
  }

  if (response.reason !== undefined) {
    fields.reason = response.reason
  }

  return PlainHitlResponse.InputResponse(fields)
}

export const plainInteractionResponse = (
  response: InteractionResponse
): PlainInteractionResponse => {
  type PlainInteractionResponseFields = {
    requestId: PlainInteractionResponse['requestId']
    toolCallId: PlainInteractionResponse['toolCallId']
    outcome: PlainInteractionResponse['outcome']
    source: PlainInteractionResponse['source']
    actionId?: PlainInteractionResponse['actionId']
    data?: PlainInteractionResponse['data']
    reason?: PlainInteractionResponse['reason']
  }

  const fields: PlainInteractionResponseFields = {
    requestId: response.requestId,
    toolCallId: response.toolCallId,
    outcome: response.outcome,
    source: response.source
  }

  if (response.actionId !== undefined) {
    fields.actionId = response.actionId
  }

  if (response.data !== undefined) {
    fields.data = response.data
  }

  if (response.reason !== undefined) {
    fields.reason = response.reason
  }

  return PlainHitlResponse.InteractionResponse(fields)
}

export const plainHitlResponse = (response: HitlResponse): PlainHitlResponse =>
  Match.value(response).pipe(
    Match.tag('QuestionResponse', current => plainQuestionResponse(current)),
    Match.tag('ToolApprovalResponse', current => plainToolApprovalResponse(current)),
    Match.tag('InputResponse', current => plainInputResponse(current)),
    Match.tag('InteractionResponse', current => plainInteractionResponse(current)),
    Match.exhaustive
  )

export type InputResponseStructuredContent = {
  readonly type: 'input_response'
  readonly name: string
  readonly outcome: InputResponseOutcome
  readonly data?: Schema.Json
  readonly reason?: string
  readonly source: HitlResponseSource
}

export const inputResponseStructuredContent = (
  response: InputResponse,
  name: string
): InputResponseStructuredContent => {
  type InputResponseStructuredContentFields = {
    type: 'input_response'
    name: InputResponseStructuredContent['name']
    outcome: InputResponseStructuredContent['outcome']
    data?: InputResponseStructuredContent['data']
    reason?: InputResponseStructuredContent['reason']
  }

  const fields: InputResponseStructuredContentFields = {
    type: 'input_response',
    name,
    outcome: response.outcome
  }

  if (response.data !== undefined) {
    fields.data = response.data
  }

  if (response.reason !== undefined) {
    fields.reason = response.reason
  }

  return { ...fields, source: response.source }
}

export const formatInputResponseContent = (response: InputResponse, name: string) => {
  if (response.outcome === 'cancelled') {
    return `Input cancelled: ${response.reason ?? 'Input cancelled'}`
  }

  const data = response.data === undefined ? 'no data' : JSON.stringify(response.data)

  return `User has provided input for "${name}": ${data}. Continue with the user's input in mind.`
}

export const questionResponseStructuredContent = (
  response: QuestionResponse
): QuestionResponseStructuredContent => {
  type QuestionResponseStructuredContentPrefix = {
    type: 'question_response'
    outcome: QuestionResponseStructuredContent['outcome']
    answers: QuestionResponseStructuredContent['answers']
    reason?: QuestionResponseStructuredContent['reason']
  }

  const fields: QuestionResponseStructuredContentPrefix = {
    type: 'question_response',
    outcome: response.outcome,
    answers: (response.answers ?? []).map(answer => plainQuestionAnswer(answer))
  }

  if (response.reason !== undefined) {
    fields.reason = response.reason
  }

  return { ...fields, source: response.source }
}

const optionLabel = (question: QuestionPrompt, optionId: string) =>
  question.options?.find(option => option.id === optionId)?.label ?? optionId

const questionForAnswer = (questions: ReadonlyArray<QuestionPrompt>, answer: QuestionAnswer) =>
  questions.find(question => question.id === answer.questionId)

const formatQuestionAnswer = (answer: QuestionAnswer, questions: ReadonlyArray<QuestionPrompt>) => {
  const question = questionForAnswer(questions, answer)
  const prompt = question?.prompt ?? answer.questionId

  const selected =
    answer.optionIds?.map(optionId =>
      question === undefined ? optionId : optionLabel(question, optionId)
    ) ?? []

  const custom = answer.customAnswer?.trim()
  const values = custom === undefined || custom.length === 0 ? selected : [...selected, custom]

  return values.length === 0 ? `- ${prompt}: answered` : `- ${prompt}: ${values.join(', ')}`
}

export const formatQuestionResponseContent = (
  response: QuestionResponse,
  questions: ReadonlyArray<QuestionPrompt> = []
) => {
  if (response.outcome === 'cancelled') {
    return `Question cancelled: ${response.reason ?? 'Question cancelled'}`
  }

  const answers = response.answers ?? []

  if (answers.length === 0) {
    return 'User answered the question, but no answer values were provided. Continue with this in mind.'
  }

  const formatted = answers
    .map(answer => formatQuestionAnswer(answer, questions).slice('- '.length))
    .join('; ')

  const label = answers.length === 1 ? 'question' : 'questions'

  return `User has answered your ${label}: ${formatted}. Continue with the user's answers in mind.`
}

export const HitlRequest = Schema.Union([
  ToolApprovalRequest,
  QuestionRequest,
  InputRequest,
  InteractionRequest
])

export type HitlRequest = typeof HitlRequest.Type

export const HitlResponse = Schema.Union([
  ToolApprovalResponse,
  QuestionResponse,
  InputResponse,
  InteractionResponse
])

export type HitlResponse = typeof HitlResponse.Type

/** Stable request/call correlation for generalized input tools. Binds tool name and call id;
 * hosts must echo the opaque id and never rebuild it. Distinct from `question:<callId>` ids.
 */
export const inputRequestId = (call: ToolCall) => `input:${call.name}:${call.id}`

/** Server-side validator for one input tool's JSON user payload. Decodes with the
 * registration's original Effect Schema; JSON Schema lowering is display-only.
 */
export type InputResponseValidator = (data: unknown) => Effect.Effect<unknown, Schema.SchemaError>

/** Narrow loop seam for generalized input tools. Validators are provided separately from
 * the serializable ToolDef (see ResolvedToolSet.inputs); hosts pass them explicitly to
 * prepareToolBatch/runToolBatch/run/RuntimeConfig.
 */
export type InputContentFormatter = (input: {
  readonly name: string
  readonly data: Schema.Json
}) => string

export type InputToolHandler = {
  /** Validate model-supplied context before opening a request or accepting a response. */
  readonly validateCall: InputResponseValidator
  readonly validateResponse: InputResponseValidator
  readonly formatContent: InputContentFormatter
}

/** Stable request/call correlation for action-backed interactions. Binds tool name and
 * call id; hosts must echo the opaque id and never rebuild it. Distinct from
 * `input:<name>:<callId>`, `question:<callId>`, and `approval:<callId>` ids.
 */
export const interactionRequestId = (call: ToolCall) => `interaction:${call.name}:${call.id}`

/** Server-side validator for one interaction tool's JSON values. Decodes with the
 * registration's original Effect Schema; JSON Schema lowering is display-only.
 */
export type InteractionResponseValidator = (
  data: unknown
) => Effect.Effect<unknown, Schema.SchemaError | InteractionValidationError>

export class InteractionValidationError extends Schema.TaggedError<InteractionValidationError>()(
  'InteractionValidationError',
  { message: Schema.String }
) {}

/** Narrow loop preflight seam for action-backed interactions. Validators and the
 * server-defined action list are provided separately from the serializable ToolDef
 * (see ResolvedToolSet.interactions); hosts pass them explicitly to
 * prepareToolBatch/runToolBatch/run/RuntimeConfig. Preflight never claims,
 * settles, or invokes an action.
 */
export type InteractionPreflight = {
  /** Validate model-supplied context before opening a request or accepting a response. */
  readonly validateCall: InteractionResponseValidator
  readonly validateResponse: InteractionResponseValidator
  /** Server-defined action ids. Membership is checked; labels stay display-only. */
  readonly actionIds: ReadonlyArray<string>
  /** Bound fresh host policy. Admission invokes this before accepting; not authentication. */
  readonly validateAction: (input: {
    readonly actionId: string
    readonly data: Schema.Json
    readonly call: ToolCall
  }) => Effect.Effect<void, InteractionValidationError | Schema.SchemaError>
}

/** Host-allocated opaque identity. Neither field authenticates consent. The host adapter
 * is already scoped to the active session/run/pending generation before any lookup. */
export type InteractionRef = {
  readonly slot: string
  readonly submissionId: string
}

export const InteractionReceiptStatus = Schema.Literals(['accepted', 'started', 'settled'])

export type InteractionReceiptStatus = typeof InteractionReceiptStatus.Type

/** Authoritative host-owned record of an accepted submission and its observed
 * outcome. One pending interaction has one immutable acceptance slot; identical
 * retries reuse it, changed values or actions conflict after acceptance.
 */
export class InteractionReceipt extends Schema.Class<InteractionReceipt>('InteractionReceipt')({
  slot: NonEmptyTrimmedString,
  submissionId: NonEmptyTrimmedString,
  outcome: InteractionResponseOutcome,
  actionId: Schema.optional(NonEmptyTrimmedString),
  data: Schema.optional(Schema.Json),
  reason: Schema.optional(Schema.String),
  call: ToolCall,
  status: InteractionReceiptStatus,
  /** Present once the action outcome is observed. Replay returns it verbatim. */
  result: Schema.optional(ToolResult)
}) {}

export type InteractionClaim = Data.TaggedEnum<{
  Owned: { readonly token: string; readonly receipt: InteractionReceipt }
  Existing: { readonly receipt: InteractionReceipt }
}>

export const InteractionClaim = Data.taggedEnum<InteractionClaim>()

export const InteractionBusinessOutcome = Schema.Literals(['completed', 'failed', 'unknown'])

export type InteractionBusinessOutcome = typeof InteractionBusinessOutcome.Type

/** Observed business outcome. `unknown` is a truthful terminal observation: it
 * establishes neither success nor failure and must never auto-retry.
 */
export type InteractionOutcome = {
  readonly status: InteractionBusinessOutcome
  readonly result: ToolResult
}

export class InteractionHostError extends Schema.TaggedError<InteractionHostError>()(
  'InteractionHostError',
  {
    message: Schema.String,
    cause: Schema.Literals(['conflict', 'storage', 'denied', 'not_found'])
  }
) {}

/** Callbacks over host storage, scoped to the active session/run/generation, not
 * a global lookup by model-supplied call ID. The host authenticates, validates using
 * validateInteractionSubmission, checks ownership/policy, then atomically ACCEPTS
 * in its own transaction BEFORE SDK resume. Invalid attempts consume nothing.
 * claim only advances an existing accepted record to started with a fencing token.
 * All actions and cancellation compete for ONE immutable slot. Started records never
 * permit takeover, even after a crash. read must return independent immutable snapshots.
 * settle is token-fenced, idempotent and never overwrites a settled observation. */
export type InteractionHost = {
  readonly read: (
    slot: string
  ) => Effect.Effect<InteractionReceipt | undefined, InteractionHostError>
  readonly claim: (ref: InteractionRef) => Effect.Effect<InteractionClaim, InteractionHostError>
  readonly settle: (
    token: string,
    outcome: InteractionOutcome
  ) => Effect.Effect<InteractionOutcome, InteractionHostError>
}

export type InteractionCandidate = Data.TaggedEnum<{
  Submitted: {
    readonly slot: string
    readonly actionId: string
    readonly data: Schema.Json
  }
  Cancelled: { readonly slot: string }
}>

export const InteractionCandidate = Data.taggedEnum<InteractionCandidate>()

export class InteractionAdmissionError extends Schema.TaggedError<InteractionAdmissionError>()(
  'InteractionAdmissionError',
  {
    message: Schema.String,
    cause: Schema.Literals([
      'request_mismatch',
      'invalid_response',
      'invalid_call',
      'missing_action',
      'unknown_action',
      'cancelled_with_payload',
      'missing_data',
      'invalid_data',
      'action_rejected'
    ])
  }
) {}

const isInteractionJsonObject = (
  value: Schema.Json
): value is { readonly [key: string]: Schema.Json } => Predicate.isObject(value)

const canonicalInteractionJson = (value: Schema.Json): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalInteractionJson).join(',')}]`

  if (isInteractionJsonObject(value)) {
    const encoded = Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalInteractionJson(value[key])}`)

    return `{${encoded.join(',')}}`
  }

  return JSON.stringify(value)
}

/** Exact JSON value equality, independent of object key ordering. Reject non-JSON
 * values rather than using JSON.stringify's lossy omission/coercion behavior. */
export const interactionJsonEquals = (left: unknown, right: unknown): boolean =>
  isPortableJson(left, new Set(), new Set()) &&
  isPortableJson(right, new Set(), new Set()) &&
  canonicalInteractionJson(left) === canonicalInteractionJson(right)

/** Check full immutable binding, not only receipt identity. Status may advance. */
export const sameInteractionBinding = (left: InteractionReceipt, right: InteractionReceipt) =>
  left.slot === right.slot &&
  left.submissionId === right.submissionId &&
  left.outcome === right.outcome &&
  left.actionId === right.actionId &&
  left.reason === right.reason &&
  (left.data === undefined
    ? right.data === undefined
    : interactionJsonEquals(left.data, right.data)) &&
  sameInteractionCall(left.call, right.call)

export const sameInteractionCall = (left: ToolCall, right: ToolCall) =>
  left.id === right.id &&
  left.name === right.name &&
  interactionJsonEquals(left.params, right.params)

/** Runtime checking also protects JavaScript adapters and malformed concurrent reads.
 * Stored results must identify the exact accepted operation. */
export const validInteractionReceipt = (
  receipt: InteractionReceipt,
  call: ToolCall,
  ref?: InteractionRef
): boolean => {
  if (
    !Schema.is(Schema.Struct(InteractionReceipt.fields))(receipt) ||
    receipt.slot !== interactionRequestId(call) ||
    !sameInteractionCall(receipt.call, call) ||
    (ref !== undefined && (receipt.slot !== ref.slot || receipt.submissionId !== ref.submissionId))
  )
    return false

  if (receipt.outcome === 'cancelled') {
    const content = receipt.result?.structuredContent

    return (
      receipt.actionId === undefined &&
      receipt.data === undefined &&
      receipt.status === 'settled' &&
      receipt.result?.toolCallId === call.id &&
      receipt.result.isError === true &&
      Schema.is(Schema.Record(Schema.String, Schema.Unknown))(content) &&
      content.type === 'interaction_outcome' &&
      content.outcome === 'cancelled' &&
      content.slot === receipt.slot &&
      content.requestId === receipt.slot &&
      content.submissionId === receipt.submissionId
    )
  }

  if (receipt.actionId === undefined || receipt.data === undefined) return false

  if (receipt.status !== 'settled') return receipt.result === undefined
  const result = receipt.result

  if (result === undefined || result.toolCallId !== call.id) return false
  const content = result.structuredContent

  return (
    Schema.is(Schema.Record(Schema.String, Schema.Unknown))(content) &&
    content.type === 'interaction_outcome' &&
    content.slot === receipt.slot &&
    content.requestId === receipt.slot &&
    content.submissionId === receipt.submissionId &&
    content.actionId === receipt.actionId &&
    (content.outcome === 'completed'
      ? result.isError !== true
      : (content.outcome === 'failed' || content.outcome === 'unknown') && result.isError === true)
  )
}

/** Side-effect-free admission check for one interaction response against its
 * authoritative pending request. Checks exact correlation, the original call
 * and response schemas (excess fields rejected, absent data distinct from
 * valid `null`/`false`/`0`), and the selected server action. Its output is a
 * validated candidate, **not authenticated consent**: the host still checks
 * caller auth, pending ownership, scope, and policy, then atomically accepts
 * the first valid submission. An invalid attempt consumes nothing.
 */
export const validateInteractionSubmission = (input: {
  readonly request: InteractionRequest
  readonly response: InteractionResponse
  readonly validateCall: InteractionResponseValidator
  readonly validateResponse: InteractionResponseValidator
  readonly actionIds: ReadonlyArray<string> | ReadonlySet<string>
  readonly validateAction: InteractionPreflight['validateAction']
}): Effect.Effect<InteractionCandidate, InteractionAdmissionError> =>
  Effect.gen(function* () {
    // Runtime decoding protects JavaScript callers too; nominal TypeScript types are
    // not admission. Keep shape checks distinct from original business schema checks.
    yield* Schema.decodeUnknownEffect(InteractionResponse, { onExcessProperty: 'error' })(
      input.response
    ).pipe(
      Effect.mapError(
        error =>
          new InteractionAdmissionError({ cause: 'invalid_response', message: error.message })
      )
    )

    const mismatch = (message: string): InteractionAdmissionError =>
      new InteractionAdmissionError({ message, cause: 'request_mismatch' })

    if (
      input.response.requestId !== input.request.requestId ||
      input.response.toolCallId !== input.request.toolCallId ||
      input.response.toolCallId !== input.request.call.id
    ) {
      return yield* Effect.fail(
        mismatch(`Interaction response does not match pending request ${input.request.requestId}`)
      )
    }

    if (input.response.outcome === 'cancelled') {
      if (input.response.actionId !== undefined || input.response.data !== undefined) {
        return yield* Effect.fail(
          new InteractionAdmissionError({
            message: 'Interaction cancellation must not select an action or carry data',
            cause: 'cancelled_with_payload'
          })
        )
      }

      return InteractionCandidate.Cancelled({ slot: input.request.requestId })
    }

    yield* input.validateCall(input.request.call.params).pipe(
      Effect.asVoid,
      Effect.mapError(
        error =>
          new InteractionAdmissionError({
            message: `Invalid interaction call: ${error.message}`,
            cause: 'invalid_call'
          })
      )
    )

    const actionId = input.response.actionId

    if (actionId === undefined) {
      return yield* Effect.fail(
        new InteractionAdmissionError({
          message: 'Interaction submission requires a server-defined action',
          cause: 'missing_action'
        })
      )
    }

    const known = (
      Array.isArray(input.actionIds) ? input.actionIds : [...input.actionIds]
    ).includes(actionId)

    if (!known) {
      return yield* Effect.fail(
        new InteractionAdmissionError({
          message: `Unknown interaction action: ${actionId}`,
          cause: 'unknown_action'
        })
      )
    }

    // Absent data (`undefined`) differs from valid `null`, `false`, and `0`.
    if (input.response.data === undefined) {
      return yield* Effect.fail(
        new InteractionAdmissionError({
          message: 'Interaction submission requires data',
          cause: 'missing_data'
        })
      )
    }

    const data = input.response.data

    yield* input.validateResponse(data).pipe(
      Effect.mapError(
        error =>
          new InteractionAdmissionError({
            message: `Invalid interaction data: ${error.message}`,
            cause: 'invalid_data'
          })
      )
    )

    yield* input.validateAction({ actionId, data, call: input.request.call }).pipe(
      Effect.mapError(
        error =>
          new InteractionAdmissionError({
            message: error.message,
            cause: 'action_rejected'
          })
      )
    )

    return InteractionCandidate.Submitted({
      slot: input.request.requestId,
      actionId,
      data
    })
  })

export type InteractionResponseStructuredContent = {
  readonly type: 'interaction_response'
  readonly name: string
  readonly outcome: InteractionResponseOutcome
  readonly actionId?: string
  readonly data?: Schema.Json
  readonly reason?: string
  readonly source: HitlResponseSource
}

export const interactionResponseStructuredContent = (
  response: InteractionResponse,
  name: string
): InteractionResponseStructuredContent => {
  type InteractionResponseStructuredContentFields = {
    type: 'interaction_response'
    name: InteractionResponseStructuredContent['name']
    outcome: InteractionResponseStructuredContent['outcome']
    actionId?: InteractionResponseStructuredContent['actionId']
    data?: InteractionResponseStructuredContent['data']
    reason?: InteractionResponseStructuredContent['reason']
  }

  const fields: InteractionResponseStructuredContentFields = {
    type: 'interaction_response',
    name,
    outcome: response.outcome
  }

  if (response.actionId !== undefined) {
    fields.actionId = response.actionId
  }

  if (response.data !== undefined) {
    fields.data = response.data
  }

  if (response.reason !== undefined) {
    fields.reason = response.reason
  }

  return { ...fields, source: response.source }
}

/** Model-visible text for a cancelled interaction. Submitted interactions never
 * synthesize a tool result: only an actual server execution result settles
 * the tool call, so no submitted formatter is provided.
 */
export const formatInteractionResponseContent = (response: InteractionResponse, name: string) =>
  `Interaction cancelled: ${response.reason ?? `Interaction ${name} cancelled`}`

export const interactionUnknownOutcomeNotice =
  'Outcome unknown: the action may have taken effect. Do not retry it automatically; reconcile out of band before proposing it again.'

/** Server execution result for one accepted interaction. Carries interaction
 * identity, the selected action, the receipt reference, and the explicit
 * business outcome. `unknown` is a truthful terminal observation with
 * `isError: true`; it never claims business success or failure and never
 * auto-retries. Only `failed` when the host establishes the action did not
 * take effect.
 */
export const makeInteractionToolResult = (input: {
  readonly toolCallId: string
  readonly requestId: string
  readonly slot: string
  readonly submissionId: string
  readonly actionId: string
  readonly outcome: InteractionBusinessOutcome
  readonly content: Content
  readonly structuredContent?: unknown
}): ToolResult => {
  const baseStructured = {
    type: 'interaction_outcome' as const,
    requestId: input.requestId,
    slot: input.slot,
    submissionId: input.submissionId,
    actionId: input.actionId,
    outcome: input.outcome
  }

  if (input.outcome === 'completed') {
    return input.structuredContent === undefined
      ? ToolResult.make({
          toolCallId: input.toolCallId,
          content: input.content,
          structuredContent: baseStructured
        })
      : ToolResult.make({
          toolCallId: input.toolCallId,
          content: input.content,
          structuredContent: { ...baseStructured, result: input.structuredContent }
        })
  }

  if (input.outcome === 'failed') {
    return input.structuredContent === undefined
      ? makeErrorToolResult({
          toolCallId: input.toolCallId,
          content: input.content,
          structuredContent: baseStructured
        })
      : makeErrorToolResult({
          toolCallId: input.toolCallId,
          content: input.content,
          structuredContent: { ...baseStructured, result: input.structuredContent }
        })
  }

  const content = Predicate.isString(input.content)
    ? `${input.content}\n\n${interactionUnknownOutcomeNotice}`
    : [...input.content, TextPart.make({ text: interactionUnknownOutcomeNotice })]

  return input.structuredContent === undefined
    ? makeErrorToolResult({
        toolCallId: input.toolCallId,
        content,
        structuredContent: baseStructured
      })
    : makeErrorToolResult({
        toolCallId: input.toolCallId,
        content,
        structuredContent: { ...baseStructured, result: input.structuredContent }
      })
}

// Canonical loop-owned names. Public compatibility exports remain on /tools.
export const questionToolName = 'question'

export const subagentToolName = 'subagent'
