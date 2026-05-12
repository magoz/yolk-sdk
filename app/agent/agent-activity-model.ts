import type { AgentEvent } from '@yolk/protocol'
import { contentPreview, countLabel, truncate, unknownPreview } from './agent-format'

export type ActivityTone = 'neutral' | 'active' | 'success' | 'error' | 'tool'

export type AgentActivityItem = {
  readonly id: number
  readonly title: string
  readonly detail: string
  readonly tone: ActivityTone
}

export const maxActivityItems = 80
export const activityPanelId = 'agent-activity-panel'

export const activityItemFromAgentEvent = (
  event: AgentEvent
): Omit<AgentActivityItem, 'id'> | null => {
  switch (event._tag) {
    case 'AgentStart':
      return { title: 'Run started', detail: 'Server accepted the transcript.', tone: 'active' }
    case 'TurnStart':
      return { title: 'Thinking', detail: `Turn ${event.turn}`, tone: 'active' }
    case 'LLMStreamStart':
      return { title: 'Model stream started', detail: `Turn ${event.turn}`, tone: 'active' }
    case 'ToolInputEnd':
      return {
        title: `Tool requested: ${event.call.name}`,
        detail: unknownPreview(event.call.params),
        tone: 'tool'
      }
    case 'ToolExecutionStarted':
      return { title: `Running tool: ${event.call.name}`, detail: event.call.id, tone: 'tool' }
    case 'ToolExecutionCompleted':
      return {
        title: `Tool result: ${event.call.name}`,
        detail: truncate(contentPreview(event.result.content)),
        tone: 'success'
      }
    case 'ToolExecutionError':
      return { title: `Tool error: ${event.call.name}`, detail: event.message, tone: 'error' }
    case 'TurnEnd':
      return { title: 'Turn ended', detail: event.reason, tone: 'neutral' }
    case 'AgentEnd':
      return {
        title: 'Run finished',
        detail: `${countLabel(event.turns, 'turn')} · ${countLabel(event.messages.length, 'message')}`,
        tone: 'success'
      }
    case 'AgentError':
      return { title: 'Agent error', detail: event.message, tone: 'error' }
    case 'AgentRetry':
      return {
        title: `Retrying model call (${event.attempt})`,
        detail: `${event.reason} · ${event.delayMs}ms`,
        tone: 'active'
      }
    case 'CompactionStart':
      return { title: 'Compacting context', detail: event.strategy, tone: 'active' }
    case 'CompactionEnd':
      return {
        title: 'Context compacted',
        detail: event.strategy,
        tone: 'success'
      }
    case 'AssistantMessage':
    case 'LLMReasoningDelta':
    case 'LLMStreamEnd':
    case 'LLMTextDelta':
    case 'ProviderToolResult':
    case 'ToolApprovalDenied':
    case 'ToolApprovalGranted':
    case 'ToolApprovalRequested':
    case 'ToolInputDelta':
    case 'ToolInputStart':
    case 'UsageUpdate':
      return null
  }
}
