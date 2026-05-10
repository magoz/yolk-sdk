import { Fragment } from 'react'
import type { AgentMessage, ToolCall } from '@yolk/protocol'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { contentPreview, unknownPreview } from './agent-format'

const messageContentPreview = (message: AgentMessage) => {
  switch (message._tag) {
    case 'User':
    case 'ToolResult':
      return contentPreview(message.content)
    case 'Assistant':
      return contentPreview(message.content)
  }
}

const messageCardClass = (message: AgentMessage) => {
  switch (message._tag) {
    case 'User':
      return 'ml-auto max-w-[85%] bg-primary text-primary-foreground'
    case 'Assistant':
      return 'max-w-[85%]'
    case 'ToolResult':
      return 'max-w-[85%] border-dashed bg-muted/40 text-muted-foreground shadow-none'
  }
}

const collectToolNames = (messages: ReadonlyArray<AgentMessage>) => {
  const names = new Map<string, string>()

  for (const message of messages) {
    if (message._tag === 'Assistant') {
      for (const call of message.toolCalls) {
        names.set(call.id, call.name)
      }
    }
  }

  return names
}

function ToolCallCard({ call }: { readonly call: ToolCall }) {
  return (
    <Card
      size="sm"
      className="max-w-[85%] border-amber-500/20 bg-amber-500/5 text-amber-800 shadow-none dark:text-amber-300"
    >
      <CardContent className="space-y-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">tool call</Badge>
          <span className="font-medium text-foreground">{call.name}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{call.id}</span>
        </div>
        <div className="whitespace-pre-wrap break-words leading-5">{unknownPreview(call.params)}</div>
      </CardContent>
    </Card>
  )
}

function ToolResultCard({ name, content }: { readonly name: string; readonly content: string }) {
  return (
    <Card
      size="sm"
      className="max-w-[85%] border-emerald-500/20 bg-emerald-500/5 text-emerald-800 shadow-none dark:text-emerald-300"
    >
      <CardContent className="space-y-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">tool result</Badge>
          <span className="font-medium text-foreground">{name}</span>
        </div>
        <div className="whitespace-pre-wrap break-words leading-5">{content}</div>
      </CardContent>
    </Card>
  )
}

function ReasoningCard({ text }: { readonly text: string }) {
  return (
    <Card size="sm" className="max-w-[85%] border-sky-500/20 bg-sky-500/5 text-sky-900 shadow-none dark:text-sky-200">
      <CardContent className="space-y-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">reasoning</Badge>
          <span className="font-medium text-foreground">Summary</span>
        </div>
        <div className="whitespace-pre-wrap break-words leading-5">{text}</div>
      </CardContent>
    </Card>
  )
}

type AgentConversationProps = {
  readonly messages: ReadonlyArray<AgentMessage>
  readonly voiceUserDraft: string
  readonly assistantDraft: string
  readonly reasoningDraft: string
  readonly error: string | null
  readonly showInlineTools: boolean
  readonly showReasoning: boolean
}

export function AgentConversation({
  messages,
  voiceUserDraft,
  assistantDraft,
  reasoningDraft,
  error,
  showInlineTools,
  showReasoning
}: AgentConversationProps) {
  const toolNames = collectToolNames(messages)

  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-5">
      {messages.length === 0 ? (
        <Card size="sm" className="border-dashed bg-transparent shadow-none">
          <CardHeader>
            <CardTitle>Ask anything</CardTitle>
            <CardDescription>
              Client-owned transcript with a calculator tool. Ask something like “what is 19 *
              23?” to test tool calling.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {messages.map((message, index) => {
        const preview = messageContentPreview(message)
        const reasoning = message._tag === 'Assistant' ? (message.reasoning ?? '') : ''

        return (
          <Fragment key={`${message._tag}-${index}`}>
            {showReasoning && reasoning.length > 0 ? <ReasoningCard text={reasoning} /> : null}

            {preview.length > 0 && message._tag !== 'ToolResult' ? (
              <Card size="sm" className={messageCardClass(message)}>
                <CardContent className="whitespace-pre-wrap leading-6">{preview}</CardContent>
              </Card>
            ) : null}

            {showInlineTools && message._tag === 'Assistant'
              ? message.toolCalls.map(call => <ToolCallCard key={call.id} call={call} />)
              : null}

            {showInlineTools && message._tag === 'ToolResult' ? (
              <ToolResultCard
                name={toolNames.get(message.toolCallId) ?? message.toolCallId}
                content={contentPreview(message.content)}
              />
            ) : null}
          </Fragment>
        )
      })}

      {showReasoning && reasoningDraft.length > 0 ? <ReasoningCard text={reasoningDraft} /> : null}

      {voiceUserDraft.length > 0 ? (
        <Card size="sm" className="ml-auto max-w-[85%] bg-primary/80 text-primary-foreground">
          <CardContent className="whitespace-pre-wrap leading-6">{voiceUserDraft}</CardContent>
        </Card>
      ) : null}

      {assistantDraft.length > 0 ? (
        <Card size="sm" className="max-w-[85%]">
          <CardContent className="whitespace-pre-wrap leading-6">{assistantDraft}</CardContent>
        </Card>
      ) : null}

      {error !== null ? (
        <Card size="sm" className="border-destructive/20 bg-destructive/5 text-destructive">
          <CardContent>{error}</CardContent>
        </Card>
      ) : null}
    </div>
  )
}
