'use client'

import { useEffect, useRef, type FormEvent, type KeyboardEvent } from 'react'
import { ArrowUpIcon, LoaderCircleIcon, MicIcon, PhoneOffIcon, SquareIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

type AgentComposerProps = {
  readonly input: string
  readonly submitDisabled: boolean
  readonly isRunning: boolean
  readonly isVoiceMode: boolean
  readonly isVoiceConnecting: boolean
  readonly isVoiceLive: boolean
  readonly onInputChange: (value: string) => void
  readonly onSubmit: () => void
  readonly onStop: () => void
  readonly onToggleVoice: () => void
}

export function AgentComposer({
  input,
  submitDisabled,
  isRunning,
  isVoiceMode,
  isVoiceConnecting,
  isVoiceLive,
  onInputChange,
  onSubmit,
  onStop,
  onToggleVoice
}: AgentComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSubmit()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) {
      return
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onSubmit()
    }
  }

  const hint = isVoiceMode
    ? 'Voice mode active'
    : isRunning
      ? 'Streaming response'
      : 'Enter to send · Shift Enter newline'

  useEffect(() => {
    textareaRef.current?.focus()
  }, [submitDisabled])

  return (
    <form onSubmit={handleSubmit} className="px-4 pb-4 pt-2 sm:px-6">
      <div className="mx-auto w-full max-w-3xl rounded-[1.5rem] border border-foreground/10 bg-card/95 p-2 shadow-lg shadow-foreground/5 transition-colors duration-200 focus-within:border-ring/50 focus-within:ring-2 focus-within:ring-ring/10">
        <Textarea
          ref={textareaRef}
          value={input}
          onChange={event => onInputChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isVoiceMode ? 'Voice mode is active...' : 'Ask the agent...'}
          className="max-h-48 min-h-20 resize-none border-0 bg-transparent px-3 py-3 text-base shadow-none focus-visible:border-transparent focus-visible:ring-0 md:text-sm"
          aria-label="Agent prompt"
        />
        <div className="flex items-center justify-between gap-3 px-1 pb-1">
          <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
            <span
              className={
                isVoiceMode || isRunning
                  ? 'size-1.5 shrink-0 rounded-full bg-primary ring-4 ring-primary/10'
                  : 'size-1.5 shrink-0 rounded-full bg-muted-foreground/30'
              }
              aria-hidden
            />
            <span className="truncate">{hint}</span>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              size="icon-lg"
              variant={isVoiceMode ? 'destructive' : 'outline'}
              onClick={onToggleVoice}
              disabled={isRunning}
              aria-pressed={isVoiceMode}
              className="size-10 rounded-full"
            >
              {isVoiceConnecting ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : isVoiceLive ? (
                <PhoneOffIcon />
              ) : (
                <MicIcon />
              )}
              <span className="sr-only">
                {isVoiceMode ? 'Stop voice mode' : 'Start voice mode'}
              </span>
            </Button>
            {isRunning ? (
              <Button
                type="button"
                size="icon-lg"
                variant="destructive"
                onClick={onStop}
                className="size-10 rounded-full"
              >
                <SquareIcon />
                <span className="sr-only">Stop</span>
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon-lg"
                disabled={input.trim().length === 0 || submitDisabled}
                className="size-10 rounded-full"
              >
                <ArrowUpIcon />
                <span className="sr-only">Send</span>
              </Button>
            )}
          </div>
        </div>
      </div>
    </form>
  )
}
