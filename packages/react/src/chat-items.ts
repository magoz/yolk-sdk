import { Array as Arr, Option } from 'effect'
import { contentText, type ToolResult, type Content, type ToolCall } from '@yolk/protocol'
import type { AgentChatMessage, ChatToolState } from './chat-messages.ts'

export type ToolDuration =
  | { readonly _tag: 'Known'; readonly milliseconds: number }
  | { readonly _tag: 'Unknown' }

export type ToolRunState =
  | { readonly _tag: 'Running'; readonly duration: ToolDuration }
  | { readonly _tag: 'Called'; readonly duration: ToolDuration }
  | { readonly _tag: 'InputStreaming'; readonly duration: ToolDuration; readonly input: string }
  | { readonly _tag: 'ApprovalRequested'; readonly duration: ToolDuration }
  | { readonly _tag: 'Denied'; readonly duration: ToolDuration; readonly reason: string }
  | { readonly _tag: 'Completed'; readonly duration: ToolDuration; readonly result: ToolResult }
  | { readonly _tag: 'Errored'; readonly duration: ToolDuration; readonly message: string }
  | { readonly _tag: 'ProviderCompleted'; readonly duration: ToolDuration; readonly result: ToolResult }

export type AgentChatItem =
  | {
      readonly _tag: 'UserMessage'
      readonly id: string
      readonly messageId: string
      readonly content: Content
    }
  | {
      readonly _tag: 'AssistantMessage'
      readonly id: string
      readonly messageId: string
      readonly content: Content
    }
  | { readonly _tag: 'Reasoning'; readonly id: string; readonly messageId: string; readonly text: string }
  | {
      readonly _tag: 'ToolRun'
      readonly id: string
      readonly messageId: string
      readonly call: ToolCall
      readonly state: ToolRunState
    }
  | {
      readonly _tag: 'ToolResult'
      readonly id: string
      readonly messageId: string
      readonly toolCallId: string
      readonly name: string
      readonly content: Content
    }
  | { readonly _tag: 'UserDraft'; readonly id: string; readonly text: string }
  | { readonly _tag: 'AssistantDraft'; readonly id: string; readonly text: string }
  | { readonly _tag: 'AssistantStatus'; readonly id: string; readonly label: string }
  | { readonly _tag: 'Error'; readonly id: string; readonly message: string }

export type BuildAgentChatItemsInput = {
  readonly messages: ReadonlyArray<AgentChatMessage>
  readonly isRunning: boolean
  readonly activeToolLabel: Option.Option<string>
}

const activeStatusLabel = ({
  messages,
  activeToolLabel
}: Pick<BuildAgentChatItemsInput, 'messages' | 'activeToolLabel'>) => {
  if (Option.isSome(activeToolLabel)) {
    return activeToolLabel.value
  }

  const parts = messages.flatMap(message =>
    message.parts.map(part => ({ messageRole: message.role, part }))
  )

  if (
    parts.some(
      ({ messageRole, part }) =>
        part._tag === 'Text' && part.state === 'streaming' && messageRole === 'assistant'
    )
  ) {
    return 'Responding'
  }

  if (parts.some(({ part }) => part._tag === 'Reasoning' && part.state === 'streaming')) {
    return 'Thinking'
  }

  return 'Thinking'
}

const durationFromToolState = (state: ChatToolState): ToolDuration => {
  if (
    state._tag !== 'Completed' ||
    state.startedAtMs === undefined ||
    state.endedAtMs === undefined
  ) {
    return { _tag: 'Unknown' }
  }

  return { _tag: 'Known', milliseconds: Math.max(0, state.endedAtMs - state.startedAtMs) }
}

const toolRunStateFor = (state: ChatToolState): ToolRunState => {
  if (state._tag === 'Running') {
    return { _tag: 'Running', duration: { _tag: 'Unknown' } }
  }

  if (state._tag === 'Completed') {
    return { _tag: 'Completed', duration: durationFromToolState(state), result: state.result }
  }

  if (state._tag === 'InputStreaming') {
    return { _tag: 'InputStreaming', duration: { _tag: 'Unknown' }, input: state.input }
  }

  if (state._tag === 'ApprovalRequested') {
    return { _tag: 'ApprovalRequested', duration: { _tag: 'Unknown' } }
  }

  if (state._tag === 'Denied') {
    return { _tag: 'Denied', duration: { _tag: 'Unknown' }, reason: state.reason }
  }

  if (state._tag === 'Errored') {
    return { _tag: 'Errored', duration: { _tag: 'Unknown' }, message: state.message }
  }

  if (state._tag === 'ProviderCompleted') {
    return { _tag: 'ProviderCompleted', duration: { _tag: 'Unknown' }, result: state.result }
  }

  return { _tag: 'Called', duration: { _tag: 'Unknown' } }
}

const textItemFromPart = (
  message: AgentChatMessage,
  part: Extract<AgentChatMessage['parts'][number], { readonly _tag: 'Text' }>
): Option.Option<AgentChatItem> => {
  if (part.state === 'streaming') {
    switch (message.role) {
      case 'user':
        return Option.some({
          _tag: 'UserDraft',
          id: part.id,
          text: contentText(part.content)
        })
      case 'assistant':
        return Option.some({
          _tag: 'AssistantDraft',
          id: part.id,
          text: contentText(part.content)
        })
      case 'system':
        return Option.none()
    }
  }

  switch (message.role) {
    case 'user':
      return Option.some({
        _tag: 'UserMessage',
        id: part.id,
        messageId: message.id,
        content: part.content
      })
    case 'assistant':
      return Option.some({
        _tag: 'AssistantMessage',
        id: part.id,
        messageId: message.id,
        content: part.content
      })
    case 'system':
      return Option.none()
  }
}

const itemFromPart = (
  message: AgentChatMessage,
  part: AgentChatMessage['parts'][number]
): Option.Option<AgentChatItem> => {
  switch (part._tag) {
    case 'Text':
      return textItemFromPart(message, part)
    case 'Reasoning':
      return Option.some({ _tag: 'Reasoning', id: part.id, messageId: message.id, text: part.text })
    case 'ToolCall':
      return Option.some({
        _tag: 'ToolRun',
        id: part.id,
        messageId: message.id,
        call: part.call,
        state: toolRunStateFor(part.state)
      })
    case 'ToolResult':
      return Option.some({
        _tag: 'ToolResult',
        id: part.id,
        messageId: message.id,
        toolCallId: part.toolCallId,
        name: part.name,
        content: part.content
      })
    case 'Error':
      return Option.some({ _tag: 'Error', id: part.id, message: part.message })
  }
}

export const buildAgentChatItems = ({
  messages,
  isRunning,
  activeToolLabel
}: BuildAgentChatItemsInput): ReadonlyArray<AgentChatItem> => {
  const items = Arr.getSomes(
    Arr.flatMap(messages, message => Arr.map(message.parts, part => itemFromPart(message, part)))
  )

  if (isRunning) {
    return [
      ...items,
      {
        _tag: 'AssistantStatus',
        id: 'assistant-status',
        label: activeStatusLabel({ messages, activeToolLabel })
      }
    ]
  }

  return items
}
