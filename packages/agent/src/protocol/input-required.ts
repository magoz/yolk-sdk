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

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

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
 * An error result saying the call needs a person's input and has not completed. `content` says
 * what paused it; the result appends how to continue (the review call, and never calling the tool
 * again for the same work).
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
    content: `${input.content}\nIt has not completed. To continue, call ${inputReviewCallText(ref)}: a person answers, then the call finishes. Do not call the tool again for the same work.`,
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
 * Merges refs per review tool, keeping first-seen order and dropping repeated pause ids, so one
 * review call per tool finishes every listed pause.
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

  return Array.from(byTool.entries()).flatMap(([reviewToolName, ids]) => {
    const [first, ...rest] = ids

    return first === undefined ? [] : [{ reviewToolName, pauseIds: [first, ...rest] }]
  })
}

/** Model-visible lines naming the review calls that finish the given pauses. */
export const inputRequiredNotice = (refs: ReadonlyArray<ToolInputRequiredRef>): string => {
  const merged = mergeInputRequiredRefs(refs)
  const count = merged.reduce((total, ref) => total + ref.pauseIds.length, 0)

  return [
    `${count} call${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} a person's input and ${count === 1 ? 'has' : 'have'} not completed. To continue, call:`,
    ...merged.map(ref => `- ${inputReviewCallText(ref)}`)
  ].join('\n')
}
