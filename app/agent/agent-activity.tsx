import type { AgentRunStatus } from '@yolk/client'
import type { AgentEvent } from '@yolk/protocol'
import { Badge } from '@/components/ui/badge'
import { contentPreview, countLabel, truncate, unknownPreview } from './agent-format'
import { textStatusVariant, voiceStatusVariant } from './agent-status'
import type { VoiceStatus } from './use-realtime-voice'

type ActivityTone = 'neutral' | 'active' | 'success' | 'error' | 'tool'

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
    case 'LLMToolCall':
      return {
        title: `Tool requested: ${event.call.name}`,
        detail: unknownPreview(event.call.params),
        tone: 'tool'
      }
    case 'ToolExecutionStart':
      return { title: `Running tool: ${event.call.name}`, detail: event.call.id, tone: 'tool' }
    case 'ToolExecutionEnd':
      return {
        title: `Tool result: ${event.call.name}`,
        detail: truncate(contentPreview(event.result.content)),
        tone: 'success'
      }
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
    case 'AssistantMessage':
    case 'LLMReasoningDelta':
    case 'LLMStreamEnd':
    case 'LLMTextDelta':
    case 'ToolResult':
      return null
  }
}

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
}

export function AgentActivityPanel({
  items,
  textStatus,
  voiceStatus,
  activeToolCallCount,
  toolResultCount,
  error
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
        </div>

        {error !== null ? (
          <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <div className="font-medium">Current error</div>
            <div className="mt-1 whitespace-pre-wrap leading-5">{error}</div>
          </div>
        ) : null}

        {items.length > 0 ? (
          <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
            {items.map(item => (
              <div key={item.id} className={`rounded-xl border px-3 py-2 text-xs ${activityToneClass(item.tone)}`}>
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-foreground">{item.title}</span>
                  <Badge variant={activityToneVariant(item.tone)}>{item.tone}</Badge>
                </div>
                {item.detail.length > 0 ? (
                  <div className="mt-1 whitespace-pre-wrap break-words leading-5">{item.detail}</div>
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
