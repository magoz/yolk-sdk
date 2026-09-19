import { Array as Arr, Data, Match, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import {
  contentText,
  type AgentRetry,
  type InputRequest,
  type InputResponse,
  type InteractionRequest,
  type InteractionResponse,
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

export const ToolDurationKnown = Schema.TaggedStruct('Known', {
  milliseconds: Schema.Number
})

export const ToolDurationUnknown = Schema.TaggedStruct('Unknown', {})

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
  | ({ readonly _tag: 'InputRequested'; readonly request: InputRequest } & ToolRunNoTiming)
  | ({
      readonly _tag: 'InteractionRequested'
      readonly request: InteractionRequest
    } & ToolRunNoTiming)
  | ({
      readonly _tag: 'InputSubmitted'
      readonly response: InputResponse
      readonly request?: InputRequest
    } & ToolRunNoTiming)
  | ({
      readonly _tag: 'InputCancelled'
      readonly response: InputResponse
      readonly request?: InputRequest
    } & ToolRunNoTiming)
  | ({
      readonly _tag: 'InteractionSubmitted'
      readonly response: InteractionResponse
      readonly request?: InteractionRequest
    } & ToolRunNoTiming)
  | ({
      readonly _tag: 'InteractionCancelled'
      readonly response: InteractionResponse
      readonly request?: InteractionRequest
    } & ToolRunNoTiming)
  | ({ readonly _tag: 'Accepted'; readonly result: ToolResult } & ToolRunTerminalTiming)
  | ({ readonly _tag: 'Completed'; readonly result: ToolResult } & ToolRunTerminalTiming)
  | ({ readonly _tag: 'Errored'; readonly message: string } & ToolRunTerminalTiming)
  | ({
      readonly _tag: 'ProviderCompleted'
      readonly result: ToolResult
    } & ToolRunNoTiming)

export const ToolRunState = Data.taggedEnum<ToolRunState>()

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
  | { readonly _tag: 'Retry'; readonly id: string; readonly retry: AgentRetry }
  | { readonly _tag: 'AssistantStatus'; readonly id: string; readonly label: string }
  | { readonly _tag: 'Error'; readonly id: string; readonly message: string }

export const AgentChatItem = Data.taggedEnum<AgentChatItem>()

export type BuildAgentChatItemsInput = {
  readonly messages: ReadonlyArray<AgentChatMessage>
  readonly isRunning: boolean
  readonly activeToolLabel: Option.Option<string>
  readonly retryInfo?: AgentRetry | null
}

export const dedupeAgentChatToolRunItems = (
  items: ReadonlyArray<AgentChatItem>
): ReadonlyArray<AgentChatItem> => {
  // Tool call ids are transcript-global; latest wins when live and persisted projections overlap.
  const latestIndexByToolCallId = new Map<string, number>()

  for (const [index, item] of items.entries()) {
    if (Predicate.isTagged(item, 'ToolRun')) {
      latestIndexByToolCallId.set(item.call.id, index)
    }
  }

  return items.filter(
    (item, index) =>
      !Predicate.isTagged(item, 'ToolRun') || latestIndexByToolCallId.get(item.call.id) === index
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
        Predicate.isTagged(part, 'Text') &&
        part.state === 'streaming' &&
        messageRole === 'assistant'
    )
  ) {
    return 'Responding'
  }

  if (
    parts.some(({ part }) => Predicate.isTagged(part, 'Reasoning') && part.state === 'streaming')
  ) {
    return 'Thinking'
  }

  return 'Thinking'
}

const noTiming = (): ToolRunNoTiming => ({ duration: ToolDurationUnknown.make({}) })

const startedTiming = (startedAtMs: number): ToolRunStartedTiming => ({
  duration: ToolDurationUnknown.make({}),
  startedAtMs
})

const unknownTerminalTiming = (startedAtMs?: number): ToolRunNoTiming | ToolRunStartedTiming =>
  startedAtMs === undefined ? noTiming() : startedTiming(startedAtMs)

const knownTiming = (startedAtMs: number, endedAtMs: number): ToolRunTiming => ({
  duration: ToolDurationKnown.make({ milliseconds: Math.max(0, endedAtMs - startedAtMs) }),
  startedAtMs,
  endedAtMs
})

const terminalTimingFromState = (
  state: Extract<ChatToolState, { readonly _tag: 'Completed' | 'Accepted' | 'Errored' }>
): ToolRunTerminalTiming => {
  if (state.startedAtMs !== undefined && state.endedAtMs !== undefined) {
    return knownTiming(state.startedAtMs, state.endedAtMs)
  }

  return unknownTerminalTiming(state.startedAtMs)
}

const toolRunStateFor = (state: ChatToolState): ToolRunState => {
  if (Predicate.isTagged(state, 'Running')) {
    return ToolRunState.Running({ ...startedTiming(state.startedAtMs) })
  }

  if (Predicate.isTagged(state, 'Completed')) {
    return ToolRunState.Completed({ ...terminalTimingFromState(state), result: state.result })
  }

  if (Predicate.isTagged(state, 'Accepted')) {
    return ToolRunState.Accepted({ ...terminalTimingFromState(state), result: state.result })
  }

  if (Predicate.isTagged(state, 'InputStreaming')) {
    return ToolRunState.InputStreaming({ ...noTiming(), input: state.input })
  }

  if (Predicate.isTagged(state, 'ApprovalRequested')) {
    return ToolRunState.ApprovalRequested({ ...noTiming(), request: state.request })
  }

  if (Predicate.isTagged(state, 'Denied')) {
    return ToolRunState.Denied({ ...noTiming(), reason: state.reason })
  }

  if (Predicate.isTagged(state, 'QuestionRequested')) {
    return ToolRunState.QuestionRequested({ ...noTiming(), request: state.request })
  }

  if (Predicate.isTagged(state, 'InputRequested')) {
    return ToolRunState.InputRequested({ ...noTiming(), request: state.request })
  }

  if (Predicate.isTagged(state, 'InputSubmitted')) {
    return ToolRunState.InputSubmitted({
      ...noTiming(),
      response: state.response,
      request: state.request
    })
  }

  if (Predicate.isTagged(state, 'InputCancelled')) {
    return ToolRunState.InputCancelled({
      ...noTiming(),
      response: state.response,
      request: state.request
    })
  }

  if (Predicate.isTagged(state, 'InteractionRequested')) {
    return ToolRunState.InteractionRequested({ ...noTiming(), request: state.request })
  }

  if (Predicate.isTagged(state, 'InteractionSubmitted')) {
    return ToolRunState.InteractionSubmitted({
      ...noTiming(),
      response: state.response,
      request: state.request
    })
  }

  if (Predicate.isTagged(state, 'InteractionCancelled')) {
    return ToolRunState.InteractionCancelled({
      ...noTiming(),
      response: state.response,
      request: state.request
    })
  }

  if (Predicate.isTagged(state, 'QuestionAnswered')) {
    return ToolRunState.QuestionAnswered({
      ...noTiming(),
      response: state.response,
      request: state.request
    })
  }

  if (Predicate.isTagged(state, 'QuestionCancelled')) {
    return ToolRunState.QuestionCancelled({
      ...noTiming(),
      response: state.response,
      request: state.request
    })
  }

  if (Predicate.isTagged(state, 'Errored')) {
    return ToolRunState.Errored({ ...terminalTimingFromState(state), message: state.message })
  }

  if (Predicate.isTagged(state, 'ProviderCompleted')) {
    return ToolRunState.ProviderCompleted({ ...noTiming(), result: state.result })
  }

  return ToolRunState.Called({ ...noTiming() })
}

const textItemFromPart = (
  message: AgentChatMessage,
  part: Extract<AgentChatMessage['parts'][number], { readonly _tag: 'Text' }>
): Option.Option<AgentChatItem> => {
  if (part.state === 'streaming') {
    switch (message.role) {
      case 'user':
        return Option.some(
          AgentChatItem.UserDraft({
            id: part.id,
            text: contentText(part.content)
          })
        )
      case 'assistant':
        return Option.some(
          AgentChatItem.AssistantDraft({
            id: part.id,
            text: contentText(part.content)
          })
        )
      case 'system':
        return Option.none()
    }
  }

  switch (message.role) {
    case 'user':
      return Option.some(
        AgentChatItem.UserMessage({
          id: part.id,
          messageId: message.id,
          content: part.content
        })
      )
    case 'assistant':
      return Option.some(
        AgentChatItem.AssistantMessage({
          id: part.id,
          messageId: message.id,
          content: part.content
        })
      )
    case 'system':
      return Option.none()
  }
}

const itemFromPart = (
  message: AgentChatMessage,
  part: AgentChatMessage['parts'][number]
): Option.Option<AgentChatItem> =>
  Match.value(part).pipe(
    Match.withReturnType<Option.Option<AgentChatItem>>(),
    Match.tag('Text', current => textItemFromPart(message, current)),
    Match.tag('Reasoning', current =>
      Option.some(
        AgentChatItem.Reasoning({
          id: current.id,
          messageId: message.id,
          text: current.text
        })
      )
    ),
    Match.tag('ToolCall', current =>
      Option.some(
        AgentChatItem.ToolRun({
          id: current.id,
          messageId: message.id,
          call: current.call,
          state: toolRunStateFor(current.state)
        })
      )
    ),
    Match.tag('ToolResult', current =>
      Option.some(
        AgentChatItem.ToolResult({
          id: current.id,
          messageId: message.id,
          toolCallId: current.toolCallId,
          name: current.name,
          content: current.content,
          isError: current.isError
        })
      )
    ),
    Match.tag('Error', current =>
      Option.some(AgentChatItem.Error({ id: current.id, message: current.message }))
    ),
    Match.exhaustive
  )

export const buildAgentChatItems = ({
  messages,
  isRunning,
  activeToolLabel,
  retryInfo
}: BuildAgentChatItemsInput): ReadonlyArray<AgentChatItem> => {
  const items = dedupeAgentChatToolRunItems(
    Arr.getSomes(
      Arr.flatMap(messages, message => Arr.map(message.parts, part => itemFromPart(message, part)))
    )
  )

  if (isRunning) {
    if (retryInfo !== undefined && retryInfo !== null) {
      return [...items, AgentChatItem.Retry({ id: 'agent-retry', retry: retryInfo })]
    }

    return [
      ...items,
      AgentChatItem.AssistantStatus({
        id: 'assistant-status',
        label: activeStatusLabel({ messages, activeToolLabel })
      })
    ]
  }

  return items
}
