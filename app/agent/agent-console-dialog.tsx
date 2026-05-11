'use client'

import { useEffect, useRef, type MouseEvent } from 'react'
import { XIcon } from 'lucide-react'
import type { AgentRunStatus } from '@yolk/client'
import type { AgentReasoningEffort, AgentUsage } from '@yolk/protocol'
import type { OpenAiRealtimeTranscriptionModel } from '@/lib/agents/realtime/openai-realtime'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import type { VoiceStatus } from './use-realtime-voice'
import { AgentStatusPanel } from './agent-status'

type ConsoleSwitchProps = {
  readonly label: string
  readonly description: string
  readonly checked: boolean
  readonly onCheckedChange: (checked: boolean) => void
}

function ConsoleSwitch({ label, description, checked, onCheckedChange }: ConsoleSwitchProps) {
  return (
    <label className="flex min-h-12 cursor-pointer items-center justify-between gap-4 rounded-xl border border-foreground/10 bg-background/70 px-3 py-2 text-sm">
      <span className="grid gap-0.5">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
      <Switch checked={checked} onCheckedChange={nextChecked => onCheckedChange(nextChecked)} />
    </label>
  )
}

type AgentConsoleDialogProps = {
  readonly open: boolean
  readonly sessionId: string
  readonly openAiCodexConnected: boolean
  readonly textStatus: AgentRunStatus
  readonly voiceStatus: VoiceStatus
  readonly usage: AgentUsage
  readonly hasUsage: boolean
  readonly reasoningEffort: AgentReasoningEffort
  readonly reasoningEffortDisabled: boolean
  readonly transcriptionModel: OpenAiRealtimeTranscriptionModel
  readonly transcriptionModelDisabled: boolean
  readonly showInlineTools: boolean
  readonly showReasoning: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onReasoningEffortChange: (effort: AgentReasoningEffort) => void
  readonly onTranscriptionModelChange: (model: OpenAiRealtimeTranscriptionModel) => void
  readonly onShowInlineToolsChange: (checked: boolean) => void
  readonly onShowReasoningChange: (checked: boolean) => void
}

export function AgentConsoleDialog({
  open,
  sessionId,
  openAiCodexConnected,
  textStatus,
  voiceStatus,
  usage,
  hasUsage,
  reasoningEffort,
  reasoningEffortDisabled,
  transcriptionModel,
  transcriptionModelDisabled,
  showInlineTools,
  showReasoning,
  onOpenChange,
  onReasoningEffortChange,
  onTranscriptionModelChange,
  onShowInlineToolsChange,
  onShowReasoningChange
}: AgentConsoleDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current

    if (dialog === null) {
      return
    }

    if (open && !dialog.open) {
      dialog.showModal()
      return
    }

    if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  const handleBackdropClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) {
      onOpenChange(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onCancel={() => onOpenChange(false)}
      onClose={() => onOpenChange(false)}
      onMouseDown={handleBackdropClick}
      className="m-auto max-h-[calc(100vh-2rem)] w-[min(calc(100vw-2rem),34rem)] overflow-y-auto rounded-3xl border border-foreground/10 bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/25 backdrop:backdrop-blur-sm"
    >
      <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-foreground/10 bg-background/95 p-5 backdrop-blur">
        <div>
          <p className="text-base font-semibold">Agent console</p>
          <p className="mt-1 text-sm text-muted-foreground">Test harness controls; not chat UI.</p>
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={() => onOpenChange(false)}
          aria-label="Close agent console"
          className="rounded-full"
        >
          <XIcon />
        </Button>
      </div>

      <div className="space-y-5 p-5">
        <div className="grid gap-2">
          <ConsoleSwitch
            label="Inline tools"
            description="Show tool calls/results inside the transcript."
            checked={showInlineTools}
            onCheckedChange={onShowInlineToolsChange}
          />
          <ConsoleSwitch
            label="Reasoning summaries"
            description="Show provider-supplied reasoning summaries."
            checked={showReasoning}
            onCheckedChange={onShowReasoningChange}
          />
        </div>

        <AgentStatusPanel
          sessionId={sessionId}
          openAiCodexConnected={openAiCodexConnected}
          textStatus={textStatus}
          voiceStatus={voiceStatus}
          usage={usage}
          hasUsage={hasUsage}
          reasoningEffort={reasoningEffort}
          reasoningEffortDisabled={reasoningEffortDisabled}
          transcriptionModel={transcriptionModel}
          transcriptionModelDisabled={transcriptionModelDisabled}
          onReasoningEffortChange={onReasoningEffortChange}
          onTranscriptionModelChange={onTranscriptionModelChange}
        />
      </div>
    </dialog>
  )
}
