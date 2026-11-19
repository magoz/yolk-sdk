import { Option, Schema } from 'effect'
import { ToolResult } from './tool.ts'

/**
 * Tool calls that need a person's input before they complete (ADR 0014). A tool's `execute` never
 * pauses: a call that a remote system paused for input (for example an MCP server asking a form)
 * stores the pause host-side and returns an error result carrying this marker. The call is over
 * (the tool ledger records it, so it never runs again); a separate input review tool
 * (`makeInputReviewTool`) shows the stored forms to a person and finishes the paused calls.
 *
 * The marker rides on `structuredContent` (`{ code: 'input_required', inputRequired }`), so every
 * consumer of error results already treats it as "did not complete": output checks skip it, code
 * mode rejects the nested call with `error.code === 'input_required'`, and plan apply reports the
 * call `input_required` instead of `failed`.
 */
export const toolInputRequiredCode = 'input_required'

/** @internal */
export const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

/** Most pauses one input review answers; refs naming more are split into several reviews. */
export const maxInputReviewPauses = 50

/** Where a paused call is finished: the input review tool to call and the stored pauses' ids. */
export const ToolInputRequiredRef = Schema.Struct({
  reviewToolName: NonEmptyTrimmedString,
  pauseIds: Schema.NonEmptyArray(NonEmptyTrimmedString)
})

export type ToolInputRequiredRef = typeof ToolInputRequiredRef.Type

/** The `structuredContent` of an input-required result. */
export const ToolInputRequired = Schema.Struct({
  code: Schema.Literal(toolInputRequiredCode),
  inputRequired: ToolInputRequiredRef
})

export type ToolInputRequired = typeof ToolInputRequired.Type

const decodeInputRequired = Schema.decodeUnknownOption(ToolInputRequired)

/** The call to make to finish paused calls, as model-visible text. */
export const inputReviewCallText = (ref: ToolInputRequiredRef) =>
  `${ref.reviewToolName}(${JSON.stringify({ pauseIds: ref.pauseIds })})`

/**
 * The model-visible sentence `makeInputRequiredToolResult` appends: how to continue (the review
 * call, and never calling the tool again for the same work). The tool ledger keeps it when it cuts
 * a stored copy.
 * @internal
 */
export const inputRequiredInstruction = (ref: ToolInputRequiredRef) =>
  `It has not completed. To continue, call ${inputReviewCallText(ref)}: a person answers, then the call finishes. Do not call the tool again for the same work.`

/**
 * An error result saying the call needs a person's input and has not completed. `content` says
 * what paused it; the result appends how to continue (`inputRequiredInstruction`).
 */
export const makeInputRequiredToolResult = (input: {
  readonly toolCallId: string
  readonly content: string
  readonly reviewToolName: string
  readonly pauseIds: readonly [string, ...Array<string>]
}): ToolResult => {
  const ref: ToolInputRequiredRef = {
    reviewToolName: input.reviewToolName,
    pauseIds: input.pauseIds
  }

  const structuredContent: ToolInputRequired = { code: toolInputRequiredCode, inputRequired: ref }

  return ToolResult.make({
    toolCallId: input.toolCallId,
    content: `${input.content}\n${inputRequiredInstruction(ref)}`,
    isError: true,
    structuredContent
  })
}

/** The input-required marker of a result, when it is an error result carrying one. */
export const toolInputRequired = (result: {
  readonly isError?: boolean | undefined
  readonly structuredContent?: unknown
}): Option.Option<ToolInputRequiredRef> =>
  result.isError === true
    ? Option.map(decodeInputRequired(result.structuredContent), marker => marker.inputRequired)
    : Option.none()

/**
 * Merges refs per review tool, keeping first-seen order and dropping repeated pause ids, then
 * splits each tool's pauses into reviews of at most `maxInputReviewPauses`, so every listed review
 * call is one the review tool accepts.
 */
export const mergeInputRequiredRefs = (
  refs: ReadonlyArray<ToolInputRequiredRef>
): ReadonlyArray<ToolInputRequiredRef> => {
  const byTool = new Map<string, Array<string>>()

  for (const ref of refs) {
    const ids = byTool.get(ref.reviewToolName) ?? []

    for (const id of ref.pauseIds) if (!ids.includes(id)) ids.push(id)

    byTool.set(ref.reviewToolName, ids)
  }

  return Array.from(byTool.entries()).flatMap(([reviewToolName, ids]) =>
    Array.from({ length: Math.ceil(ids.length / maxInputReviewPauses) }, (_, chunk) =>
      ids.slice(chunk * maxInputReviewPauses, (chunk + 1) * maxInputReviewPauses)
    ).flatMap(chunk => {
      const [first, ...rest] = chunk

      return first === undefined ? [] : [{ reviewToolName, pauseIds: [first, ...rest] }]
    })
  )
}

/**
 * Model-visible lines naming every review call that finishes the given pauses. Not capped: the
 * model reads only content, and the list is already bounded by the calls that paused (one review
 * per `maxInputReviewPauses`).
 */
export const inputRequiredNotice = (refs: ReadonlyArray<ToolInputRequiredRef>): string => {
  const merged = mergeInputRequiredRefs(refs)
  const count = merged.reduce((total, ref) => total + ref.pauseIds.length, 0)

  return [
    `${count} call${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} a person's input and ${count === 1 ? 'has' : 'have'} not completed. To continue, call${merged.length > 1 ? ' each in turn' : ''}:`,
    ...merged.map(ref => `- ${inputReviewCallText(ref)}`)
  ].join('\n')
}
