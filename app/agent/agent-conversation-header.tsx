'use client'

import { ChevronDownIcon, ChevronRightIcon, LoaderCircleIcon, MicIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { activityPanelId } from './agent-activity'

type DisplaySwitchProps = {
  readonly label: string
  readonly description: string
  readonly checked: boolean
  readonly disabled?: boolean
  readonly onCheckedChange: (checked: boolean) => void
}

function DisplaySwitch({
  label,
  description,
  checked,
  disabled = false,
  onCheckedChange
}: DisplaySwitchProps) {
  return (
    <label
      className={cn(
        'flex min-h-11 items-center gap-3 rounded-xl border border-foreground/10 bg-background px-3 py-2 text-xs shadow-xs',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
      )}
    >
      <span className="grid gap-0.5">
        <span className="font-medium leading-none">{label}</span>
        <span className="text-[11px] leading-none text-muted-foreground">{description}</span>
      </span>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={nextChecked => onCheckedChange(nextChecked)}
      />
    </label>
  )
}

type AgentConversationHeaderProps = {
  readonly activityVisible: boolean
  readonly activityCount: number
  readonly liveActivityCount: number
  readonly showInlineTools: boolean
  readonly showReasoning: boolean
  readonly hasReasoningSummary: boolean
  readonly isRunning: boolean
  readonly isVoiceConnecting: boolean
  readonly isVoiceLive: boolean
  readonly onToggleActivity: () => void
  readonly onShowInlineToolsChange: (checked: boolean) => void
  readonly onShowReasoningChange: (checked: boolean) => void
}

export function AgentConversationHeader({
  activityVisible,
  activityCount,
  liveActivityCount,
  showInlineTools,
  showReasoning,
  hasReasoningSummary,
  isRunning,
  isVoiceConnecting,
  isVoiceLive,
  onToggleActivity,
  onShowInlineToolsChange,
  onShowReasoningChange
}: AgentConversationHeaderProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-foreground/10 px-5 py-4">
      <div>
        <p className="text-sm font-medium">Conversation</p>
        <p className="text-xs text-muted-foreground">Type, or tap the mic to talk.</p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <DisplaySwitch
          label="Tools"
          description="Inline calls"
          checked={showInlineTools}
          onCheckedChange={onShowInlineToolsChange}
        />
        <DisplaySwitch
          label="Reasoning"
          description={hasReasoningSummary ? 'Summaries' : 'Waiting'}
          checked={showReasoning}
          onCheckedChange={onShowReasoningChange}
        />
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
