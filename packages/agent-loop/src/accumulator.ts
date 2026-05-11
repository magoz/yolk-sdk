import { AssistantAgentMessage } from '@yolk/protocol'
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
  const message = {
    content: collectText(events),
    toolCalls: collectToolCalls(events)
  }

  if (reasoning.length === 0) {
    return AssistantAgentMessage.make(message)
  }

  return AssistantAgentMessage.make({ ...message, reasoning })
}
