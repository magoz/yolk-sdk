'use client'

import { ChevronDownIcon, ChevronRightIcon, LoaderCircleIcon, MicIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { activityPanelId } from './agent-activity'

type AgentConversationHeaderProps = {
  readonly activityVisible: boolean
  readonly activityCount: number
  readonly liveActivityCount: number
  readonly isRunning: boolean
  readonly isVoiceConnecting: boolean
  readonly isVoiceLive: boolean
  readonly onToggleActivity: () => void
}

export function AgentConversationHeader({
  activityVisible,
  activityCount,
  liveActivityCount,
  isRunning,
  isVoiceConnecting,
  isVoiceLive,
  onToggleActivity
}: AgentConversationHeaderProps) {
  return (
    <div className="flex items-center justify-between border-b border-foreground/10 px-5 py-4">
      <div>
        <p className="text-sm font-medium">Conversation</p>
        <p className="text-xs text-muted-foreground">Type, or tap the mic to talk.</p>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={activityVisible ? 'secondary' : 'outline'}
          aria-expanded={activityVisible}
          aria-controls={activityPanelId}
          onClick={onToggleActivity}
          className="min-h-11"
        >
          {activityVisible ? <ChevronDownIcon /> : <ChevronRightIcon />}
          Activity
          {activityCount > 0 ? <Badge variant="outline">{activityCount}</Badge> : null}
          {liveActivityCount > 0 ? <span className="size-2 rounded-full bg-primary" /> : null}
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
