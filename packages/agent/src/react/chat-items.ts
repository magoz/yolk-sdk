import { Array as Arr, Option } from 'effect'
import {
  contentText,
  type QuestionRequest,
  type QuestionResponse,
  type ToolApprovalRequest,
  type ToolResult,
  type Content,
  type ToolCall
} from '@yolk-sdk/agent/protocol'
import type { AgentChatMessage, ChatToolState } from './chat-messages.ts'

export type ToolDuration =
  | { readonly _tag: 'Known'; readonly milliseconds: number }
  | { readonly _tag: 'Unknown' }

type ToolRunNoTiming = {
  readonly duration: { readonly _tag: 'Unknown' }
  readonly startedAtMs?: undefined
  readonly endedAtMs?: undefined
}

type ToolRunStartedTiming = {
  readonly duration: { readonly _tag: 'Unknown' }
  readonly startedAtMs: number
  readonly endedAtMs?: undefined
}

type ToolRunKnownTiming = {
  readonly duration: { readonly _tag: 'Known'; readonly milliseconds: number }
  readonly startedAtMs: number
  readonly endedAtMs: number
}

export type ToolRunTiming = ToolRunNoTiming | ToolRunStartedTiming | ToolRunKnownTiming

type ToolRunTerminalTiming = ToolRunTiming

export type ToolRunState =
  | ({ readonly _tag: 'Running' } & ToolRunStartedTiming)
  | ({ readonly _tag: 'Called' } & ToolRunNoTiming)
  | ({ readonly _tag: 'InputStreaming'; readonly input: string } & ToolRunNoTiming)
  | ({
      readonly _tag: 'ApprovalRequested'
      readonly request?: ToolApprovalRequest
    } & ToolRunNoTiming)
  | ({ readonly _tag: 'Denied'; readonly reason: string } & ToolRunNoTiming)
  | ({ readonly _tag: 'QuestionRequested'; readonly request: QuestionRequest } & ToolRunNoTiming)
  | ({
      readonly _tag: 'QuestionAnswered'
      readonly response: QuestionResponse
      readonly request?: QuestionRequest
    } & ToolRunNoTiming)
  | ({
      readonly _tag: 'QuestionCancelled'
      readonly response: QuestionResponse
      readonly request?: QuestionRequest
    } & ToolRunNoTiming)
  | ({ readonly _tag: 'Completed'; readonly result: ToolResult } & ToolRunTerminalTiming)
  | ({ readonly _tag: 'Errored'; readonly message: string } & ToolRunTerminalTiming)
  | ({
      readonly _tag: 'ProviderCompleted'
      readonly result: ToolResult
    } & ToolRunNoTiming)

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
  | {
      readonly _tag: 'Reasoning'
      readonly id: string
      readonly messageId: string
      readonly text: string
    }
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
      readonly isError?: boolean
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

export const dedupeAgentChatToolRunItems = (
  items: ReadonlyArray<AgentChatItem>
): ReadonlyArray<AgentChatItem> => {
  // Tool call ids are transcript-global; latest wins when live and persisted projections overlap.
  const latestIndexByToolCallId = new Map<string, number>()

  for (const [index, item] of items.entries()) {
    if (item._tag === 'ToolRun') {
      latestIndexByToolCallId.set(item.call.id, index)
    }
  }

  return items.filter(
    (item, index) =>
      item._tag !== 'ToolRun' || latestIndexByToolCallId.get(item.call.id) === index
  )
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

const noTiming = (): ToolRunNoTiming => ({ duration: { _tag: 'Unknown' } })

const startedTiming = (startedAtMs: number): ToolRunStartedTiming => ({
  duration: { _tag: 'Unknown' },
  startedAtMs
})

const unknownTerminalTiming = (startedAtMs?: number): ToolRunNoTiming | ToolRunStartedTiming =>
  startedAtMs === undefined ? noTiming() : startedTiming(startedAtMs)

const knownTiming = (startedAtMs: number, endedAtMs: number): ToolRunTiming => ({
  duration: { _tag: 'Known', milliseconds: Math.max(0, endedAtMs - startedAtMs) },
  startedAtMs,
  endedAtMs
})

const terminalTimingFromState = (
  state: Extract<ChatToolState, { readonly _tag: 'Completed' | 'Errored' }>
): ToolRunTerminalTiming => {
  if (state.startedAtMs !== undefined && state.endedAtMs !== undefined) {
    return knownTiming(state.startedAtMs, state.endedAtMs)
  }

  return unknownTerminalTiming(state.startedAtMs)
}

const toolRunStateFor = (state: ChatToolState): ToolRunState => {
  if (state._tag === 'Running') {
    return { _tag: 'Running', ...startedTiming(state.startedAtMs) }
  }

  if (state._tag === 'Completed') {
    return { _tag: 'Completed', ...terminalTimingFromState(state), result: state.result }
  }

  if (state._tag === 'InputStreaming') {
    return { _tag: 'InputStreaming', ...noTiming(), input: state.input }
  }

  if (state._tag === 'ApprovalRequested') {
    return { _tag: 'ApprovalRequested', ...noTiming(), request: state.request }
  }

  if (state._tag === 'Denied') {
    return { _tag: 'Denied', ...noTiming(), reason: state.reason }
  }

  if (state._tag === 'QuestionRequested') {
    return { _tag: 'QuestionRequested', ...noTiming(), request: state.request }
  }

  if (state._tag === 'QuestionAnswered') {
    return {
      _tag: 'QuestionAnswered',
      ...noTiming(),
      response: state.response,
      request: state.request
    }
  }

  if (state._tag === 'QuestionCancelled') {
    return {
      _tag: 'QuestionCancelled',
      ...noTiming(),
      response: state.response,
      request: state.request
    }
  }

  if (state._tag === 'Errored') {
    return { _tag: 'Errored', ...terminalTimingFromState(state), message: state.message }
  }

  if (state._tag === 'ProviderCompleted') {
    return { _tag: 'ProviderCompleted', ...noTiming(), result: state.result }
  }

  return { _tag: 'Called', ...noTiming() }
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
        content: part.content,
        isError: part.isError
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
  const items = dedupeAgentChatToolRunItems(
    Arr.getSomes(
      Arr.flatMap(messages, message => Arr.map(message.parts, part => itemFromPart(message, part)))
    )
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
