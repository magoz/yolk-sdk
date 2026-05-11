'use client'

import {
  ChevronDownIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
  MicIcon,
  SlidersHorizontalIcon
} from 'lucide-react'
import type { AgentRunStatus } from '@yolk/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { activityPanelId } from './agent-activity-model'
import { textStatusVariant, voiceStatusVariant } from './agent-status'
import type { VoiceStatus } from './use-realtime-voice'

type AgentConversationHeaderProps = {
  readonly activityVisible: boolean
  readonly activityCount: number
  readonly liveActivityCount: number
  readonly textStatus: AgentRunStatus
  readonly voiceStatus: VoiceStatus
  readonly isRunning: boolean
  readonly isVoiceConnecting: boolean
  readonly isVoiceLive: boolean
  readonly onToggleActivity: () => void
  readonly onOpenConsole: () => void
}

export function AgentConversationHeader({
  activityVisible,
  activityCount,
  liveActivityCount,
  textStatus,
  voiceStatus,
  isRunning,
  isVoiceConnecting,
  isVoiceLive,
  onToggleActivity,
  onOpenConsole
}: AgentConversationHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-foreground/10 bg-background/60 px-4 py-3 backdrop-blur sm:px-5">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">Yolk agent</p>
        <p className="truncate text-xs text-muted-foreground">Text, image + voice console</p>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2">
        <Badge variant={textStatusVariant(textStatus)} className="hidden sm:inline-flex">
          {textStatus}
        </Badge>
        <Badge variant={voiceStatusVariant(voiceStatus)} className="hidden sm:inline-flex">
          voice {voiceStatus}
        </Badge>
        <Button
          type="button"
          size="sm"
          variant={activityVisible ? 'secondary' : 'outline'}
          aria-expanded={activityVisible}
          aria-controls={activityPanelId}
          onClick={onToggleActivity}
          className="min-h-10 rounded-full"
        >
          {activityVisible ? <ChevronDownIcon /> : <ChevronRightIcon />}
          Activity
          {activityCount > 0 ? <Badge variant="outline">{activityCount}</Badge> : null}
          {liveActivityCount > 0 ? <span className="size-2 rounded-full bg-primary" /> : null}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onOpenConsole}
          className="min-h-10 rounded-full"
        >
          <SlidersHorizontalIcon />
          <span className="hidden sm:inline">Console</span>
        </Button>
        {isRunning || isVoiceConnecting ? (
          <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />
        ) : isVoiceLive ? (
          <MicIcon className="size-4 text-primary" />
        ) : null}
      </div>
    </div>
  )
}
