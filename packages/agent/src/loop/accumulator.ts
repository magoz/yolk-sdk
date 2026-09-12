import {
  AssistantAgentMessage,
  AssistantReasoningPart,
  AssistantTextPart,
  appendTextToContent,
  HostToolCallPart,
  ProviderToolCallPart,
  ProviderToolResultPart,
  type AssistantPart
} from '@yolk-sdk/agent/protocol'
import type { LLMEvent } from './llm-event.ts'
import { Predicate } from 'effect'

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

const appendTextPart = (parts: Array<AssistantPart>, text: string) => {
  const last = parts.at(-1)

  if (last?._tag === 'Text') {
    parts[parts.length - 1] = AssistantTextPart.make({
      content: appendTextToContent(last.content, text)
    })
  } else {
    parts.push(AssistantTextPart.make({ content: text }))
  }

  return parts
}

const appendReasoningPart = (parts: Array<AssistantPart>, text: string) => {
  const last = parts.at(-1)

  if (last?._tag === 'Reasoning') {
    parts[parts.length - 1] = AssistantReasoningPart.make({ text: `${last.text}${text}` })
  } else {
    parts.push(AssistantReasoningPart.make({ text }))
  }

  return parts
}

const applyAssistantLlmEventMutable = (parts: Array<AssistantPart>, event: LLMEvent) => {
  switch (event._tag) {
    case 'TextDelta':
      return appendTextPart(parts, event.text)
    case 'ReasoningDelta':
      return appendReasoningPart(parts, event.text)
    case 'ToolCall':
      parts.push(HostToolCallPart.make({ call: event.call }))

      return parts
    case 'ProviderToolResult':
      parts.push(
        ProviderToolCallPart.make({ call: event.call }),
        ProviderToolResultPart.make({ toolCallId: event.call.id, result: event.result })
      )

      return parts
    case 'Done':
    case 'ToolInputDelta':
    case 'ToolInputStart':
    case 'Usage':
      return parts
  }
}

/** Incremental assistant-part reducer. Shared with collect; not a public loop export. */
export const applyAssistantLlmEvent = (
  parts: ReadonlyArray<AssistantPart>,
  event: LLMEvent
): ReadonlyArray<AssistantPart> => {
  switch (event._tag) {
    case 'Done':
    case 'ToolInputDelta':
    case 'ToolInputStart':
    case 'Usage':
      return parts
    case 'TextDelta':
    case 'ReasoningDelta':
    case 'ToolCall':
    case 'ProviderToolResult':
      return applyAssistantLlmEventMutable(parts.slice(), event)
  }
}

const accumulateAssistantParts = (events: ReadonlyArray<LLMEvent>) =>
  events.reduce<Array<AssistantPart>>(applyAssistantLlmEventMutable, [])

export const accumulateAssistantMessage = (events: ReadonlyArray<LLMEvent>) => {
  const parts = accumulateAssistantParts(events)

  return AssistantAgentMessage.make({ parts })
}
