import { AssistantAgentMessage, AssistantReasoningPart, AssistantTextPart, HostToolCallPart } from '@yolk/protocol'
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

export const accumulateAssistantMessage = (events: ReadonlyArray<LLMEvent>) => {
  const reasoning = collectReasoning(events)
  const content = collectText(events)
  const parts = [
    ...(reasoning.length === 0 ? [] : [AssistantReasoningPart.make({ text: reasoning })]),
    AssistantTextPart.make({ content }),
    ...collectToolCalls(events).map(call => HostToolCallPart.make({ call }))
  ]

  return AssistantAgentMessage.make({ parts })
}
