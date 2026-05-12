'use client'

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent
} from 'react'
import Image from 'next/image'
import { Array as Arr, Option } from 'effect'
import {
  ArrowUpIcon,
  ImageIcon,
  LoaderCircleIcon,
  MicIcon,
  PhoneOffIcon,
  SquareIcon,
  TerminalIcon,
  XIcon
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  matchingSlashCommands,
  normalizeSlashSelectionIndex,
  slashCommandInput,
  type AgentCommandSummary
} from './slash-command-model'

export type AgentComposerImageAttachment = {
  readonly _tag: 'Ready'
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly previewUrl: string
}

export type AgentComposerFailedImageAttachment = {
  readonly _tag: 'Failed'
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly reason: string
}

export type AgentComposerAttachment =
  | AgentComposerImageAttachment
  | AgentComposerFailedImageAttachment

type AgentComposerProps = {
  readonly input: string
  readonly submitDisabled: boolean
  readonly isRunning: boolean
  readonly isVoiceMode: boolean
  readonly isVoiceConnecting: boolean
  readonly isVoiceLive: boolean
  readonly imageInputSupported: boolean
  readonly imageAttachments: ReadonlyArray<AgentComposerAttachment>
  readonly commands: ReadonlyArray<AgentCommandSummary>
  readonly isCommandRendering: boolean
  readonly onInputChange: (value: string) => void
  readonly onImageAttachmentsChange: (files: ReadonlyArray<File>) => void
  readonly onRemoveImageAttachment: (id: string) => void
  readonly onRetryImageAttachment: (id: string) => void
  readonly onSlashCommandSubmit: (command: string, argumentsText: string) => void
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
  imageInputSupported,
  imageAttachments,
  commands,
  isCommandRendering,
  onInputChange,
  onImageAttachmentsChange,
  onRemoveImageAttachment,
  onRetryImageAttachment,
  onSlashCommandSubmit,
  onSubmit,
  onStop,
  onToggleVoice
}: AgentComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragDepth, setDragDepth] = useState(0)
  const [activeCommandIndex, setActiveCommandIndex] = useState(0)
  const dropDisabled = isRunning || isVoiceMode || !imageInputSupported
  const isDropActive = dragDepth > 0 && !dropDisabled
  const hasAttachments = imageAttachments.length > 0
  const hasReadyAttachments = Option.isSome(
    Arr.findFirst(imageAttachments, imageAttachment => imageAttachment._tag === 'Ready')
  )
  const commandMatches = matchingSlashCommands(input, commands)
  const slashCommandsDisabled = isRunning || isVoiceMode || hasAttachments || isCommandRendering
  const slashMenuOpen = commandMatches.length > 0 && !slashCommandsDisabled
  const normalizedActiveCommandIndex = normalizeSlashSelectionIndex(
    activeCommandIndex,
    commandMatches.length
  )
  const selectedCommand = commandMatches[normalizedActiveCommandIndex]

  const submitSlashCommand = (command: AgentCommandSummary) => {
    Option.match(slashCommandInput(input), {
      onNone: () => undefined,
      onSome: slash => onSlashCommandSubmit(command.name, slash.argumentsText)
    })
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSubmit()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) {
      return
    }

    if (slashMenuOpen && event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveCommandIndex(current => normalizeSlashSelectionIndex(current + 1, commandMatches.length))
      return
    }

    if (slashMenuOpen && event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveCommandIndex(current => normalizeSlashSelectionIndex(current - 1, commandMatches.length))
      return
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()

      if (slashMenuOpen && selectedCommand !== undefined) {
        submitSlashCommand(selectedCommand)
        return
      }

      onSubmit()
    }
  }

  const handleAttachClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    onImageAttachmentsChange(Array.from(event.target.files ?? []))
    event.target.value = ''
  }

  const handleTextChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setActiveCommandIndex(0)
    onInputChange(event.target.value)
  }

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (dropDisabled) {
      return
    }

    const imageFiles = Array.from(event.clipboardData.files).filter(file =>
      file.type.startsWith('image/')
    )

    if (imageFiles.length === 0) {
      return
    }

    event.preventDefault()
    onImageAttachmentsChange(imageFiles)
  }

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()

    if (dropDisabled) {
      return
    }

    setDragDepth(current => current + 1)
  }

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = dropDisabled ? 'none' : 'copy'
  }

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()

    if (dropDisabled) {
      return
    }

    setDragDepth(current => Math.max(0, current - 1))
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragDepth(0)

    if (dropDisabled) {
      return
    }

    onImageAttachmentsChange(Array.from(event.dataTransfer.files))
  }

  const hint = isVoiceMode
    ? 'Voice mode active'
    : isRunning
      ? 'Streaming response'
      : imageInputSupported
        ? 'Enter to send · Shift Enter newline · paste images'
        : 'Enter to send · Shift Enter newline'

  useEffect(() => {
    textareaRef.current?.focus()
  }, [submitDisabled])

  return (
    <form onSubmit={handleSubmit} className="px-4 pb-4 pt-2 sm:px-6">
      <div
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'relative mx-auto w-full max-w-3xl rounded-[1.5rem] border bg-card/95 p-2 shadow-lg shadow-foreground/5 transition-[border-color,box-shadow,background-color] duration-150 ease-out focus-within:border-ring/50 focus-within:ring-2 focus-within:ring-ring/10',
          isDropActive
            ? 'border-primary/50 bg-primary/5 ring-2 ring-primary/15'
            : 'border-foreground/10'
        )}
      >
        {isDropActive ? (
          <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-[1.15rem] border border-dashed border-primary/60 bg-background/80 text-sm font-medium text-primary backdrop-blur-sm">
            Drop image to attach
          </div>
        ) : null}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          onChange={handleFileChange}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
        />
        {hasAttachments ? (
          <div className="flex flex-wrap gap-2 px-2 pt-2">
            {imageAttachments.map(imageAttachment => (
              <div
                key={imageAttachment.id}
                className={cn(
                  'inline-flex max-w-full items-center gap-2 rounded-2xl border p-1.5 pr-2 text-xs text-muted-foreground',
                  imageAttachment._tag === 'Failed'
                    ? 'border-destructive/25 bg-destructive/5'
                    : 'border-foreground/10 bg-muted/50'
                )}
              >
                {imageAttachment._tag === 'Ready' ? (
                  <Image
                    src={imageAttachment.previewUrl}
                    alt="Attached image preview"
                    width={48}
                    height={48}
                    unoptimized
                    className="size-12 rounded-xl object-cover"
                  />
                ) : (
                  <div className="grid size-12 place-items-center rounded-xl bg-destructive/10 text-destructive">
                    <ImageIcon className="size-5" aria-hidden />
                  </div>
                )}
                <div className="min-w-0">
                  <div className="max-w-36 truncate font-medium text-foreground">
                    {imageAttachment.name}
                  </div>
                  <div
                    className={cn(
                      'max-w-48 truncate',
                      imageAttachment._tag === 'Failed' ? 'text-destructive' : undefined
                    )}
                  >
                    {imageAttachment._tag === 'Failed'
                      ? imageAttachment.reason
                      : imageAttachment.mimeType}
                  </div>
                </div>
                {imageAttachment._tag === 'Failed' ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => onRetryImageAttachment(imageAttachment.id)}
                    disabled={dropDisabled}
                    className="h-8 rounded-full px-2 text-xs"
                  >
                    Retry
                    <span className="sr-only"> {imageAttachment.name}</span>
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => onRemoveImageAttachment(imageAttachment.id)}
                  className="ml-1 rounded-full"
                >
                  <XIcon />
                  <span className="sr-only">Remove image {imageAttachment.name}</span>
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        <Textarea
          ref={textareaRef}
          value={input}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={isVoiceMode ? 'Voice mode is active...' : 'Ask the agent...'}
          className="max-h-48 min-h-20 resize-none border-0 bg-transparent px-3 py-3 text-base shadow-none focus-visible:border-transparent focus-visible:ring-0 md:text-sm"
          aria-label="Agent prompt"
        />
        {slashMenuOpen ? (
          <div className="px-1 pb-2">
            <div
              role="listbox"
              aria-label="Slash commands"
              className="max-h-56 overflow-y-auto rounded-2xl border border-foreground/10 bg-popover p-1 shadow-lg shadow-foreground/10"
            >
              {commandMatches.map((command, index) => (
                <button
                  key={command.name}
                  type="button"
                  role="option"
                  aria-selected={index === normalizedActiveCommandIndex}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => submitSlashCommand(command)}
                  className={cn(
                    'flex min-h-11 w-full items-start gap-3 rounded-xl px-3 py-2 text-left transition-colors duration-150 ease-out',
                    index === normalizedActiveCommandIndex
                      ? 'bg-accent text-accent-foreground'
                      : 'text-popover-foreground hover:bg-accent/60'
                  )}
                >
                  <TerminalIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">/{command.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {command.description ??
                        (command.hints.length > 0 ? command.hints.join(' ') : 'Run command')}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
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
            <span className="truncate">
              {isCommandRendering ? 'Rendering command' : slashMenuOpen ? 'Select command' : hint}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              size="icon-lg"
              variant="outline"
              onClick={handleAttachClick}
              disabled={dropDisabled}
              title={imageInputSupported ? 'Attach image' : 'Current model does not support images'}
              className="size-10 rounded-full"
            >
              <ImageIcon />
              <span className="sr-only">Attach image</span>
            </Button>
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
                disabled={(input.trim().length === 0 && !hasReadyAttachments) || submitDisabled}
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
