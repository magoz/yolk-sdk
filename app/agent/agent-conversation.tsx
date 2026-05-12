'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import {
  BotIcon,
  BrainIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
  SparklesIcon,
  Trash2Icon,
  WrenchIcon
} from 'lucide-react'
import { contentParts, type Content, type ContentPart, type ToolCall } from '@yolk/protocol'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { contentPreview, unknownPreview } from './agent-format'
import type { AgentChatItem, ToolDuration, ToolRunState } from '@yolk/react'

const chatRowClass = 'mx-auto w-full max-w-3xl'

function UtilityIcon({ role }: { readonly role: 'assistant' | 'reasoning' | 'tool' | 'error' }) {
  const Icon =
    role === 'reasoning'
      ? BrainIcon
      : role === 'tool'
        ? WrenchIcon
        : role === 'error'
          ? CircleAlertIcon
          : BotIcon

  return (
    <div
      className={cn(
        'mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border shadow-xs',
        role === 'reasoning'
          ? 'border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-200'
          : role === 'tool'
            ? 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300'
            : role === 'error'
              ? 'border-destructive/20 bg-destructive/10 text-destructive'
              : 'border-foreground/10 bg-background text-muted-foreground'
      )}
      aria-hidden
    >
      <Icon className="size-3.5" />
    </div>
  )
}

function UtilityCard({
  role,
  title,
  badge,
  children
}: {
  readonly role: 'reasoning' | 'tool' | 'error'
  readonly title: string
  readonly badge: string
  readonly children: string
}) {
  return (
    <div className={chatRowClass}>
      <div className="flex gap-3">
        <UtilityIcon role={role} />
        <div
          className={cn(
            'min-w-0 flex-1 rounded-2xl border px-3.5 py-3 shadow-xs',
            role === 'reasoning'
              ? 'border-sky-500/20 bg-sky-500/5 text-sky-950 dark:text-sky-100'
              : role === 'tool'
                ? 'border-amber-500/20 bg-amber-500/5 text-amber-900 dark:text-amber-200'
                : 'border-destructive/20 bg-destructive/5 text-destructive'
          )}
        >
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant={role === 'error' ? 'destructive' : 'outline'}>{badge}</Badge>
            <span className="font-medium text-foreground">{title}</span>
          </div>
          <div className="mt-2 whitespace-pre-wrap break-words text-xs leading-5">{children}</div>
        </div>
      </div>
    </div>
  )
}

const formatToolDuration = (duration: ToolDuration) => {
  if (duration._tag === 'Unknown') {
    return 'done'
  }

  if (duration.milliseconds < 1000) {
    return `${duration.milliseconds}ms`
  }

  return `${(duration.milliseconds / 1000).toFixed(1)}s`
}

const toolStateLabel = (state: ToolRunState) => {
  switch (state._tag) {
    case 'Running':
      return 'running'
    case 'Called':
      return state.duration._tag === 'Known' ? formatToolDuration(state.duration) : 'called'
    case 'Completed':
      return formatToolDuration(state.duration)
  }
}

function ToolRunCard({
  id,
  call,
  state
}: {
  readonly id: string
  readonly call: ToolCall
  readonly state: ToolRunState
}) {
  const [expanded, setExpanded] = useState(false)
  const isRunning = state._tag === 'Running'
  const detailsId = `${id}-details`
  const handleToggle = useCallback(() => {
    setExpanded(current => !current)
  }, [])

  return (
    <div className={chatRowClass}>
      <div className="flex gap-3">
        <UtilityIcon role="tool" />
        <div className="min-w-0 flex-1 overflow-hidden rounded-2xl border border-amber-500/20 bg-amber-500/5 text-amber-900 shadow-xs dark:text-amber-200">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={handleToggle}
            className="flex min-h-11 w-full items-center gap-2 px-3.5 py-2.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Badge variant="outline">tool</Badge>
            {isRunning ? (
              <LoaderCircleIcon
                className="size-3 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
                aria-hidden
              />
            ) : null}
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">{call.name}</span>
            <span
              role={isRunning ? 'status' : undefined}
              aria-live={isRunning ? 'polite' : undefined}
              className="shrink-0 tabular-nums text-muted-foreground"
            >
              {toolStateLabel(state)}
            </span>
            <ChevronDownIcon
              className={cn(
                'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out',
                expanded ? 'rotate-180' : 'rotate-0'
              )}
              aria-hidden
            />
          </button>
          {expanded ? (
            <div id={detailsId} className="border-t border-amber-500/15 px-3.5 py-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-foreground">{call.name}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{call.id}</span>
              </div>
              <div className="mt-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
                Input
              </div>
              <div className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-muted-foreground">
                {unknownPreview(call.params)}
              </div>
              {state._tag === 'Completed' ? (
                <>
                  <div className="mt-3 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
                    Output
                  </div>
                  <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-5">
                    {contentPreview(state.result.content)}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ToolResultCard({ name, content }: { readonly name: string; readonly content: string }) {
  return (
    <UtilityCard role="tool" title={name} badge="tool result">
      {content}
    </UtilityCard>
  )
}

function ReasoningCard({ text }: { readonly text: string }) {
  return (
    <UtilityCard role="reasoning" title="Summary" badge="reasoning">
      {text}
    </UtilityCard>
  )
}

function MessageCard({
  content,
  role,
  messageId,
  actionsDisabled,
  onDeleteTurn,
  onRegenerateFrom
}: {
  readonly content: Content
  readonly role: 'user' | 'assistant'
  readonly messageId: string
  readonly actionsDisabled: boolean
  readonly onDeleteTurn: (messageId: string) => void
  readonly onRegenerateFrom: (messageId: string) => void
}) {
  const parts = contentParts(content)
  const hasVisibleContent = parts.some(part => part._tag !== 'Text' || part.text.length > 0)
  const handleDelete = useCallback(() => {
    onDeleteTurn(messageId)
  }, [messageId, onDeleteTurn])
  const handleRegenerate = useCallback(() => {
    onRegenerateFrom(messageId)
  }, [messageId, onRegenerateFrom])

  if (!hasVisibleContent) {
    return null
  }

  if (role === 'user') {
    return (
      <div className={chatRowClass}>
        <div className="flex justify-end">
          <div className="flex max-w-[78%] flex-col items-end gap-2">
            <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-primary/15 bg-primary px-4 py-3 text-sm leading-6 text-primary-foreground shadow-xs">
              <MessageContentParts parts={parts} role="user" />
            </div>
            <MessageActions
              role="user"
              disabled={actionsDisabled}
              onDelete={handleDelete}
              onRegenerate={handleRegenerate}
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={chatRowClass}>
      <div className="min-w-0 px-1 py-1">
        <div className="mb-1.5 flex min-h-11 flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">
          <div className="flex items-center gap-2">
            <BotIcon className="size-3" />
            Assistant
          </div>
          <MessageActions
            role="assistant"
            disabled={actionsDisabled}
            onDelete={handleDelete}
            onRegenerate={handleRegenerate}
          />
        </div>
        <div className="whitespace-pre-wrap break-words text-sm leading-7 text-foreground">
          <MessageContentParts parts={parts} role="assistant" />
        </div>
      </div>
    </div>
  )
}

function MessageActions({
  role,
  disabled,
  onDelete,
  onRegenerate
}: {
  readonly role: 'user' | 'assistant'
  readonly disabled: boolean
  readonly onDelete: () => void
  readonly onRegenerate: () => void
}) {
  return (
    <div className="flex items-center gap-1" aria-label={`${role} message actions`}>
      {role === 'assistant' ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="min-h-11 min-w-11 text-muted-foreground hover:text-foreground"
          disabled={disabled}
          aria-label="Regenerate response"
          onClick={onRegenerate}
        >
          <RotateCcwIcon className="size-3.5" aria-hidden />
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="min-h-11 min-w-11 text-muted-foreground hover:text-destructive"
        disabled={disabled}
        aria-label="Delete turn"
        onClick={onDelete}
      >
        <Trash2Icon className="size-3.5" aria-hidden />
      </Button>
    </div>
  )
}

function MessageContentParts({
  parts,
  role
}: {
  readonly parts: ReadonlyArray<ContentPart>
  readonly role: 'user' | 'assistant'
}) {
  return (
    <div className="space-y-2">
      {parts.map((part, index) => {
        switch (part._tag) {
          case 'Text':
            return part.text.length > 0 ? (
              <div key={`text-${index}`} className="whitespace-pre-wrap break-words">
                {part.text}
              </div>
            ) : null
          case 'Image':
            return (
              <Image
                key={`image-${index}`}
                src={`data:${part.mimeType};base64,${part.data}`}
                alt={role === 'user' ? 'Uploaded image' : 'Generated image'}
                width={640}
                height={360}
                unoptimized
                className="max-h-80 rounded-xl border border-foreground/10 object-contain shadow-xs"
              />
            )
          case 'Audio':
            return (
              <div
                key={`audio-${index}`}
                className="rounded-xl border border-foreground/10 bg-background/20 px-3 py-2 text-xs"
              >
                Audio attachment
              </div>
            )
        }
      })}
    </div>
  )
}

function DraftCard({ text, role }: { readonly text: string; readonly role: 'user' | 'assistant' }) {
  if (role === 'user') {
    return (
      <div className={chatRowClass}>
        <div className="flex justify-end">
          <div className="max-w-[78%] animate-pulse whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-primary/15 bg-primary/80 px-4 py-3 text-sm leading-6 text-primary-foreground shadow-xs">
            {text}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={chatRowClass}>
      <div className="min-w-0 px-1 py-1">
        <div className="mb-1.5 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">
          <BotIcon className="size-3" />
          Assistant
        </div>
        <div className="animate-pulse whitespace-pre-wrap break-words text-sm leading-7 text-foreground">
          {text}
        </div>
      </div>
    </div>
  )
}

function AssistantStatusCard({ label }: { readonly label: string }) {
  return (
    <div className={chatRowClass}>
      <div className="min-w-0 px-1 py-1">
        <div
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-2 rounded-full border border-foreground/10 bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground shadow-xs"
        >
          <LoaderCircleIcon
            className="size-3.5 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          <span>{label}</span>
          <span className="flex w-5 items-center gap-0.5" aria-hidden>
            <span className="size-1 rounded-full bg-current opacity-40 motion-safe:animate-pulse" />
            <span className="size-1 rounded-full bg-current opacity-60 motion-safe:animate-pulse [animation-delay:120ms]" />
            <span className="size-1 rounded-full bg-current opacity-80 motion-safe:animate-pulse [animation-delay:240ms]" />
          </span>
        </div>
      </div>
    </div>
  )
}

function AgentChatItemView({
  item,
  showInlineTools,
  showReasoning,
  actionsDisabled,
  onDeleteTurn,
  onRegenerateFrom
}: {
  readonly item: AgentChatItem
  readonly showInlineTools: boolean
  readonly showReasoning: boolean
  readonly actionsDisabled: boolean
  readonly onDeleteTurn: (messageId: string) => void
  readonly onRegenerateFrom: (messageId: string) => void
}) {
  switch (item._tag) {
    case 'UserMessage':
      return (
        <MessageCard
          content={item.content}
          role="user"
          messageId={item.messageId}
          actionsDisabled={actionsDisabled}
          onDeleteTurn={onDeleteTurn}
          onRegenerateFrom={onRegenerateFrom}
        />
      )
    case 'AssistantMessage':
      return (
        <MessageCard
          content={item.content}
          role="assistant"
          messageId={item.messageId}
          actionsDisabled={actionsDisabled}
          onDeleteTurn={onDeleteTurn}
          onRegenerateFrom={onRegenerateFrom}
        />
      )
    case 'Reasoning':
      return showReasoning ? <ReasoningCard text={item.text} /> : null
    case 'ToolRun':
      return showInlineTools ? (
        <ToolRunCard id={item.id} call={item.call} state={item.state} />
      ) : null
    case 'ToolResult':
      return showInlineTools ? (
        <ToolResultCard name={item.name} content={contentPreview(item.content)} />
      ) : null
    case 'UserDraft':
      return <DraftCard text={item.text} role="user" />
    case 'AssistantDraft':
      return <DraftCard text={item.text} role="assistant" />
    case 'AssistantStatus':
      return <AssistantStatusCard label={item.label} />
    case 'Error':
      return (
        <UtilityCard role="error" title="Request failed" badge="error">
          {item.message}
        </UtilityCard>
      )
  }
}

type AgentConversationProps = {
  readonly items: ReadonlyArray<AgentChatItem>
  readonly showInlineTools: boolean
  readonly showReasoning: boolean
  readonly actionsDisabled: boolean
  readonly onDeleteTurn: (messageId: string) => void
  readonly onRegenerateFrom: (messageId: string) => void
}

export function AgentConversation({
  items,
  showInlineTools,
  showReasoning,
  actionsDisabled,
  onDeleteTurn,
  onRegenerateFrom
}: AgentConversationProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current

    if (viewport === null) {
      return
    }

    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    stickToBottomRef.current = distanceFromBottom < 96
  }, [])

  useEffect(() => {
    if (stickToBottomRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' })
    }
  }, [items])

  return (
    <div
      ref={viewportRef}
      onScroll={handleScroll}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6"
    >
      {items.length === 0 ? (
        <div className="flex min-h-full items-center justify-center py-12">
          <Card
            size="sm"
            className="w-full max-w-lg border-dashed bg-background/60 text-center shadow-none"
          >
            <CardHeader>
              <div className="mx-auto mb-2 grid size-10 place-items-center rounded-full border border-primary/15 bg-primary/10 text-primary">
                <SparklesIcon className="size-5" />
              </div>
              <CardTitle>Ask anything</CardTitle>
              <CardDescription>
                Try “summarize https://example.com” or “search latest AI news”.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      ) : null}

      <div className="space-y-5">
        {items.map(item => (
          <AgentChatItemView
            key={item.id}
            item={item}
            showInlineTools={showInlineTools}
            showReasoning={showReasoning}
            actionsDisabled={actionsDisabled}
            onDeleteTurn={onDeleteTurn}
            onRegenerateFrom={onRegenerateFrom}
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
