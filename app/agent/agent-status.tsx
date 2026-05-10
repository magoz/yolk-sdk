import type { AgentRunStatus } from '@yolk/client'
import { Badge } from '@/components/ui/badge'
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
}

export function AgentStatusPanel({
  sessionId,
  openAiCodexConnected,
  textStatus,
  voiceStatus
}: AgentStatusPanelProps) {
  return (
    <div className="mt-10 space-y-4">
      <OpenAiCodexAuthPanel initialConnected={openAiCodexConnected} />
      <div className="grid gap-3 text-xs text-muted-foreground">
        <div className="flex items-center justify-between border-t border-foreground/10 pt-3">
          <span>Session</span>
          <code className="rounded bg-muted px-2 py-1 text-foreground">{sessionId}</code>
        </div>
        <div className="flex items-center justify-between border-t border-foreground/10 pt-3">
          <span>Status</span>
          <Badge variant={textStatusVariant(textStatus)}>{textStatus}</Badge>
        </div>
        <div className="flex items-center justify-between border-t border-foreground/10 pt-3">
          <span>Voice</span>
          <Badge variant={voiceStatusVariant(voiceStatus)}>{voiceStatus}</Badge>
        </div>
      </div>
    </div>
  )
}
