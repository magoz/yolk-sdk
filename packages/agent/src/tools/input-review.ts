import { Data, Effect, Option, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk-sdk/agent/loop'
import {
  InteractionActionDescriptor,
  InteractionDescriptor,
  InteractionValidationError,
  inputRequiredNotice,
  maxInputReviewPauses,
  TextPart,
  ToolDef,
  ToolInputRequiredRef,
  type Content,
  type ContentPart,
  type InteractionBusinessOutcome,
  type InteractionHostError,
  type ToolCall,
  type ToolResult
} from '@yolk-sdk/agent/protocol'
import { NonEmptyTrimmedString } from '../protocol/input-required.ts'
import { decodeToolArguments } from './arguments.ts'
import {
  responseJsonSchemaFromSchema,
  toolJsonSchemaFromSchema,
  type InteractionActionResult,
  type ToolAccess,
  type ToolRegistration
} from './registry.ts'

/**
 * Input review (ADR 0014): finishing tool calls that paused for a person's input. A call that a
 * remote system paused (an MCP server asking a form) stores the pause host-side and returns
 * `makeInputRequiredToolResult`; the model then calls the input review tool with the pause ids,
 * a person answers each pause's form, and the review's action resumes each paused call once.
 */

/** Default name of the input review tool. */
export const inputReviewToolName = 'review_input'

/** Default `InteractionDescriptor.kind` (host renderer key) of the input review tool. */
export const inputReviewRenderer = 'input_review'

/** The input review tool's only action; cancelling the interaction sends nothing. */
export const inputReviewActionId = 'submit'

/** Model-facing parameters: the pause ids an input-required result named. */
export const InputReviewParams = Schema.Struct({
  pauseIds: Schema.NonEmptyArray(NonEmptyTrimmedString)
    .pipe(Schema.check(Schema.isMaxLength(maxInputReviewPauses)))
    .annotate({
      description: 'The pause ids the input-required results named, exactly.'
    })
})

export type InputReviewParams = typeof InputReviewParams.Type

/**
 * A person's answers: one JSON answer per reviewed pause, keyed by pause id. The host validates
 * each answer against its pause's form (`InputReviewHost.validateAnswer`).
 */
export const InputReviewResponse = Schema.Struct({
  answers: Schema.Record(Schema.String, Schema.Json)
})

export type InputReviewResponse = typeof InputReviewResponse.Type

/**
 * What resuming one paused call came to:
 * - `Completed`: the remote system answered; `result` is its result (possibly an error result).
 * - `InputRequired`: it asked again; the new pauses are stored and need another review.
 * - `NotSent`: nothing was sent (the pause or its target changed, or it was already answered).
 * - `Unknown`: it may or may not have run (the connection was lost after sending); never retried.
 */
export type InputPauseResolution = Data.TaggedEnum<{
  Completed: { readonly result: ToolResult }
  InputRequired: { readonly pauseIds: readonly [string, ...Array<string>] }
  NotSent: { readonly message: string }
  Unknown: { readonly message: string }
}>

export const InputPauseResolution = Data.taggedEnum<InputPauseResolution>()

/** A stored pause as the review needs it: its id and a person-readable label (what paused). */
export type InputPause = {
  readonly id: string
  readonly label: string
}

/** One pause with what resuming it came to (`undefined`: nothing recorded). */
export type InputPauseEntry = {
  readonly pause: InputPause
  readonly resolution: InputPauseResolution | undefined
}

/**
 * Host storage and resumption of paused calls, bound to the resolution's host context and scope
 * (a session). Pauses never come from model input: the model passes only ids, and every read goes
 * through `load`.
 */
export type InputReviewHost<Pause extends InputPause> = {
  /**
   * The listed pauses, in order: each present in the host's scope and still waiting for an answer.
   * A missing, foreign or answered id is an `InteractionValidationError`; unavailable storage an
   * `InteractionHostError` (never a verdict).
   */
  readonly load: (
    pauseIds: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<Pause>, InteractionValidationError | InteractionHostError>
  /** Whether a person's answer fits the pause's form. Side-effect free. */
  readonly validateAnswer: (input: {
    readonly pause: Pause
    readonly answer: Schema.Json
  }) => Effect.Effect<void, InteractionValidationError>
  /**
   * Resumes one paused call with its answer, at most once: the host claims the pause for
   * `submissionId` before sending, records the resolution, and never sends again after a claim
   * (a claim found without a recorded resolution is `Unknown`).
   */
  readonly resume: (input: {
    readonly pause: Pause
    readonly answer: Schema.Json
    readonly submissionId: string
    readonly reviewCall: ToolCall
  }) => Effect.Effect<InputPauseResolution>
  /**
   * The recorded resolutions of a review that started and has no receipt outcome (a crash, or a
   * redelivered step finding it started): one entry per listed pause, in order. Read only;
   * nothing is sent. Without it, such a review reports the generic unknown notice.
   */
  readonly recorded?: (input: {
    readonly pauseIds: ReadonlyArray<string>
    readonly submissionId: string
  }) => Effect.Effect<ReadonlyArray<InputPauseEntry>>
}

export const InputReviewPauseStatus = Schema.Literals([
  'completed',
  'input_required',
  'not_sent',
  'unknown'
])

export type InputReviewPauseStatus = typeof InputReviewPauseStatus.Type

/** One pause's outcome in an input review result. */
export const InputReviewPauseOutcome = Schema.Struct({
  pauseId: Schema.String,
  label: Schema.String,
  status: InputReviewPauseStatus,
  /** A `completed` call whose result is an error result. */
  isError: Schema.optionalKey(Schema.Literal(true)),
  /** Of `input_required`: the review that finishes the new pauses. */
  inputRequired: Schema.optionalKey(ToolInputRequiredRef),
  /** Of `not_sent` and `unknown`: why. */
  error: Schema.optionalKey(Schema.String)
})

export type InputReviewPauseOutcome = typeof InputReviewPauseOutcome.Type

/**
 * `structuredContent.result` of an input review's `interaction_outcome`: every reviewed pause's
 * outcome, in review order. Plain JSON; decode it with this Schema across process boundaries.
 */
export const InputReviewOutcome = Schema.Struct({
  type: Schema.Literal('input_review_outcome'),
  pauses: Schema.Array(InputReviewPauseOutcome),
  /** Set when the review stopped without recording outcomes (a crash): listed from the host. */
  interrupted: Schema.optionalKey(Schema.Literal(true))
})

export type InputReviewOutcome = typeof InputReviewOutcome.Type

export type MakeInputReviewToolOptions<Pause extends InputPause> = {
  /** Default `review_input`. */
  readonly name?: string
  readonly description?: string
  /** Host renderer key (`InteractionDescriptor.kind`). Default `input_review`. */
  readonly renderer?: string
  readonly title?: string
  readonly interactionDescription?: string
  /** Label of the submit action. Default `Send answers`. */
  readonly actionLabel?: string
  /** Default `write`: answers are sent to the system that paused the calls. */
  readonly access?: ToolAccess
  readonly host: InputReviewHost<Pause>
}

const defaultDescription =
  'Ask a person to answer the forms of tool calls that paused for input, then finish those calls. Pass the `pauseIds` an input-required result named, exactly. Nothing is sent until the person submits; the result lists each call with its outcome (and new pause ids when the system asks again).'

const decodeParams = decodeToolArguments(InputReviewParams)

const decodeResponse = Schema.decodeUnknownEffect(InputReviewResponse, {
  onExcessProperty: 'error'
})

const invalid = (message: string) => new InteractionValidationError({ message })

const distinctIds = (params: InputReviewParams) =>
  new Set(params.pauseIds).size === params.pauseIds.length
    ? Effect.succeed(params)
    : Effect.fail(invalid('The review lists a pause twice.'))

/** The answers, one per listed pause, in the listed order. */
const answersFor = (params: InputReviewParams, response: InputReviewResponse) => {
  const extra = Object.keys(response.answers).filter(id => !params.pauseIds.includes(id))

  if (extra.length > 0)
    return Effect.fail(
      invalid(`Answers name pauses that are not under review: ${extra.join(', ')}`)
    )

  const missing = params.pauseIds.filter(id => !Object.hasOwn(response.answers, id))

  if (missing.length > 0)
    return Effect.fail(invalid(`Every pause needs an answer; missing: ${missing.join(', ')}`))

  return Effect.succeed(
    Object.fromEntries(
      Object.entries(response.answers).filter(([id]) => params.pauseIds.includes(id))
    )
  )
}

const resolutionOutcome = (
  entry: InputPauseEntry,
  reviewToolName: string
): InputReviewPauseOutcome => {
  const base = { pauseId: entry.pause.id, label: entry.pause.label }
  const resolution = entry.resolution

  if (resolution === undefined)
    return {
      ...base,
      status: 'unknown',
      error: 'no outcome was recorded; the answer may or may not have been sent'
    }

  return InputPauseResolution.$match(resolution, {
    Completed: ({ result }): InputReviewPauseOutcome =>
      result.isError === true
        ? { ...base, status: 'completed', isError: true }
        : { ...base, status: 'completed' },
    InputRequired: ({ pauseIds }): InputReviewPauseOutcome => ({
      ...base,
      status: 'input_required',
      inputRequired: { reviewToolName, pauseIds }
    }),
    NotSent: ({ message }): InputReviewPauseOutcome => ({
      ...base,
      status: 'not_sent',
      error: message
    }),
    Unknown: ({ message }): InputReviewPauseOutcome => ({
      ...base,
      status: 'unknown',
      error: message
    })
  })
}

const statusText: Record<InputReviewPauseStatus, string> = {
  completed: 'completed',
  input_required: 'asks for more input',
  not_sent: 'not sent',
  unknown: 'outcome unknown (it may or may not have run; do not retry it automatically)'
}

const contentParts = (content: Content): ReadonlyArray<ContentPart> =>
  Predicate.isString(content) ? [TextPart.make({ text: content })] : content

/** Interaction outcome of a review: `unknown` when any pause is, `failed` when nothing was sent. */
const businessOutcome = (
  outcomes: ReadonlyArray<InputReviewPauseOutcome>
): InteractionBusinessOutcome => {
  if (outcomes.some(outcome => outcome.status === 'unknown')) return 'unknown'

  return outcomes.every(outcome => outcome.status === 'not_sent') ? 'failed' : 'completed'
}

/**
 * The review result: a line per pause with its outcome, each completed call's own result content
 * (text and files as the call returned them), then the review call for any new pauses.
 */
export const inputReviewResult = (input: {
  readonly entries: ReadonlyArray<InputPauseEntry>
  readonly reviewToolName: string
  readonly interrupted: boolean
}): InteractionActionResult & { readonly structuredContent: InputReviewOutcome } => {
  const outcomes = input.entries.map(entry => resolutionOutcome(entry, input.reviewToolName))
  const count = outcomes.length
  const plural = count === 1 ? '' : 's'

  const parts: Array<ContentPart> = [
    TextPart.make({
      text: input.interrupted
        ? `The input review stopped before recording its outcome; nothing was sent again. Outcomes as recorded (${count} paused call${plural}):`
        : `Finished the review of ${count} paused call${plural}:`
    })
  ]

  input.entries.forEach((entry, index) => {
    const outcome = outcomes[index]

    if (outcome === undefined) return

    const error = outcome.error === undefined ? '' : `: ${outcome.error}`
    const reported = outcome.isError === true ? ' (the call reported an error)' : ''

    parts.push(
      TextPart.make({
        text: `\n\n${index + 1}. ${outcome.label} (pause ${outcome.pauseId}): ${statusText[outcome.status]}${error}${reported}`
      })
    )

    const resolution = entry.resolution

    if (resolution !== undefined && Predicate.isTagged(resolution, 'Completed'))
      parts.push(TextPart.make({ text: '\nResult:\n' }), ...contentParts(resolution.result.content))
  })

  const refs = outcomes.flatMap(outcome =>
    outcome.inputRequired === undefined ? [] : [outcome.inputRequired]
  )

  if (refs.length > 0) parts.push(TextPart.make({ text: `\n\n${inputRequiredNotice(refs)}` }))

  const structuredContent: InputReviewOutcome = input.interrupted
    ? { type: 'input_review_outcome', pauses: outcomes, interrupted: true }
    : { type: 'input_review_outcome', pauses: outcomes }

  return { outcome: businessOutcome(outcomes), content: parts, structuredContent }
}

/**
 * The input review tool (ADR 0014): an action-backed interaction (default name `review_input`,
 * params `{ pauseIds }`, response `{ answers }`) through which a person answers the forms of
 * paused calls; its one action resumes each paused call once with its answer.
 *
 * - Call validation loads the pauses through the host (present, in scope, still waiting), so the
 *   model can never open a review of a pause it made up, and the host renders forms only from
 *   stored pauses.
 * - Admission (`validateAction`) requires exactly one answer per listed pause and checks each
 *   against its form (`validateAnswer`), so an invalid answer is never accepted.
 * - The action resumes the pauses in order through `resume`, which claims each pause before
 *   sending. The result lists every pause: `completed` (with the call's result), `input_required`
 *   (asked again: review the new pauses), `not_sent`, or `unknown` (never retried).
 * - A review that started without a recorded outcome lists what the host recorded (`recorded`),
 *   never sending again. Cancelling the interaction sends nothing; the pauses stay reviewable.
 */
export const makeInputReviewTool = <Context, Pause extends InputPause>(
  options: MakeInputReviewToolOptions<Pause>
): ToolRegistration<Context> => {
  const name = options.name ?? inputReviewToolName
  const label = options.actionLabel ?? 'Send answers'
  const host = options.host

  type DescriptorFields = {
    kind: string
    title?: string
    description?: string
    schema: ReturnType<typeof toolJsonSchemaFromSchema>
    actions: readonly [InteractionActionDescriptor]
  }

  const descriptor: DescriptorFields = {
    kind: options.renderer ?? inputReviewRenderer,
    schema: responseJsonSchemaFromSchema(InputReviewResponse),
    actions: [InteractionActionDescriptor.make({ id: inputReviewActionId, label })]
  }

  if (options.title !== undefined) descriptor.title = options.title

  if (options.interactionDescription !== undefined)
    descriptor.description = options.interactionDescription

  const def = ToolDef.make({
    name,
    description: options.description ?? defaultDescription,
    parameters: toolJsonSchemaFromSchema(InputReviewParams),
    interaction: InteractionDescriptor.make(descriptor)
  })

  const params = (raw: unknown) => decodeParams(raw).pipe(Effect.flatMap(distinctIds))

  const loaded = (input: InputReviewParams) =>
    host
      .load(input.pauseIds)
      .pipe(
        Effect.flatMap(pauses =>
          pauses.length === input.pauseIds.length &&
          pauses.every((pause, index) => pause.id === input.pauseIds[index])
            ? Effect.succeed(pauses)
            : Effect.fail(invalid('The listed pauses could not all be loaded for review.'))
        )
      )

  /** Each listed pause with its answer, after every check admission runs. */
  const answered = (call: ToolCall, data: unknown) =>
    Effect.gen(function* () {
      const input = yield* params(call.params)
      const response = yield* decodeResponse(data)
      const answers = yield* answersFor(input, response)
      const pauses = yield* loaded(input)

      return yield* Effect.forEach(pauses, pause =>
        Object.hasOwn(answers, pause.id)
          ? Effect.succeed(answers[pause.id]).pipe(
              Effect.filterOrFail(
                (answer): answer is Schema.Json => answer !== undefined,
                () => invalid(`No answer for ${pause.id}.`)
              ),
              Effect.flatMap(answer =>
                host.validateAnswer({ pause, answer }).pipe(Effect.as({ pause, answer }))
              )
            )
          : Effect.fail(invalid(`No answer for ${pause.id}.`))
      )
    })

  return {
    def,
    access: options.access ?? 'write',
    validate: call =>
      params(call.params).pipe(
        Effect.asVoid,
        Effect.mapError(
          error =>
            new ToolError({
              tool: name,
              cause: 'validation',
              message: `Invalid ${name} arguments: ${error.message}`
            })
        )
      ),
    execute: ({ call }) =>
      Effect.fail(
        new ToolError({
          tool: name,
          cause: 'unavailable',
          message: `Input review "${name}" for call ${call.id} requires an accepted interaction and cannot execute directly.`
        })
      ),
    interaction: {
      validateCall: raw => params(raw).pipe(Effect.flatMap(loaded), Effect.asVoid),
      validateResponse: data => decodeResponse(data).pipe(Effect.asVoid),
      actions: {
        [inputReviewActionId]: {
          label,
          validate: ({ data, call }) => answered(call, data).pipe(Effect.asVoid),
          execute: ({ data, submissionId, call }) =>
            answered(call, data).pipe(
              Effect.result,
              Effect.flatMap(checked =>
                Result.isFailure(checked)
                  ? // Checks fail before anything is sent: a known no-effect outcome.
                    Effect.succeed<InteractionActionResult>({
                      outcome: 'failed',
                      content: `The input review could not be submitted: ${checked.failure.message} Nothing was sent.`
                    })
                  : Effect.forEach(checked.success, ({ pause, answer }) =>
                      host
                        .resume({ pause, answer, submissionId, reviewCall: call })
                        .pipe(Effect.map((resolution): InputPauseEntry => ({ pause, resolution })))
                    ).pipe(
                      Effect.map(entries =>
                        inputReviewResult({ entries, reviewToolName: name, interrupted: false })
                      )
                    )
              )
            )
        }
      },
      unknownOutcome: ({ call, submissionId, phase }) =>
        Effect.gen(function* () {
          const recorded = host.recorded
          const input = yield* params(call.params).pipe(Effect.option)

          if (recorded === undefined || Option.isNone(input))
            return {
              content:
                'The input review stopped before recording its outcome. Its answers may or may not have been sent; nothing was sent again.'
            }

          const entries = yield* recorded({ pauseIds: input.value.pauseIds, submissionId })
          const result = inputReviewResult({ entries, reviewToolName: name, interrupted: true })

          // Only a replay may report a proven outcome: every pause has a recorded resolution.
          return phase === 'replay' && result.outcome !== 'unknown'
            ? result
            : { content: result.content, structuredContent: result.structuredContent }
        })
    }
  }
}
