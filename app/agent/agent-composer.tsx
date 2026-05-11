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
import {
  ArrowUpIcon,
  ImageIcon,
  LoaderCircleIcon,
  MicIcon,
  PhoneOffIcon,
  SquareIcon,
  XIcon
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

export type AgentComposerImageAttachment = {
  readonly name: string
  readonly mimeType: string
  readonly previewUrl: string
}

type AgentComposerProps = {
  readonly input: string
  readonly submitDisabled: boolean
  readonly isRunning: boolean
  readonly isVoiceMode: boolean
  readonly isVoiceConnecting: boolean
  readonly isVoiceLive: boolean
  readonly imageInputSupported: boolean
  readonly imageAttachments: ReadonlyArray<AgentComposerImageAttachment>
  readonly onInputChange: (value: string) => void
  readonly onImageAttachmentsChange: (files: ReadonlyArray<File>) => void
  readonly onRemoveImageAttachment: (index: number) => void
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
  onInputChange,
  onImageAttachmentsChange,
  onRemoveImageAttachment,
  onSubmit,
  onStop,
  onToggleVoice
}: AgentComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragDepth, setDragDepth] = useState(0)
  const dropDisabled = isRunning || isVoiceMode || !imageInputSupported
  const isDropActive = dragDepth > 0 && !dropDisabled
  const hasAttachments = imageAttachments.length > 0

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

  const handleAttachClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    onImageAttachmentsChange(Array.from(event.target.files ?? []))
    event.target.value = ''
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
            {imageAttachments.map((imageAttachment, index) => (
              <div
                key={`${imageAttachment.name}-${index}`}
                className="inline-flex max-w-full items-center gap-2 rounded-2xl border border-foreground/10 bg-muted/50 p-1.5 pr-2 text-xs text-muted-foreground"
              >
                <Image
                  src={imageAttachment.previewUrl}
                  alt="Attached image preview"
                  width={48}
                  height={48}
                  unoptimized
                  className="size-12 rounded-xl object-cover"
                />
                <div className="min-w-0">
                  <div className="max-w-36 truncate font-medium text-foreground">
                    {imageAttachment.name}
                  </div>
                  <div className="truncate">{imageAttachment.mimeType}</div>
                </div>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => onRemoveImageAttachment(index)}
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
          onChange={event => onInputChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
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
                disabled={(input.trim().length === 0 && !hasAttachments) || submitDisabled}
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
