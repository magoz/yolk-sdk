import { AssistantAgentMessage } from '@yolk/protocol'
import type { LLMEvent } from './llm-event'

export const collectText = (events: ReadonlyArray<LLMEvent>) =>
  events.reduce((text, event) => (event._tag === 'TextDelta' ? `${text}${event.text}` : text), '')

export const collectToolCalls = (events: ReadonlyArray<LLMEvent>) =>
  events.flatMap(event => (event._tag === 'ToolCall' ? [event.call] : []))

export const accumulateAssistantMessage = (events: ReadonlyArray<LLMEvent>) =>
  AssistantAgentMessage.make({
    content: collectText(events),
    toolCalls: collectToolCalls(events)
  })
