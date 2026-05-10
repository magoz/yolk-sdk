'use client'

import { useCallback, useEffect, useRef } from 'react'
import {
  BotIcon,
  BrainIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  SparklesIcon,
  WrenchIcon
} from 'lucide-react'
import type { Content, ToolCall } from '@yolk/protocol'
import { Badge } from '@/components/ui/badge'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { contentPreview, unknownPreview } from './agent-format'
import type { AgentChatItem } from './agent-chat-items'

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

function ToolCallCard({ call }: { readonly call: ToolCall }) {
  return (
    <div className={chatRowClass}>
      <div className="flex gap-3">
        <UtilityIcon role="tool" />
        <div className="min-w-0 flex-1 rounded-2xl border border-amber-500/20 bg-amber-500/5 px-3.5 py-3 text-amber-900 shadow-xs dark:text-amber-200">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline">tool call</Badge>
            <span className="font-medium text-foreground">{call.name}</span>
            <span className="font-mono text-[11px] text-muted-foreground">{call.id}</span>
          </div>
          <div className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-muted-foreground">
            {unknownPreview(call.params)}
          </div>
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
  role
}: {
  readonly content: Content
  readonly role: 'user' | 'assistant'
}) {
  const preview = contentPreview(content)

  if (preview.length === 0) {
    return null
  }

  if (role === 'user') {
    return (
      <div className={chatRowClass}>
        <div className="flex justify-end">
          <div className="max-w-[78%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-primary/15 bg-primary px-4 py-3 text-sm leading-6 text-primary-foreground shadow-xs">
            {preview}
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
        <div className="whitespace-pre-wrap break-words text-sm leading-7 text-foreground">
          {preview}
        </div>
      </div>
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
  showReasoning
}: {
  readonly item: AgentChatItem
  readonly showInlineTools: boolean
  readonly showReasoning: boolean
}) {
  switch (item._tag) {
    case 'UserMessage':
      return <MessageCard content={item.content} role="user" />
    case 'AssistantMessage':
      return <MessageCard content={item.content} role="assistant" />
    case 'Reasoning':
      return showReasoning ? <ReasoningCard text={item.text} /> : null
    case 'ToolCall':
      return showInlineTools ? <ToolCallCard call={item.call} /> : null
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
}

export function AgentConversation({
  items,
  showInlineTools,
  showReasoning
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
                Try “what is 19 * 23?” to smoke-test tool calling, or start a normal chat.
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
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
