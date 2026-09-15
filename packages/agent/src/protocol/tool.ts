import { Data, Effect, Match, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'
import { Content } from './content.ts'

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

export class ToolDef extends Schema.Class<ToolDef>('ToolDef')({
  name: NonEmptyTrimmedString,
  description: Schema.String,
  /** JSON Schema representation only (boolean | plain object). Not tool args, results, or HITL. */
  parameters: ToolJsonSchema,
  approval: Schema.optional(ToolApprovalPolicy),
  background: Schema.optional(Schema.Boolean),
  execution: Schema.optional(Schema.Literal('background-v1'))
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
}>

export const PlainHitlResponse = Data.taggedEnum<PlainHitlResponse>()

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

export const plainHitlResponse = (response: HitlResponse): PlainHitlResponse =>
  Match.value(response).pipe(
    Match.tag('QuestionResponse', current => plainQuestionResponse(current)),
    Match.tag('ToolApprovalResponse', current => plainToolApprovalResponse(current)),
    Match.exhaustive
  )

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

export const HitlRequest = Schema.Union([ToolApprovalRequest, QuestionRequest])

export type HitlRequest = typeof HitlRequest.Type

export const HitlResponse = Schema.Union([ToolApprovalResponse, QuestionResponse])

export type HitlResponse = typeof HitlResponse.Type

// Canonical loop-owned names. Public compatibility exports remain on /tools.
export const questionToolName = 'question'

export const subagentToolName = 'subagent'
