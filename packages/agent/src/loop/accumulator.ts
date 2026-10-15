import {
  AssistantAgentMessage,
  AssistantReasoningPart,
  AssistantTextPart,
  appendTextToContent,
  HostToolCallPart,
  ProviderToolCallPart,
  ProviderToolResultPart,
  type AssistantPart,
  type AssistantReasoningReplay
} from '@yolk-sdk/agent/protocol'
import type { LLMEvent } from './llm-event.ts'
import { Match, Predicate } from 'effect'

export const collectText = (events: ReadonlyArray<LLMEvent>) =>
  events.reduce(
    (text, event) => (Predicate.isTagged(event, 'TextDelta') ? `${text}${event.text}` : text),
    ''
  )

export const collectReasoning = (events: ReadonlyArray<LLMEvent>) =>
  events.reduce(
    (text, event) => (Predicate.isTagged(event, 'ReasoningDelta') ? `${text}${event.text}` : text),
    ''
  )

export const collectToolCalls = (events: ReadonlyArray<LLMEvent>) =>
  events.flatMap(event => (Predicate.isTagged(event, 'ToolCall') ? [event.call] : []))

const appendTextPartMutable = (parts: Array<AssistantPart>, text: string) => {
  const last = parts.at(-1)

  if (Predicate.isTagged(last, 'Text')) {
    parts[parts.length - 1] = AssistantTextPart.make({
      content: appendTextToContent(last.content, text)
    })
  } else {
    parts.push(AssistantTextPart.make({ content: text }))
  }

  return parts
}

/** A reasoning part the provider has not closed with replay state yet. */
const isOpenReasoningPart = (part: AssistantPart | undefined): part is AssistantReasoningPart =>
  Predicate.isTagged(part, 'Reasoning') && part.replay === undefined

/** A `Signed` replay closes the open reasoning block it signs; anything else is its own block. */
const closesLastReasoningPart = (
  last: AssistantPart | undefined,
  replay: AssistantReasoningReplay
): last is AssistantReasoningPart =>
  Predicate.isTagged(replay, 'Signed') && isOpenReasoningPart(last)

const appendReasoningPartMutable = (parts: Array<AssistantPart>, text: string) => {
  const last = parts.at(-1)

  if (isOpenReasoningPart(last)) {
    parts[parts.length - 1] = AssistantReasoningPart.make({ text: `${last.text}${text}` })
  } else {
    parts.push(AssistantReasoningPart.make({ text }))
  }

  return parts
}

const closeReasoningPartMutable = (
  parts: Array<AssistantPart>,
  replay: AssistantReasoningReplay
) => {
  const last = parts.at(-1)

  if (closesLastReasoningPart(last, replay)) {
    parts[parts.length - 1] = AssistantReasoningPart.make({ text: last.text, replay })
  } else {
    parts.push(AssistantReasoningPart.make({ text: '', replay }))
  }

  return parts
}

const applyAssistantLlmEventMutable = (parts: Array<AssistantPart>, event: LLMEvent) =>
  Match.value(event).pipe(
    Match.tag('TextDelta', current => appendTextPartMutable(parts, current.text)),
    Match.tag('ReasoningDelta', current => appendReasoningPartMutable(parts, current.text)),
    Match.tag('ReasoningReplay', current => closeReasoningPartMutable(parts, current.replay)),
    Match.tag('ToolCall', current => {
      parts.push(HostToolCallPart.make({ call: current.call }))

      return parts
    }),
    Match.tag('ProviderToolResult', current => {
      parts.push(
        ProviderToolCallPart.make({ call: current.call }),
        ProviderToolResultPart.make({ toolCallId: current.call.id, result: current.result })
      )

      return parts
    }),
    Match.tag('Done', 'ToolInputDelta', 'ToolInputStart', 'Usage', () => parts),
    Match.exhaustive
  )

/** Incremental assistant-part reducer. Shared with collect; not a public loop export. */
export const applyAssistantLlmEvent = (
  parts: ReadonlyArray<AssistantPart>,
  event: LLMEvent
): ReadonlyArray<AssistantPart> =>
  Match.value(event).pipe(
    Match.tag('TextDelta', current => appendTextPart(parts, current.text)),
    Match.tag('ReasoningDelta', current => appendReasoningPart(parts, current.text)),
    Match.tag('ReasoningReplay', current => closeReasoningPart(parts, current.replay)),
    Match.tag('ToolCall', current => [...parts, HostToolCallPart.make({ call: current.call })]),
    Match.tag('ProviderToolResult', current => [
      ...parts,
      ProviderToolCallPart.make({ call: current.call }),
      ProviderToolResultPart.make({ toolCallId: current.call.id, result: current.result })
    ]),
    Match.tag('Done', 'ToolInputDelta', 'ToolInputStart', 'Usage', () => parts),
    Match.exhaustive
  )

const appendTextPart = (parts: ReadonlyArray<AssistantPart>, text: string) => {
  const last = parts.at(-1)

  return Predicate.isTagged(last, 'Text')
    ? [
        ...parts.slice(0, -1),
        AssistantTextPart.make({ content: appendTextToContent(last.content, text) })
      ]
    : [...parts, AssistantTextPart.make({ content: text })]
}

const appendReasoningPart = (parts: ReadonlyArray<AssistantPart>, text: string) => {
  const last = parts.at(-1)

  return isOpenReasoningPart(last)
    ? [...parts.slice(0, -1), AssistantReasoningPart.make({ text: `${last.text}${text}` })]
    : [...parts, AssistantReasoningPart.make({ text })]
}

const closeReasoningPart = (
  parts: ReadonlyArray<AssistantPart>,
  replay: AssistantReasoningReplay
) => {
  const last = parts.at(-1)

  return closesLastReasoningPart(last, replay)
    ? [...parts.slice(0, -1), AssistantReasoningPart.make({ text: last.text, replay })]
    : [...parts, AssistantReasoningPart.make({ text: '', replay })]
}

const accumulateAssistantParts = (events: ReadonlyArray<LLMEvent>) =>
  events.reduce<Array<AssistantPart>>(applyAssistantLlmEventMutable, [])

export const accumulateAssistantMessage = (events: ReadonlyArray<LLMEvent>) => {
  const parts = accumulateAssistantParts(events)

  return AssistantAgentMessage.make({ parts })
}
