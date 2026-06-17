import type { AgentRunStatus } from '@yolk-sdk/agent/client'
import type { AgentError, AgentRetry } from '@yolk-sdk/agent/protocol'
import { Badge } from '@/components/ui/badge'
import { countLabel } from './agent-format'
import {
  activityPanelId,
  agentErrorDetail,
  agentErrorTitle,
  agentRetryDetail,
  agentRetryTitle,
  type ActivityTone,
  type AgentActivityItem
} from './agent-activity-model'
import { textStatusVariant, voiceStatusVariant } from './agent-status'
import type { VoiceStatus } from './use-realtime-voice'

const activityToneClass = (tone: ActivityTone) => {
  switch (tone) {
    case 'active':
      return 'border-primary/20 bg-primary/5 text-primary'
    case 'success':
      return 'border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300'
    case 'error':
      return 'border-destructive/20 bg-destructive/5 text-destructive'
    case 'tool':
      return 'border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-300'
    case 'neutral':
      return 'border-foreground/10 bg-muted/40 text-muted-foreground'
  }
}

const activityToneVariant = (tone: ActivityTone) => {
  switch (tone) {
    case 'error':
      return 'destructive'
    case 'active':
    case 'success':
      return 'secondary'
    case 'neutral':
    case 'tool':
      return 'outline'
  }
}

type AgentActivityPanelProps = {
  readonly items: ReadonlyArray<AgentActivityItem>
  readonly textStatus: AgentRunStatus
  readonly voiceStatus: VoiceStatus
  readonly activeToolCallCount: number
  readonly toolResultCount: number
  readonly error: string | null
  readonly errorInfo: AgentError | null
  readonly retryInfo: AgentRetry | null
  readonly workflowRunId: string | null
  readonly workflowResumeDisabled: boolean
  readonly onResumeWorkflowRun: () => void
}

export function AgentActivityPanel({
  items,
  textStatus,
  voiceStatus,
  activeToolCallCount,
  toolResultCount,
  error,
  errorInfo,
  retryInfo,
  workflowRunId,
  workflowResumeDisabled,
  onResumeWorkflowRun
}: AgentActivityPanelProps) {
  return (
    <div id={activityPanelId} className="border-b border-foreground/10 bg-muted/20 p-4">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Badge variant={textStatusVariant(textStatus)}>text {textStatus}</Badge>
          <Badge variant={voiceStatusVariant(voiceStatus)}>voice {voiceStatus}</Badge>
          {activeToolCallCount > 0 ? (
            <Badge variant="outline">{countLabel(activeToolCallCount, 'active tool')}</Badge>
          ) : null}
          {toolResultCount > 0 ? (
            <Badge variant="secondary">{countLabel(toolResultCount, 'tool result')}</Badge>
          ) : null}
          {workflowRunId !== null ? <Badge variant="outline">workflow {workflowRunId}</Badge> : null}
        </div>

        {workflowRunId !== null ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-foreground/10 bg-background/60 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-mono">{workflowRunId}</span>
            <button
              type="button"
              disabled={workflowResumeDisabled}
              onClick={onResumeWorkflowRun}
              className="rounded-full border border-foreground/10 px-2 py-1 font-medium text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              Resume stream
            </button>
          </div>
        ) : null}

        {retryInfo !== null ? (
          <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-primary">
            <div className="font-medium">{agentRetryTitle(retryInfo)}</div>
            <div className="mt-1 whitespace-pre-wrap leading-5">{agentRetryDetail(retryInfo)}</div>
          </div>
        ) : null}

        {error !== null ? (
          <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <div className="font-medium">
              {errorInfo === null ? 'Current error' : agentErrorTitle(errorInfo)}
            </div>
            <div className="mt-1 whitespace-pre-wrap leading-5">
              {errorInfo === null ? error : agentErrorDetail(errorInfo)}
            </div>
          </div>
        ) : null}

        {items.length > 0 ? (
          <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
            {items.map(item => (
              <div
                key={item.id}
                className={`rounded-xl border px-3 py-2 text-xs ${activityToneClass(item.tone)}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-foreground">{item.title}</span>
                  <Badge variant={activityToneVariant(item.tone)}>{item.tone}</Badge>
                </div>
                {item.detail.length > 0 ? (
                  <div className="mt-1 whitespace-pre-wrap break-words leading-5">
                    {item.detail}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-foreground/10 px-3 py-2 text-xs text-muted-foreground">
            No activity yet. Tool calls, turn status, and errors will appear here.
          </p>
        )}
      </div>
    </div>
  )
}
