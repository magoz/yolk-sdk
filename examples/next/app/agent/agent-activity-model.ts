import type { AgentError, AgentEvent, AgentRetry, ProviderErrorInfo } from '@yolk-sdk/agent/protocol'
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

const formatRetryDelay = (delayMs: number) =>
  delayMs >= 1000 ? `${(delayMs / 1000).toFixed(1)}s` : `${delayMs}ms`

export const providerFailureLabel = (code: AgentError['code'] | AgentRetry['reason']) => {
  switch (code) {
    case 'rate_limit':
      return 'Rate limited'
    case 'overloaded':
      return 'Provider overloaded'
    case 'provider_error':
      return 'Provider failure'
    case 'context_overflow':
      return 'Context too large'
    case 'invalid_response':
      return 'Invalid provider response'
    case 'validation_error':
    case 'tool_error':
    case 'tool_denied':
    case 'tool_timeout':
    case 'store_error':
    case 'aborted':
    case 'session_not_found':
    case 'conflict':
    case 'unknown':
      return code
  }
}

export const providerInfoDetail = (provider: ProviderErrorInfo | undefined) => {
  if (provider === undefined) {
    return ''
  }

  return [
    provider.provider,
    provider.kind,
    provider.status === undefined ? undefined : `status ${provider.status}`,
    provider.providerCode,
    provider.retryAfterMs === undefined
      ? undefined
      : `retry-after ${formatRetryDelay(provider.retryAfterMs)}`
  ]
    .filter(value => value !== undefined && value.length > 0)
    .join(' · ')
}

export const agentRetryTitle = (event: AgentRetry) =>
  `${providerFailureLabel(event.reason)}, retrying attempt ${event.attempt}`

export const agentRetryDetail = (event: AgentRetry) => {
  const provider = providerInfoDetail(event.provider)
  const detail = `next attempt in ${formatRetryDelay(event.delayMs)}`

  return provider.length === 0 ? detail : `${detail} · ${provider}`
}

export const agentErrorTitle = (event: AgentError) => providerFailureLabel(event.code)

export const agentErrorDetail = (event: AgentError) => {
  const provider = providerInfoDetail(event.provider)
  const retryable = event.retryable ? 'retryable' : 'terminal'

  return provider.length === 0
    ? `${event.message} · ${retryable}`
    : `${event.message} · ${retryable} · ${provider}`
}

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
    case 'SubagentStarted':
      return {
        title: `Subagent started: ${event.description}`,
        detail: `${event.subagentType} · ${event.subagentRunId} · ${event.createdAtMs ?? 'no timestamp'}`,
        tone: 'tool'
      }
    case 'SubagentCompleted':
      return {
        title: `Subagent ${event.status}: ${event.description}`,
        detail: `${event.subagentType} · ${event.durationMs}ms · ${event.subagentRunId}`,
        tone: event.status === 'error' ? 'error' : 'success'
      }
    case 'TurnEnd':
      return { title: 'Turn ended', detail: event.reason, tone: 'neutral' }
    case 'AgentEnd':
      return {
        title: 'Run finished',
        detail: `${countLabel(event.turns, 'turn')} · ${countLabel(event.messages.length, 'message')}`,
        tone: 'success'
      }
    case 'AgentAwaitingInput':
      return {
        title: 'Waiting for input',
        detail: countLabel(event.requests.length, 'request'),
        tone: 'active'
      }
    case 'AgentError':
      return { title: agentErrorTitle(event), detail: agentErrorDetail(event), tone: 'error' }
    case 'AgentRetry':
      return {
        title: agentRetryTitle(event),
        detail: agentRetryDetail(event),
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
    case 'QuestionAnswered':
    case 'QuestionCancelled':
    case 'QuestionRequested':
    case 'ToolApprovalDenied':
    case 'ToolApprovalGranted':
    case 'ToolApprovalRequested':
    case 'ToolInputDelta':
    case 'ToolInputStart':
    case 'UsageUpdate':
      return null
  }
}
