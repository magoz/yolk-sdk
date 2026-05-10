import type { AgentMessage } from '@yolk/protocol'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { contentPreview } from './agent-format'

const messagePreview = (message: AgentMessage) => {
  switch (message._tag) {
    case 'User':
    case 'ToolResult':
      return contentPreview(message.content)
    case 'Assistant': {
      const content = contentPreview(message.content)

      if (content.length > 0) {
        return content
      }

      const toolNames = message.toolCalls.map(call => call.name).join(', ')
      return toolNames.length > 0 ? `Tool call: ${toolNames}` : ''
    }
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

type AgentConversationProps = {
  readonly messages: ReadonlyArray<AgentMessage>
  readonly voiceUserDraft: string
  readonly assistantDraft: string
  readonly error: string | null
}

export function AgentConversation({
  messages,
  voiceUserDraft,
  assistantDraft,
  error
}: AgentConversationProps) {
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
        const preview = messagePreview(message)

        return preview.length > 0 ? (
          <Card size="sm" key={`${message._tag}-${index}`} className={messageCardClass(message)}>
            <CardContent className="whitespace-pre-wrap leading-6">{preview}</CardContent>
          </Card>
        ) : null
      })}

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
