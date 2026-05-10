import type { AgentRunStatus } from '@yolk/client'
import type { AgentReasoningEffort } from '@yolk/protocol'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  agentTextModel,
  agentTextReasoningEffortOptions,
  agentTextReasoningSummary
} from '@/lib/agents/text-agent-config'
import {
  defaultOpenAiRealtimeReasoningEffort,
  openAiRealtimeModel
} from '@/lib/agents/realtime/openai-realtime'
import { OpenAiCodexAuthPanel } from './openai-codex-auth-panel'
import type { VoiceStatus } from './use-realtime-voice'

export const voiceStatusVariant = (status: VoiceStatus) => {
  switch (status) {
    case 'live':
      return 'secondary'
    case 'error':
      return 'destructive'
    case 'connecting':
    case 'idle':
      return 'outline'
  }
}

export const textStatusVariant = (status: AgentRunStatus) => {
  switch (status) {
    case 'done':
      return 'secondary'
    case 'error':
      return 'destructive'
    case 'aborted':
    case 'idle':
    case 'running':
      return 'outline'
  }
}

type AgentStatusPanelProps = {
  readonly sessionId: string
  readonly openAiCodexConnected: boolean
  readonly textStatus: AgentRunStatus
  readonly voiceStatus: VoiceStatus
  readonly reasoningEffort: AgentReasoningEffort
  readonly reasoningEffortDisabled: boolean
  readonly onReasoningEffortChange: (effort: AgentReasoningEffort) => void
}

function StatusRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-foreground/10 pt-3">
      <span>{label}</span>
      {children}
    </div>
  )
}

type ReasoningEffortControlProps = {
  readonly value: AgentReasoningEffort
  readonly disabled: boolean
  readonly onChange: (effort: AgentReasoningEffort) => void
}

function ReasoningEffortControl({ value, disabled, onChange }: ReasoningEffortControlProps) {
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {agentTextReasoningEffortOptions.map(effort => (
        <Button
          key={effort}
          type="button"
          size="sm"
          variant={value === effort ? 'secondary' : 'outline'}
          disabled={disabled}
          className="min-h-9 px-2 text-xs"
          onClick={() => onChange(effort)}
        >
          {effort}
        </Button>
      ))}
    </div>
  )
}

export function AgentStatusPanel({
  sessionId,
  openAiCodexConnected,
  textStatus,
  voiceStatus,
  reasoningEffort,
  reasoningEffortDisabled,
  onReasoningEffortChange
}: AgentStatusPanelProps) {
  return (
    <div className="mt-10 space-y-4">
      <OpenAiCodexAuthPanel initialConnected={openAiCodexConnected} />
      <div className="grid gap-3 text-xs text-muted-foreground">
        <StatusRow label="Session">
          <code className="rounded bg-muted px-2 py-1 text-foreground">{sessionId}</code>
        </StatusRow>
        <StatusRow label="Text model">
          <Badge variant="secondary">{agentTextModel}</Badge>
        </StatusRow>
        <StatusRow label="Reasoning">
          <ReasoningEffortControl
            value={reasoningEffort}
            disabled={reasoningEffortDisabled}
            onChange={onReasoningEffortChange}
          />
        </StatusRow>
        <StatusRow label="Summary">
          <Badge variant="outline">{agentTextReasoningSummary}</Badge>
        </StatusRow>
        <StatusRow label="Voice model">
          <Badge variant="outline">{openAiRealtimeModel}</Badge>
        </StatusRow>
        <StatusRow label="Voice reasoning">
          <Badge variant="outline">{defaultOpenAiRealtimeReasoningEffort}</Badge>
        </StatusRow>
        <StatusRow label="Status">
          <Badge variant={textStatusVariant(textStatus)}>{textStatus}</Badge>
        </StatusRow>
        <StatusRow label="Voice">
          <Badge variant={voiceStatusVariant(voiceStatus)}>{voiceStatus}</Badge>
        </StatusRow>
      </div>
    </div>
  )
}
