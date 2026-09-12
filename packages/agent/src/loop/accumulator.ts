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

export const collectText = (events: ReadonlyArray<LLMEvent>) =>
  events.reduce((text, event) => (event._tag === 'TextDelta' ? `${text}${event.text}` : text), '')

export const collectReasoning = (events: ReadonlyArray<LLMEvent>) =>
  events.reduce(
    (text, event) => (event._tag === 'ReasoningDelta' ? `${text}${event.text}` : text),
    ''
  )

export const collectToolCalls = (events: ReadonlyArray<LLMEvent>) =>
  events.flatMap(event => (event._tag === 'ToolCall' ? [event.call] : []))

/** Incremental assistant-part reducer. Shared with collect; not a public loop export. */
export const applyAssistantLlmEvent = (
  parts: ReadonlyArray<AssistantPart>,
  event: LLMEvent
): ReadonlyArray<AssistantPart> => {
  switch (event._tag) {
    case 'TextDelta':
      return appendTextPart(parts, event.text)
    case 'ReasoningDelta':
      return appendReasoningPart(parts, event.text)
    case 'ToolCall':
      return [...parts, HostToolCallPart.make({ call: event.call })]
    case 'ProviderToolResult':
      return [
        ...parts,
        ProviderToolCallPart.make({ call: event.call }),
        ProviderToolResultPart.make({ toolCallId: event.call.id, result: event.result })
      ]
    case 'Done':
    case 'ToolInputDelta':
    case 'ToolInputStart':
    case 'Usage':
      return parts
  }
}

const appendTextPart = (parts: ReadonlyArray<AssistantPart>, text: string) => {
  const last = parts.at(-1)

  return last?._tag === 'Text'
    ? [
        ...parts.slice(0, -1),
        AssistantTextPart.make({ content: appendTextToContent(last.content, text) })
      ]
    : [...parts, AssistantTextPart.make({ content: text })]
}

const appendReasoningPart = (parts: ReadonlyArray<AssistantPart>, text: string) => {
  const last = parts.at(-1)

  return last?._tag === 'Reasoning'
    ? [...parts.slice(0, -1), AssistantReasoningPart.make({ text: `${last.text}${text}` })]
    : [...parts, AssistantReasoningPart.make({ text })]
}

const accumulateAssistantParts = (events: ReadonlyArray<LLMEvent>) =>
  events.reduce<ReadonlyArray<AssistantPart>>(applyAssistantLlmEvent, [])

export const accumulateAssistantMessage = (events: ReadonlyArray<LLMEvent>) => {
  const parts = accumulateAssistantParts(events)

  return AssistantAgentMessage.make({ parts })
}
