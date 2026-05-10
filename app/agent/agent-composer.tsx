'use client'

import type { FormEvent } from 'react'
import { LoaderCircleIcon, MicIcon, PhoneOffIcon, SendIcon, SquareIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

type AgentComposerProps = {
  readonly input: string
  readonly inputDisabled: boolean
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
  inputDisabled,
  isRunning,
  isVoiceMode,
  isVoiceConnecting,
  isVoiceLive,
  onInputChange,
  onSubmit,
  onStop,
  onToggleVoice
}: AgentComposerProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSubmit()
  }

  return (
    <form onSubmit={handleSubmit} className="border-t border-foreground/10 p-4">
      <div className="flex gap-2">
        <Textarea
          value={input}
          onChange={event => onInputChange(event.target.value)}
          placeholder={isVoiceMode ? 'Voice mode is active...' : 'Ask the agent...'}
          className="min-h-12 resize-none"
          disabled={inputDisabled}
          aria-label="Agent prompt"
        />
        <Button
          type="button"
          size="icon-lg"
          variant={isVoiceMode ? 'destructive' : 'outline'}
          onClick={onToggleVoice}
          disabled={isRunning}
          aria-pressed={isVoiceMode}
          className="size-11"
        >
          {isVoiceConnecting ? (
            <LoaderCircleIcon className="animate-spin" />
          ) : isVoiceLive ? (
            <PhoneOffIcon />
          ) : (
            <MicIcon />
          )}
          <span className="sr-only">{isVoiceMode ? 'Stop voice mode' : 'Start voice mode'}</span>
        </Button>
        {isRunning ? (
          <Button type="button" size="icon-lg" variant="destructive" onClick={onStop}>
            <SquareIcon />
            <span className="sr-only">Stop</span>
          </Button>
        ) : (
          <Button type="submit" size="icon-lg" disabled={input.trim().length === 0 || inputDisabled}>
            <SendIcon />
            <span className="sr-only">Send</span>
          </Button>
        )}
      </div>
    </form>
  )
}
