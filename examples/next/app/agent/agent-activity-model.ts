import { Match } from 'effect'
import type {
  AgentError,
  AgentEvent,
  AgentRetry,
  ProviderErrorInfo
} from '@yolk-sdk/agent/protocol'
import {
  contentPreview,
  countLabel,
  isJsonPreviewValue,
  jsonPreview,
  truncate
} from './agent-format'

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

type ActivityItemDraft = Omit<AgentActivityItem, 'id'>

export const activityItemFromAgentEvent = (event: AgentEvent): ActivityItemDraft | null =>
  Match.value(event).pipe(
    Match.withReturnType<ActivityItemDraft | null>(),
    Match.tag('AgentStart', () => ({
      title: 'Run started',
      detail: 'Server accepted the transcript.',
      tone: 'active'
    })),
    Match.tag('TurnStart', current => ({
      title: 'Thinking',
      detail: `Turn ${current.turn}`,
      tone: 'active'
    })),
    Match.tag('LLMStreamStart', current => ({
      title: 'Model stream started',
      detail: `Turn ${current.turn}`,
      tone: 'active'
    })),
    Match.tag('ToolInputEnd', current => ({
      title: `Tool requested: ${current.call.name}`,
      detail: isJsonPreviewValue(current.call.params)
        ? jsonPreview(current.call.params)
        : 'unparsed',
      tone: 'tool'
    })),
    Match.tag('ToolExecutionStarted', current => ({
      title: `Running tool: ${current.call.name}`,
      detail: current.call.id,
      tone: 'tool'
    })),
    Match.tag('ToolExecutionAccepted', current => ({
      title: `Background tool accepted: ${current.call.name}`,
      detail: truncate(contentPreview(current.result.content)),
      tone: 'tool'
    })),
    Match.tag('ToolExecutionCompleted', current => ({
      title: `Tool result: ${current.call.name}`,
      detail: truncate(contentPreview(current.result.content)),
      tone: 'success'
    })),
    Match.tag('ToolExecutionError', current => ({
      title: `Tool error: ${current.call.name}`,
      detail: current.message,
      tone: 'error'
    })),
    Match.tag('SubagentStarted', current => ({
      title: `Subagent started: ${current.description}`,
      detail: `${current.subagentType} · ${current.subagentRunId} · ${current.createdAtMs ?? 'no timestamp'}`,
      tone: 'tool'
    })),
    Match.tag('SubagentCompleted', current => ({
      title: `Subagent ${current.status}: ${current.description}`,
      detail: `${current.subagentType} · ${current.durationMs}ms · ${current.subagentRunId}`,
      tone: current.status === 'error' ? 'error' : 'success'
    })),
    Match.tag('TurnEnd', current => ({
      title: 'Turn ended',
      detail: current.reason,
      tone: 'neutral'
    })),
    Match.tag('AgentEnd', current => ({
      title: 'Run finished',
      detail: `${countLabel(current.turns, 'turn')} · ${countLabel(current.messages.length, 'message')}`,
      tone: 'success'
    })),
    Match.tag('AgentAwaitingInput', current => ({
      title: 'Waiting for input',
      detail: countLabel(current.requests.length, 'request'),
      tone: 'active'
    })),
    Match.tag('AgentError', current => ({
      title: agentErrorTitle(current),
      detail: agentErrorDetail(current),
      tone: 'error'
    })),
    Match.tag('AgentRetry', current => ({
      title: agentRetryTitle(current),
      detail: agentRetryDetail(current),
      tone: 'active'
    })),
    Match.tag('CompactionStart', current => ({
      title: 'Compacting context',
      detail: current.strategy,
      tone: 'active'
    })),
    Match.tag('CompactionEnd', current => ({
      title: 'Context compacted',
      detail: current.strategy,
      tone: 'success'
    })),
    Match.orElse(() => null)
  )
