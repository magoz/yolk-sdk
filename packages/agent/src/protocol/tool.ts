import { Match } from 'effect'
import * as Schema from 'effect/Schema'
import { Content } from './content.ts'

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

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
  parameters: Schema.Unknown,
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

export type PlainQuestionResponse = {
  readonly _tag: 'QuestionResponse'
  readonly requestId: string
  readonly toolCallId: string
  readonly outcome: QuestionResponseOutcome
  readonly source: HitlResponseSource
  readonly answers?: ReadonlyArray<PlainQuestionAnswer>
  readonly reason?: string
}

export type PlainToolApprovalResponse = {
  readonly _tag: 'ToolApprovalResponse'
  readonly requestId: string
  readonly toolCallId: string
  readonly decision: ToolApprovalDecision
  readonly source: HitlResponseSource
  readonly reason?: string
}

export type PlainHitlResponse = PlainToolApprovalResponse | PlainQuestionResponse

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
    _tag: 'QuestionResponse'
    requestId: PlainQuestionResponse['requestId']
    toolCallId: PlainQuestionResponse['toolCallId']
    outcome: PlainQuestionResponse['outcome']
    source: PlainQuestionResponse['source']
    answers?: PlainQuestionResponse['answers']
    reason?: PlainQuestionResponse['reason']
  }

  const fields: PlainQuestionResponseFields = {
    _tag: 'QuestionResponse',
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

  return fields
}

export const plainToolApprovalResponse = (
  response: ToolApprovalResponse
): PlainToolApprovalResponse => {
  type PlainToolApprovalResponseFields = {
    _tag: 'ToolApprovalResponse'
    requestId: PlainToolApprovalResponse['requestId']
    toolCallId: PlainToolApprovalResponse['toolCallId']
    decision: PlainToolApprovalResponse['decision']
    source: PlainToolApprovalResponse['source']
    reason?: PlainToolApprovalResponse['reason']
  }

  const fields: PlainToolApprovalResponseFields = {
    _tag: 'ToolApprovalResponse',
    requestId: response.requestId,
    toolCallId: response.toolCallId,
    decision: response.decision,
    source: response.source
  }

  if (response.reason !== undefined) {
    fields.reason = response.reason
  }

  return fields
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
