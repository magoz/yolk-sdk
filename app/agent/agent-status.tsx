import type { AgentRunStatus } from '@yolk/client'
import type { AgentReasoningEffort, AgentUsage } from '@yolk/protocol'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  agentTextCapabilities,
  agentTextModelOptions,
  agentTextReasoningEffortOptions,
  agentTextReasoningSummary
} from '@/lib/agents/text-agent-config'
import type { AgentTextModel } from '@/lib/agents/text-agent-config'
import {
  defaultOpenAiRealtimeReasoningEffort,
  openAiRealtimeTranscriptionModelOptions,
  openAiRealtimeModel
} from '@/lib/agents/realtime/openai-realtime'
import type { OpenAiRealtimeTranscriptionModel } from '@/lib/agents/realtime/openai-realtime'
import { AnthropicClaudeAuthPanel } from './anthropic-claude-auth-panel'
import { OpenAiCodexAuthPanel } from './openai-codex-auth-panel'
import { AgentUsagePanel, type AgentCompactionState } from './agent-usage-meter'
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
  readonly anthropicClaudeConnected: boolean
  readonly textStatus: AgentRunStatus
  readonly voiceStatus: VoiceStatus
  readonly usage: AgentUsage
  readonly hasUsage: boolean
  readonly contextTokens: number | null
  readonly compaction: AgentCompactionState
  readonly textModel: AgentTextModel
  readonly textModelDisabled: boolean
  readonly reasoningEffort: AgentReasoningEffort
  readonly reasoningEffortDisabled: boolean
  readonly transcriptionModel: OpenAiRealtimeTranscriptionModel
  readonly transcriptionModelDisabled: boolean
  readonly onTextModelChange: (model: AgentTextModel) => void
  readonly onReasoningEffortChange: (effort: AgentReasoningEffort) => void
  readonly onTranscriptionModelChange: (model: OpenAiRealtimeTranscriptionModel) => void
}

function StatusRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-foreground/10 pt-3">
      <span>{label}</span>
      {children}
    </div>
  )
}

type TextModelControlProps = {
  readonly value: AgentTextModel
  readonly disabled: boolean
  readonly onChange: (model: AgentTextModel) => void
}

function TextModelControl({ value, disabled, onChange }: TextModelControlProps) {
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {agentTextModelOptions.map(option => (
        <Button
          key={option.model}
          type="button"
          size="sm"
          variant={value === option.model ? 'secondary' : 'outline'}
          disabled={disabled}
          className="min-h-11 px-2 text-[11px]"
          aria-pressed={value === option.model}
          onClick={() => onChange(option.model)}
        >
          {option.label}
        </Button>
      ))}
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

type TranscriptionModelControlProps = {
  readonly value: OpenAiRealtimeTranscriptionModel
  readonly disabled: boolean
  readonly onChange: (model: OpenAiRealtimeTranscriptionModel) => void
}

function TranscriptionModelControl({ value, disabled, onChange }: TranscriptionModelControlProps) {
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {openAiRealtimeTranscriptionModelOptions.map(option => (
        <Button
          key={option.model}
          type="button"
          size="sm"
          variant={value === option.model ? 'secondary' : 'outline'}
          disabled={disabled}
          className="min-h-11 px-2 text-[11px]"
          title={option.description}
          aria-pressed={value === option.model}
          onClick={() => onChange(option.model)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}

export function AgentStatusPanel({
  sessionId,
  openAiCodexConnected,
  anthropicClaudeConnected,
  textStatus,
  voiceStatus,
  usage,
  hasUsage,
  contextTokens,
  compaction,
  textModel,
  textModelDisabled,
  reasoningEffort,
  reasoningEffortDisabled,
  transcriptionModel,
  transcriptionModelDisabled,
  onTextModelChange,
  onReasoningEffortChange,
  onTranscriptionModelChange
}: AgentStatusPanelProps) {
  return (
    <div className="space-y-4">
      <OpenAiCodexAuthPanel initialConnected={openAiCodexConnected} />
      <AnthropicClaudeAuthPanel initialConnected={anthropicClaudeConnected} />
      <div className="grid gap-3 text-xs text-muted-foreground">
        <StatusRow label="Session">
          <code className="rounded bg-muted px-2 py-1 text-foreground">{sessionId}</code>
        </StatusRow>
        <StatusRow label="Text model">
          <TextModelControl
            value={textModel}
            disabled={textModelDisabled}
            onChange={onTextModelChange}
          />
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
        <StatusRow label="Usage">
          <AgentUsagePanel
            usage={usage}
            hasUsage={hasUsage}
            contextTokens={contextTokens}
            compaction={compaction}
          />
        </StatusRow>
        <StatusRow label="Inputs">
          <div className="flex flex-wrap justify-end gap-1.5">
            <Badge variant={agentTextCapabilities.input.text ? 'secondary' : 'outline'}>text</Badge>
            <Badge variant={agentTextCapabilities.input.image ? 'secondary' : 'outline'}>
              image
            </Badge>
            <Badge variant={agentTextCapabilities.input.audio ? 'secondary' : 'outline'}>
              audio
            </Badge>
          </div>
        </StatusRow>
        <StatusRow label="Tools">
          <Badge variant={agentTextCapabilities.tools ? 'secondary' : 'outline'}>
            {agentTextCapabilities.tools ? 'enabled' : 'disabled'}
          </Badge>
        </StatusRow>
        <StatusRow label="Voice model">
          <Badge variant="outline">{openAiRealtimeModel}</Badge>
        </StatusRow>
        <StatusRow label="Transcription">
          <TranscriptionModelControl
            value={transcriptionModel}
            disabled={transcriptionModelDisabled}
            onChange={onTranscriptionModelChange}
          />
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
