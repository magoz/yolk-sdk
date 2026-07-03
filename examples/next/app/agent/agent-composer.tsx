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
  AudioLinesIcon,
  BrainIcon,
  ChevronDownIcon,
  FileTextIcon,
  ImageIcon,
  LoaderCircleIcon,
  MicIcon,
  SparklesIcon,
  PhoneOffIcon,
  SquareIcon,
  TerminalIcon,
  Volume2Icon,
  VolumeXIcon,
  XIcon
} from 'lucide-react'
import type { AgentReasoningEffort } from '@yolk-sdk/agent/protocol'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  agentTextModelOptions,
  agentTextReasoningEffortOptions,
  type AgentTextModel
} from '@/lib/agents/text-agent-config'
import {
  matchingSlashCommands,
  normalizeSlashSelectionIndex,
  slashCommandHint,
  slashCommandInput,
  slashCommandMeta,
  type AgentCommandSummary
} from './slash-command-model'

export type AgentComposerReadyImageAttachment = {
  readonly _tag: 'Ready'
  readonly kind: 'image'
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly previewUrl: string
}

export type AgentComposerReadyDocumentAttachment = {
  readonly _tag: 'Ready'
  readonly kind: 'document'
  readonly id: string
  readonly name: string
  readonly mimeType: string
}

export type AgentComposerFailedAttachment = {
  readonly _tag: 'Failed'
  readonly kind: 'image' | 'document'
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly reason: string
}

export type AgentComposerAttachment =
  | AgentComposerReadyImageAttachment
  | AgentComposerReadyDocumentAttachment
  | AgentComposerFailedAttachment

type AgentComposerProps = {
  readonly input: string
  readonly submitDisabled: boolean
  readonly isRunning: boolean
  readonly isVoiceMode: boolean
  readonly isVoiceConnecting: boolean
  readonly isVoiceLive: boolean
  readonly isHoldRecording: boolean
  readonly isHoldTranscribing: boolean
  readonly ttsEnabled: boolean
  readonly isTtsSpeaking: boolean
  readonly imageInputSupported: boolean
  readonly documentInputSupported: boolean
  readonly textModel: AgentTextModel
  readonly textModelDisabled: boolean
  readonly reasoningEffort: AgentReasoningEffort
  readonly reasoningEffortDisabled: boolean
  readonly attachments: ReadonlyArray<AgentComposerAttachment>
  readonly commands: ReadonlyArray<AgentCommandSummary>
  readonly isCommandRendering: boolean
  readonly onInputChange: (value: string) => void
  readonly onTextModelChange: (model: AgentTextModel) => void
  readonly onReasoningEffortChange: (effort: AgentReasoningEffort) => void
  readonly onAttachmentsChange: (files: ReadonlyArray<File>) => void
  readonly onRemoveAttachment: (id: string) => void
  readonly onRetryAttachment: (id: string) => void
  readonly onSlashCommandSubmit: (command: string, argumentsText: string) => void
  readonly onSubmit: () => void
  readonly onStop: () => void
  readonly onToggleVoice: () => void
  readonly onHoldStart: () => void
  readonly onHoldEnd: () => void
  readonly onToggleTts: () => void
}

export function AgentComposer({
  input,
  submitDisabled,
  isRunning,
  isVoiceMode,
  isVoiceConnecting,
  isVoiceLive,
  isHoldRecording,
  isHoldTranscribing,
  ttsEnabled,
  isTtsSpeaking,
  imageInputSupported,
  documentInputSupported,
  textModel,
  textModelDisabled,
  reasoningEffort,
  reasoningEffortDisabled,
  attachments,
  commands,
  isCommandRendering,
  onInputChange,
  onTextModelChange,
  onReasoningEffortChange,
  onAttachmentsChange,
  onRemoveAttachment,
  onRetryAttachment,
  onSlashCommandSubmit,
  onSubmit,
  onStop,
  onToggleVoice,
  onHoldStart,
  onHoldEnd,
  onToggleTts
}: AgentComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragDepth, setDragDepth] = useState(0)
  const [activeCommandIndex, setActiveCommandIndex] = useState(0)
  const [dismissedSlashInput, setDismissedSlashInput] = useState('')
  const attachmentInputSupported = imageInputSupported || documentInputSupported
  const dropDisabled = isRunning || isVoiceMode || !attachmentInputSupported
  const isDropActive = dragDepth > 0 && !dropDisabled
  const hasAttachments = attachments.length > 0
  const hasReadyAttachments = Option.isSome(
    Arr.findFirst(attachments, attachment => attachment._tag === 'Ready')
  )
  const commandMatches = matchingSlashCommands(input, commands)
  const hasSlashInput = Option.isSome(slashCommandInput(input))
  const slashCommandsDisabled = isRunning || isVoiceMode || hasAttachments || isCommandRendering
  const slashMenuOpen = hasSlashInput && !slashCommandsDisabled && dismissedSlashInput !== input
  const normalizedActiveCommandIndex = normalizeSlashSelectionIndex(
    activeCommandIndex,
    commandMatches.length
  )
  const selectedCommand = commandMatches[normalizedActiveCommandIndex]
  const selectedTextModel = agentTextModelOptions.find(option => option.model === textModel)
  const acceptedFileTypes = [
    imageInputSupported ? 'image/png,image/jpeg,image/webp,image/gif' : '',
    documentInputSupported ? 'application/pdf' : ''
  ]
    .filter(value => value.length > 0)
    .join(',')

  const isSupportedPasteFile = (file: File) =>
    (imageInputSupported && file.type.startsWith('image/')) ||
    (documentInputSupported &&
      (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')))

  const handleTextModelChange = (value: string) => {
    const option = agentTextModelOptions.find(candidate => candidate.model === value)

    if (option !== undefined) {
      onTextModelChange(option.model)
    }
  }

  const handleReasoningEffortChange = (value: string) => {
    const effort = agentTextReasoningEffortOptions.find(candidate => candidate === value)

    if (effort !== undefined) {
      onReasoningEffortChange(effort)
    }
  }

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
      setActiveCommandIndex(current =>
        normalizeSlashSelectionIndex(current + 1, commandMatches.length)
      )
      return
    }

    if (slashMenuOpen && event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveCommandIndex(current =>
        normalizeSlashSelectionIndex(current - 1, commandMatches.length)
      )
      return
    }

    if (slashMenuOpen && event.key === 'Escape') {
      event.preventDefault()
      setDismissedSlashInput(input)
      return
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()

      if (slashMenuOpen) {
        if (selectedCommand !== undefined) {
          submitSlashCommand(selectedCommand)
        }
        return
      }

      onSubmit()
    }
  }

  const handleAttachClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    onAttachmentsChange(Array.from(event.target.files ?? []))
    event.target.value = ''
  }

  const handleTextChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setActiveCommandIndex(0)
    setDismissedSlashInput('')
    onInputChange(event.target.value)
  }

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (dropDisabled) {
      return
    }

    const pastedFiles = Array.from(event.clipboardData.files).filter(isSupportedPasteFile)

    if (pastedFiles.length === 0) {
      return
    }

    event.preventDefault()
    onAttachmentsChange(pastedFiles)
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

    onAttachmentsChange(Array.from(event.dataTransfer.files))
  }

  const hint = isVoiceMode
    ? 'Voice mode active'
    : isHoldRecording
      ? 'Recording · release to transcribe into the input'
      : isHoldTranscribing
        ? 'Transcribing'
        : isRunning
          ? 'Streaming response'
          : attachmentInputSupported
            ? 'Enter to send · Shift Enter newline · attach PDFs/images'
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
            Drop files to attach
          </div>
        ) : null}
        <input
          ref={fileInputRef}
          type="file"
          accept={acceptedFileTypes}
          multiple
          onChange={handleFileChange}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
        />
        {hasAttachments ? (
          <div className="flex flex-wrap gap-2 px-2 pt-2">
            {attachments.map(attachment => (
              <div
                key={attachment.id}
                className={cn(
                  'inline-flex max-w-full items-center gap-2 rounded-2xl border p-1.5 pr-2 text-xs text-muted-foreground',
                  attachment._tag === 'Failed'
                    ? 'border-destructive/25 bg-destructive/5'
                    : 'border-foreground/10 bg-muted/50'
                )}
              >
                {attachment._tag === 'Ready' && attachment.kind === 'image' ? (
                  <Image
                    src={attachment.previewUrl}
                    alt="Attached image preview"
                    width={48}
                    height={48}
                    unoptimized
                    className="size-12 rounded-xl object-cover"
                  />
                ) : attachment._tag === 'Ready' && attachment.kind === 'document' ? (
                  <div className="grid size-12 place-items-center rounded-xl bg-primary/10 text-primary">
                    <FileTextIcon className="size-5" aria-hidden />
                  </div>
                ) : (
                  <div className="grid size-12 place-items-center rounded-xl bg-destructive/10 text-destructive">
                    {attachment.kind === 'image' ? (
                      <ImageIcon className="size-5" aria-hidden />
                    ) : (
                      <FileTextIcon className="size-5" aria-hidden />
                    )}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="max-w-36 truncate font-medium text-foreground">
                    {attachment.name}
                  </div>
                  <div
                    className={cn(
                      'max-w-48 truncate',
                      attachment._tag === 'Failed' ? 'text-destructive' : undefined
                    )}
                  >
                    {attachment._tag === 'Failed' ? attachment.reason : attachment.mimeType}
                  </div>
                </div>
                {attachment._tag === 'Failed' ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => onRetryAttachment(attachment.id)}
                    disabled={dropDisabled}
                    className="h-8 rounded-full px-2 text-xs"
                  >
                    Retry
                    <span className="sr-only"> {attachment.name}</span>
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => onRemoveAttachment(attachment.id)}
                  className="ml-1 rounded-full"
                >
                  <XIcon />
                  <span className="sr-only">Remove attachment {attachment.name}</span>
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
              {commandMatches.length === 0 ? (
                <div className="min-h-11 rounded-xl px-3 py-2 text-sm text-muted-foreground">
                  No matching commands
                </div>
              ) : (
                commandMatches.map((command, index) => {
                  const meta = slashCommandMeta(command)

                  return (
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
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium">/{command.name}</span>
                          {meta.length > 0 ? (
                            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                              {meta}
                            </span>
                          ) : null}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {command.description ?? slashCommandHint(command)}
                        </span>
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          </div>
        ) : null}
        <div className="flex flex-col gap-2 px-1 pb-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={textModelDisabled}
                className="inline-flex min-h-11 max-w-48 items-center gap-2 rounded-full px-2.5 text-xs text-muted-foreground transition-[background-color,color] hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                aria-label="Select text model"
              >
                <SparklesIcon className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{selectedTextModel?.label ?? textModel}</span>
                <ChevronDownIcon className="size-3 shrink-0 opacity-60" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Model</div>
                <DropdownMenuRadioGroup value={textModel} onValueChange={handleTextModelChange}>
                  {agentTextModelOptions.map(option => (
                    <DropdownMenuRadioItem key={option.model} value={option.model}>
                      <span className="min-w-0">
                        <span className="block truncate text-sm">{option.label}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {option.provider}
                        </span>
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={reasoningEffortDisabled}
                className="inline-flex min-h-11 items-center gap-2 rounded-full px-2.5 text-xs text-muted-foreground transition-[background-color,color] hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                aria-label="Select reasoning effort"
              >
                <BrainIcon className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{reasoningEffort}</span>
                <ChevronDownIcon className="size-3 shrink-0 opacity-60" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-44">
                <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                  Reasoning
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup
                  value={reasoningEffort}
                  onValueChange={handleReasoningEffortChange}
                >
                  {agentTextReasoningEffortOptions.map(effort => (
                    <DropdownMenuRadioItem key={effort} value={effort}>
                      {effort}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="flex min-w-0 flex-1 items-center gap-2 text-[11px] text-muted-foreground">
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
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              size="icon-lg"
              variant="outline"
              onClick={handleAttachClick}
              disabled={dropDisabled}
              title={
                attachmentInputSupported
                  ? 'Attach files'
                  : 'Current model does not support attachments'
              }
              className="size-10 rounded-full"
            >
              <ImageIcon />
              <span className="sr-only">Attach files</span>
            </Button>
            <Button
              type="button"
              size="icon-lg"
              variant={isHoldRecording ? 'destructive' : 'outline'}
              disabled={isVoiceMode || isHoldTranscribing}
              aria-pressed={isHoldRecording}
              title="Hold to speak · transcription lands in the input"
              className="size-10 touch-none select-none rounded-full"
              onPointerDown={event => {
                event.preventDefault()
                event.currentTarget.setPointerCapture(event.pointerId)
                onHoldStart()
              }}
              onPointerUp={onHoldEnd}
              onPointerCancel={onHoldEnd}
              onContextMenu={event => event.preventDefault()}
            >
              {isHoldTranscribing ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <MicIcon className={isHoldRecording ? 'animate-pulse' : undefined} />
              )}
              <span className="sr-only">
                {isHoldRecording ? 'Release to transcribe' : 'Hold to speak'}
              </span>
            </Button>
            <Button
              type="button"
              size="icon-lg"
              variant={isVoiceMode ? 'destructive' : 'outline'}
              onClick={onToggleVoice}
              disabled={isRunning || isHoldRecording || isHoldTranscribing}
              aria-pressed={isVoiceMode}
              title="Realtime voice conversation"
              className="size-10 rounded-full"
            >
              {isVoiceConnecting ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : isVoiceLive ? (
                <PhoneOffIcon />
              ) : (
                <AudioLinesIcon />
              )}
              <span className="sr-only">
                {isVoiceMode ? 'Stop realtime voice' : 'Start realtime voice'}
              </span>
            </Button>
            <Button
              type="button"
              size="icon-lg"
              variant={ttsEnabled ? 'secondary' : 'outline'}
              onClick={onToggleTts}
              disabled={isVoiceMode}
              aria-pressed={ttsEnabled}
              title={ttsEnabled ? 'Stop speaking replies' : 'Speak replies aloud'}
              className="size-10 rounded-full"
            >
              {ttsEnabled ? (
                <Volume2Icon className={isTtsSpeaking ? 'animate-pulse' : undefined} />
              ) : (
                <VolumeXIcon />
              )}
              <span className="sr-only">
                {ttsEnabled ? 'Disable spoken replies' : 'Enable spoken replies'}
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
