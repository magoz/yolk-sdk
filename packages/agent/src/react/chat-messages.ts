import { Array as Arr, Data, Match, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import type { AgentToolRun } from '@yolk-sdk/agent/client'
import {
  AssistantAgentMessage,
  AssistantReasoningPart,
  AssistantTextPart,
  HostToolCallPart,
  ProviderToolCallPart,
  ProviderToolResultPart,
  type QuestionRequest,
  type QuestionResponse,
  type ToolApprovalRequest,
  ToolResult,
  ToolResultMessage,
  toolResultMessageFromResult,
  ToolCall,
  UserMessage,
  appendTextToContent,
  contentParts,
  formatQuestionResponseContent,
  isContentEmpty,
  questionResponseStructuredContent,
  type AgentEvent,
  type AgentMessage,
  type AssistantPart,
  type Content,
  type MessageAnnotations,
  type MessageAuthor,
  type MessageEnvelope
} from '@yolk-sdk/agent/protocol'

export type ChatPartState = 'streaming' | 'done'

export type ChatToolState =
  | { readonly _tag: 'Called' }
  | { readonly _tag: 'InputStreaming'; readonly input: string }
  | { readonly _tag: 'ApprovalRequested'; readonly request?: ToolApprovalRequest }
  | { readonly _tag: 'Denied'; readonly reason: string }
  | { readonly _tag: 'QuestionRequested'; readonly request: QuestionRequest }
  | {
      readonly _tag: 'QuestionAnswered'
      readonly response: QuestionResponse
      readonly request?: QuestionRequest
    }
  | {
      readonly _tag: 'QuestionCancelled'
      readonly response: QuestionResponse
      readonly request?: QuestionRequest
    }
  | { readonly _tag: 'Running'; readonly startedAtMs: number }
  | {
      readonly _tag: 'Completed'
      readonly result: ToolResult
      readonly startedAtMs?: number
      readonly endedAtMs?: number
    }
  | {
      readonly _tag: 'Accepted'
      readonly result: ToolResult
      readonly resultEnvelope?: MessageEnvelope
      readonly startedAtMs?: number
      readonly endedAtMs?: number
    }
  | {
      readonly _tag: 'Errored'
      readonly message: string
      readonly startedAtMs?: number
      readonly endedAtMs?: number
    }
  | { readonly _tag: 'ProviderCompleted'; readonly result: ToolResult }

export const ChatToolState = Data.taggedEnum<ChatToolState>()

export type AgentChatPart =
  | {
      readonly _tag: 'Text'
      readonly id: string
      readonly content: Content
      readonly state: ChatPartState
    }
  | {
      readonly _tag: 'Reasoning'
      readonly id: string
      readonly text: string
      readonly state: ChatPartState
    }
  | {
      readonly _tag: 'ToolCall'
      readonly id: string
      readonly call: ToolCall
      readonly state: ChatToolState
    }
  | {
      readonly _tag: 'ToolResult'
      readonly id: string
      readonly toolCallId: string
      readonly name: string
      readonly content: Content
      readonly isError?: boolean
      readonly acceptance?: ToolResult['acceptance']
      readonly structuredContent?: unknown
    }
  | { readonly _tag: 'Error'; readonly id: string; readonly message: string }

export const AgentChatPart = Data.taggedEnum<AgentChatPart>()

export type AgentChatMessage = {
  readonly id: string
  readonly turnId: string
  readonly sequence: number
  readonly role: 'user' | 'assistant' | 'system'
  readonly createdAtMs?: number
  readonly author?: MessageAuthor
  readonly annotations?: MessageAnnotations
  readonly parts: ReadonlyArray<AgentChatPart>
}

export type DeleteChatTurnResult =
  | { readonly _tag: 'NotFound' }
  | {
      readonly _tag: 'Deleted'
      readonly turnStartMessageId: string
      readonly deletedMessageIds: ReadonlyArray<string>
      readonly messages: ReadonlyArray<AgentChatMessage>
    }

export const DeleteChatTurnResult = Data.taggedEnum<DeleteChatTurnResult>()

export type EditChatUserMessageResult =
  | { readonly _tag: 'NotFound' }
  | { readonly _tag: 'NotUserMessage' }
  | {
      readonly _tag: 'Edited'
      readonly messageId: string
      readonly messages: ReadonlyArray<AgentChatMessage>
    }

export const EditChatUserMessageResult = Data.taggedEnum<EditChatUserMessageResult>()

export type RegenerateChatMessagesResult =
  | { readonly _tag: 'NotFound' }
  | {
      readonly _tag: 'Regenerated'
      readonly messages: ReadonlyArray<AgentChatMessage>
    }

export const RegenerateChatMessagesResult = Data.taggedEnum<RegenerateChatMessagesResult>()

export type ApplyAgentEventToChatMessagesOptions = {
  readonly nowMs?: number
}

const ChatToolStateCalled = Schema.TaggedStruct('Called', {})

const ChatToolStateRunning = Schema.TaggedStruct('Running', {
  startedAtMs: Schema.Number
})

const ChatToolStateInputStreaming = Schema.TaggedStruct('InputStreaming', {
  input: Schema.String
})

const ChatToolStateDenied = Schema.TaggedStruct('Denied', {
  reason: Schema.String
})

const ChatToolStateErroredEnded = Schema.TaggedStruct('Errored', {
  message: Schema.String,
  endedAtMs: Schema.Number
})

const AgentChatPartReasoning = Schema.TaggedStruct('Reasoning', {
  id: Schema.String,
  text: Schema.String,
  state: Schema.Literals(['streaming', 'done'])
})

const AgentChatPartStreamingText = Schema.TaggedStruct('Text', {
  id: Schema.String,
  content: Schema.String,
  state: Schema.Literal('streaming')
})

const AgentChatPartError = Schema.TaggedStruct('Error', {
  id: Schema.String,
  message: Schema.String
})

const ChatMessageOpNotFound = Schema.TaggedStruct('NotFound', {})

const ChatMessageOpNotUserMessage = Schema.TaggedStruct('NotUserMessage', {})

const messageId = (sequence: number, role: AgentChatMessage['role']) =>
  `message-${sequence}-${role}`

const turnId = (sequence: number) => `turn-${sequence}`

const lastTurnId = (messages: ReadonlyArray<AgentChatMessage>) => messages.at(-1)?.turnId

const nextMessageSequence = (messages: ReadonlyArray<AgentChatMessage>) =>
  messages.reduce((max, message) => Math.max(max, message.sequence), -1) + 1

type ChatMessageEnvelopeFields = {
  createdAtMs?: MessageEnvelope['createdAtMs']
  author?: MessageEnvelope['author']
  annotations?: MessageEnvelope['annotations']
}

const chatMessageEnvelope = (message: MessageEnvelope) => {
  const fields: ChatMessageEnvelopeFields = {}

  if (message.createdAtMs !== undefined) {
    fields.createdAtMs = message.createdAtMs
  }

  if (message.author !== undefined) {
    fields.author = message.author
  }

  if (message.annotations !== undefined) {
    fields.annotations = message.annotations
  }

  return fields
}

const userChatMessage = (message: UserMessage, sequence: number): AgentChatMessage => ({
  id: messageId(sequence, 'user'),
  turnId: turnId(sequence),
  sequence,
  role: 'user',
  ...chatMessageEnvelope(message),
  parts: [
    AgentChatPart.Text({
      id: `message-${sequence}-user-text`,
      content: message.content,
      state: 'done'
    })
  ]
})

export type BuildAgentChatMessagesInput = {
  readonly messages: ReadonlyArray<AgentMessage>
  readonly userDraft: string
  readonly assistantDraft: string
  readonly reasoningDraft: string
  readonly toolRuns: ReadonlyArray<AgentToolRun>
  readonly error: string | null
}

const toolRunNameEntry = (run: AgentToolRun): ReadonlyArray<readonly [string, string]> =>
  Match.value(run).pipe(
    Match.withReturnType<ReadonlyArray<readonly [string, string]>>(),
    Match.tag('InputStreaming', current =>
      current.name === undefined ? [] : [[current.id, current.name]]
    ),
    Match.tag('Denied', () => []),
    Match.tag('QuestionAnswered', 'QuestionCancelled', current =>
      current.request === undefined ? [] : [[current.request.call.id, current.request.call.name]]
    ),
    Match.tag('QuestionRequested', current => [
      [current.request.call.id, current.request.call.name]
    ]),
    Match.tag(
      'InputReady',
      'ApprovalRequested',
      'Executing',
      'Accepted',
      'Completed',
      'Errored',
      'ProviderCompleted',
      current => [[current.call.id, current.call.name]]
    ),
    Match.exhaustive
  )

const assistantToolNameEntries = (
  message: AgentMessage
): ReadonlyArray<readonly [string, string]> =>
  Predicate.isTagged(message, 'Assistant')
    ? message.parts.flatMap(part =>
        Predicate.isTagged(part, 'HostToolCall') || Predicate.isTagged(part, 'ProviderToolCall')
          ? [[part.call.id, part.call.name]]
          : []
      )
    : []

const collectToolNames = (
  messages: ReadonlyArray<AgentMessage>,
  toolRuns: ReadonlyArray<AgentToolRun>
): ReadonlyMap<string, string> =>
  new Map([...toolRuns.flatMap(toolRunNameEntry), ...messages.flatMap(assistantToolNameEntries)])

// Schema.Class.make retains excess own properties; select only result payload fields.
type ToolResultFromMessageFields = {
  toolCallId: ToolResultMessage['toolCallId']
  content: ToolResultMessage['content']
  isError?: ToolResultMessage['isError']
  structuredContent?: ToolResultMessage['structuredContent']
  acceptance?: ToolResultMessage['acceptance']
}

const toolResultFromMessage = (message: ToolResultMessage): ToolResult =>
  ToolResult.make(
    (() => {
      const fields: ToolResultFromMessageFields = {
        toolCallId: message.toolCallId,
        content: message.content
      }

      if (message.isError !== undefined) {
        fields.isError = message.isError
      }

      if (message.structuredContent !== undefined) {
        fields.structuredContent = message.structuredContent
      }

      if (message.acceptance !== undefined) {
        fields.acceptance = message.acceptance
      }

      return fields
    })()
  )

const toolResultEntry = (
  message: AgentMessage
): ReadonlyArray<readonly [string, ToolResultMessage]> =>
  Predicate.isTagged(message, 'ToolResult') ? [[message.toolCallId, message]] : []

const collectToolResultsById = (messages: ReadonlyArray<AgentMessage>) =>
  new Map(messages.flatMap(toolResultEntry))

const collectToolCallIds = (messages: ReadonlyArray<AgentMessage>): ReadonlySet<string> =>
  new Set(
    messages.flatMap(message =>
      Predicate.isTagged(message, 'Assistant')
        ? message.parts.flatMap(part =>
            Predicate.isTagged(part, 'HostToolCall') || Predicate.isTagged(part, 'ProviderToolCall')
              ? [part.call.id]
              : []
          )
        : []
    )
  )

const toolRunEntry = (run: AgentToolRun): readonly [string, AgentToolRun] =>
  Match.value(run).pipe(
    Match.tag('InputStreaming', current => [current.id, current] as const),
    Match.tag('Denied', current => [current.toolCallId, current] as const),
    Match.tag('QuestionRequested', current => [current.request.toolCallId, current] as const),
    Match.tag(
      'QuestionAnswered',
      'QuestionCancelled',
      current => [current.response.toolCallId, current] as const
    ),
    Match.tag(
      'InputReady',
      'ApprovalRequested',
      'Executing',
      'Accepted',
      'Completed',
      'Errored',
      'ProviderCompleted',
      current => [current.call.id, current] as const
    ),
    Match.exhaustive
  )

const collectToolRunsById = (
  runs: ReadonlyArray<AgentToolRun>
): ReadonlyMap<string, AgentToolRun> => new Map(runs.map(toolRunEntry))

const questionRequestFromToolState = (state: ChatToolState): QuestionRequest | undefined =>
  Match.value(state).pipe(
    Match.tag('QuestionRequested', current => current.request),
    Match.tag('QuestionAnswered', 'QuestionCancelled', current => current.request),
    Match.tag(
      'Called',
      'InputStreaming',
      'ApprovalRequested',
      'Denied',
      'Running',
      'Accepted',
      'Completed',
      'Errored',
      'ProviderCompleted',
      () => undefined
    ),
    Match.exhaustive
  )

type QuestionTerminalState = Extract<
  ChatToolState,
  { readonly _tag: 'QuestionAnswered' | 'QuestionCancelled' }
>

const preserveQuestionRequest = (
  request: QuestionRequest | undefined,
  state: QuestionTerminalState
): QuestionTerminalState =>
  state.request !== undefined || request === undefined ? state : { ...state, request }

const toolStateFor = (
  run: AgentToolRun | undefined,
  message: ToolResultMessage | undefined
): ChatToolState => {
  const result = message === undefined ? undefined : toolResultFromMessage(message)

  // Persisted acknowledgements outrank stale transient runs after hydration.
  if (message?.acceptance !== undefined && result !== undefined) {
    return ChatToolState.Accepted({ result, resultEnvelope: chatMessageEnvelope(message) })
  }

  if (Predicate.isTagged(run, 'Executing')) {
    return ChatToolStateRunning.make({ startedAtMs: run.startedAtMs })
  }

  if (Predicate.isTagged(run, 'InputStreaming')) {
    return ChatToolStateInputStreaming.make({ input: run.input })
  }

  if (Predicate.isTagged(run, 'ApprovalRequested')) {
    return ChatToolState.ApprovalRequested({ request: run.request })
  }

  if (Predicate.isTagged(run, 'Denied')) {
    return ChatToolStateDenied.make({ reason: run.reason })
  }

  if (Predicate.isTagged(run, 'QuestionRequested')) {
    return ChatToolState.QuestionRequested({ request: run.request })
  }

  if (Predicate.isTagged(run, 'QuestionAnswered')) {
    return preserveQuestionRequest(
      run.request,
      ChatToolState.QuestionAnswered({ response: run.response })
    )
  }

  if (Predicate.isTagged(run, 'QuestionCancelled')) {
    return preserveQuestionRequest(
      run.request,
      ChatToolState.QuestionCancelled({ response: run.response })
    )
  }

  if (Predicate.isTagged(run, 'Completed')) {
    return ChatToolState.Completed({
      result: run.result,
      startedAtMs: run.startedAtMs,
      endedAtMs: run.endedAtMs
    })
  }

  if (Predicate.isTagged(run, 'Accepted')) {
    return ChatToolState.Accepted({
      result: run.result,
      startedAtMs: run.startedAtMs,
      endedAtMs: run.endedAtMs
    })
  }

  if (Predicate.isTagged(run, 'Errored')) {
    return ChatToolStateErroredEnded.make({ message: run.message, endedAtMs: run.endedAtMs })
  }

  if (Predicate.isTagged(run, 'ProviderCompleted')) {
    return ChatToolState.ProviderCompleted({ result: run.result })
  }

  if (result !== undefined) {
    return result.acceptance === undefined
      ? ChatToolState.Completed({ result })
      : ChatToolState.Accepted({ result })
  }

  return ChatToolStateCalled.make({})
}

const assistantPartsFromMessage = ({
  message,
  messageIndex,
  toolResultsById,
  toolRunsById
}: {
  readonly message: Extract<AgentMessage, { readonly _tag: 'Assistant' }>
  readonly messageIndex: number
  readonly toolResultsById: ReadonlyMap<string, ToolResultMessage>
  readonly toolRunsById: ReadonlyMap<string, AgentToolRun>
}): ReadonlyArray<AgentChatPart> => {
  return message.parts.flatMap((part, partIndex): ReadonlyArray<AgentChatPart> =>
    Match.value(part).pipe(
      Match.withReturnType<ReadonlyArray<AgentChatPart>>(),
      Match.tag('Reasoning', current =>
        current.text.length > 0
          ? [
              AgentChatPartReasoning.make({
                id: `message-${messageIndex}-reasoning-${partIndex}`,
                text: current.text,
                state: 'done'
              })
            ]
          : []
      ),
      Match.tag('Text', current => [
        AgentChatPart.Text({
          id: `message-${messageIndex}-assistant-text-${partIndex}`,
          content: current.content,
          state: 'done'
        })
      ]),
      Match.tag('HostToolCall', 'ProviderToolCall', current => [
        AgentChatPart.ToolCall({
          id: `message-${messageIndex}-tool-call-${current.call.id}`,
          call: current.call,
          state: toolStateFor(
            toolRunsById.get(current.call.id),
            toolResultsById.get(current.call.id)
          )
        })
      ]),
      Match.tag('ProviderToolResult', current => [
        {
          ...toolResultMessageFromResult(current.result),
          id: `message-${messageIndex}-provider-tool-result-${current.toolCallId}`,
          toolCallId: current.toolCallId,
          name: current.toolCallId
        }
      ]),
      Match.exhaustive
    )
  )
}

const assistantChatMessage = (
  message: AssistantAgentMessage,
  sequence: number,
  currentTurnId: string,
  parts: ReadonlyArray<AgentChatPart> = assistantPartsFromMessage({
    message,
    messageIndex: sequence,
    toolResultsById: new Map(),
    toolRunsById: new Map()
  })
): AgentChatMessage => ({
  id: messageId(sequence, 'assistant'),
  turnId: currentTurnId,
  sequence,
  role: 'assistant',
  ...chatMessageEnvelope(message),
  parts
})

const hasStreamingPart = (message: AgentChatMessage) =>
  message.parts.some(
    part =>
      (Predicate.isTagged(part, 'Text') || Predicate.isTagged(part, 'Reasoning')) &&
      part.state === 'streaming'
  )

const hasStreamingTextPart = (message: AgentChatMessage) =>
  message.parts.some(part => Predicate.isTagged(part, 'Text') && part.state === 'streaming')

const hasToolCall = (message: AgentChatMessage, callId: string) =>
  message.parts.some(part => Predicate.isTagged(part, 'ToolCall') && part.call.id === callId)

const isOpenToolState = (state: ChatToolState) =>
  Predicate.isTagged(state, 'Called') ||
  Predicate.isTagged(state, 'InputStreaming') ||
  Predicate.isTagged(state, 'ApprovalRequested') ||
  Predicate.isTagged(state, 'QuestionRequested') ||
  Predicate.isTagged(state, 'Running')

const hasOpenToolCall = (message: AgentChatMessage) =>
  message.parts.some(part => Predicate.isTagged(part, 'ToolCall') && isOpenToolState(part.state))

const findLastMessageIndex = (
  messages: ReadonlyArray<AgentChatMessage>,
  predicate: (message: AgentChatMessage) => boolean
) => messages.reduce((lastIndex, message, index) => (predicate(message) ? index : lastIndex), -1)

const findMessageIndex = (messages: ReadonlyArray<AgentChatMessage>, messageId: string) =>
  messages.findIndex(message => message.id === messageId)

export const deleteChatTurn = (
  messages: ReadonlyArray<AgentChatMessage>,
  messageId: string
): DeleteChatTurnResult => {
  const targetIndex = findMessageIndex(messages, messageId)

  if (targetIndex === -1) {
    return ChatMessageOpNotFound.make({})
  }

  const target = messages[targetIndex]

  if (target === undefined) {
    return ChatMessageOpNotFound.make({})
  }

  const deletedMessages = messages.filter(message => message.turnId === target.turnId)
  const turnStartMessage = deletedMessages[0]

  return DeleteChatTurnResult.Deleted({
    turnStartMessageId: turnStartMessage?.id ?? target.id,
    deletedMessageIds: deletedMessages.map(message => message.id),
    messages: messages.filter(message => message.turnId !== target.turnId)
  })
}

export const regenerateChatMessagesFrom = (
  messages: ReadonlyArray<AgentChatMessage>,
  messageId: string
): RegenerateChatMessagesResult => {
  const targetIndex = findMessageIndex(messages, messageId)

  if (targetIndex === -1) {
    return ChatMessageOpNotFound.make({})
  }

  const target = messages[targetIndex]

  if (target === undefined) {
    return ChatMessageOpNotFound.make({})
  }

  return RegenerateChatMessagesResult.Regenerated({
    messages: messages.slice(0, target.role === 'user' ? targetIndex + 1 : targetIndex)
  })
}

export const editChatUserMessage = (
  messages: ReadonlyArray<AgentChatMessage>,
  messageId: string,
  content: Content
): EditChatUserMessageResult => {
  const targetIndex = findMessageIndex(messages, messageId)

  if (targetIndex === -1) {
    return ChatMessageOpNotFound.make({})
  }

  const target = messages[targetIndex]

  if (target === undefined) {
    return ChatMessageOpNotFound.make({})
  }

  if (target.role !== 'user') {
    return ChatMessageOpNotUserMessage.make({})
  }

  return EditChatUserMessageResult.Edited({
    messageId: target.id,
    messages: [
      ...messages.slice(0, targetIndex),
      {
        ...target,
        parts: [
          AgentChatPart.Text({
            id: `message-${target.sequence}-user-text`,
            content,
            state: 'done'
          })
        ]
      }
    ]
  })
}

const lastAssistantIndex = (messages: ReadonlyArray<AgentChatMessage>) => {
  const index = findLastMessageIndex(messages, message => message.role === 'assistant')

  return index === -1 ? Option.none<number>() : Option.some(index)
}

const targetAssistantIndex = (messages: ReadonlyArray<AgentChatMessage>) =>
  Option.filter(lastAssistantIndex(messages), index => hasStreamingPart(messages[index]))

const appendAssistantPart = (
  messages: ReadonlyArray<AgentChatMessage>,
  part: AgentChatPart
): ReadonlyArray<AgentChatMessage> =>
  Option.match(targetAssistantIndex(messages), {
    onNone: () => {
      const sequence = nextMessageSequence(messages)
      const currentTurnId = lastTurnId(messages) ?? turnId(sequence)

      return [
        ...messages,
        {
          id: messageId(sequence, 'assistant'),
          turnId: currentTurnId,
          sequence,
          role: 'assistant',
          parts: [part]
        }
      ]
    },
    onSome: index =>
      messages.map((message, messageIndex) =>
        messageIndex === index ? { ...message, parts: [...message.parts, part] } : message
      )
  })

const appendAssistantTextDelta = (
  messages: ReadonlyArray<AgentChatMessage>,
  input: { readonly delta: string; readonly textSoFar?: string }
): ReadonlyArray<AgentChatMessage> => {
  const index = targetAssistantIndex(messages)
  const content = input.textSoFar ?? input.delta

  if (Option.isNone(index)) {
    const sequence = nextMessageSequence(messages)

    return appendAssistantPart(
      messages,
      AgentChatPartStreamingText.make({
        id: `message-${sequence}-assistant-text`,
        content,
        state: 'streaming'
      })
    )
  }

  return messages.map((message, messageIndex) =>
    messageIndex === index.value
      ? {
          ...message,
          parts: hasStreamingTextPart(message)
            ? message.parts.map(part =>
                Predicate.isTagged(part, 'Text') && part.state === 'streaming'
                  ? {
                      ...part,
                      content: input.textSoFar ?? appendTextToContent(part.content, input.delta)
                    }
                  : part
              )
            : [
                ...message.parts,
                AgentChatPartStreamingText.make({
                  id: `message-${message.sequence}-assistant-text`,
                  content,
                  state: 'streaming'
                })
              ]
        }
      : message
  )
}

const appendAssistantReasoningDelta = (
  messages: ReadonlyArray<AgentChatMessage>,
  input: { readonly delta: string; readonly reasoningSoFar?: string }
): ReadonlyArray<AgentChatMessage> => {
  const index = targetAssistantIndex(messages)
  const text = input.reasoningSoFar ?? input.delta

  if (Option.isNone(index)) {
    const sequence = nextMessageSequence(messages)

    return appendAssistantPart(
      messages,
      AgentChatPartReasoning.make({
        id: `message-${sequence}-reasoning`,
        text,
        state: 'streaming'
      })
    )
  }

  return messages.map((message, messageIndex) =>
    messageIndex === index.value
      ? {
          ...message,
          parts: message.parts.some(
            part => Predicate.isTagged(part, 'Reasoning') && part.state === 'streaming'
          )
            ? message.parts.map(part =>
                Predicate.isTagged(part, 'Reasoning') && part.state === 'streaming'
                  ? { ...part, text: input.reasoningSoFar ?? `${part.text}${input.delta}` }
                  : part
              )
            : [
                ...message.parts,
                AgentChatPartReasoning.make({
                  id: `message-${message.sequence}-reasoning`,
                  text,
                  state: 'streaming'
                })
              ]
        }
      : message
  )
}

const mergeToolState = (existing: ChatToolState, next: ChatToolState): ChatToolState => {
  if (Predicate.isTagged(next, 'Errored')) {
    return {
      ...next,
      startedAtMs:
        next.startedAtMs ??
        (Predicate.isTagged(existing, 'Running') ||
        Predicate.isTagged(existing, 'Completed') ||
        Predicate.isTagged(existing, 'Accepted') ||
        Predicate.isTagged(existing, 'Errored')
          ? existing.startedAtMs
          : undefined),
      endedAtMs:
        next.endedAtMs ?? (Predicate.isTagged(existing, 'Errored') ? existing.endedAtMs : undefined)
    }
  }

  if (
    Predicate.isTagged(next, 'QuestionAnswered') ||
    Predicate.isTagged(next, 'QuestionCancelled')
  ) {
    return preserveQuestionRequest(questionRequestFromToolState(existing), next)
  }

  if (Predicate.isTagged(next, 'Denied') || Predicate.isTagged(next, 'ProviderCompleted')) {
    return next
  }

  if (Predicate.isTagged(next, 'Completed') || Predicate.isTagged(next, 'Accepted')) {
    const snapshot = { ...next }

    const merged =
      Predicate.isTagged(next, 'Accepted') &&
      Predicate.isTagged(existing, 'Accepted') &&
      next.resultEnvelope === undefined &&
      existing.resultEnvelope !== undefined
        ? { ...snapshot, resultEnvelope: existing.resultEnvelope }
        : snapshot

    return {
      ...merged,
      startedAtMs:
        next.startedAtMs ??
        (Predicate.isTagged(existing, 'Running') ||
        Predicate.isTagged(existing, 'Completed') ||
        Predicate.isTagged(existing, 'Accepted')
          ? existing.startedAtMs
          : undefined),
      endedAtMs:
        next.endedAtMs ??
        (Predicate.isTagged(existing, 'Completed') || Predicate.isTagged(existing, 'Accepted')
          ? existing.endedAtMs
          : undefined)
    }
  }

  if (
    Predicate.isTagged(next, 'Running') &&
    (Predicate.isTagged(existing, 'Completed') || Predicate.isTagged(existing, 'Accepted'))
  ) {
    return existing
  }

  return next
}

const appendToolCallPart = (
  messages: ReadonlyArray<AgentChatMessage>,
  call: ToolCall,
  state: ChatToolState
): ReadonlyArray<AgentChatMessage> => {
  const index = Option.filter(lastAssistantIndex(messages), assistantIndex => {
    const message = messages[assistantIndex]

    return hasStreamingPart(message) || hasOpenToolCall(message)
  })

  return Option.match(index, {
    onNone: () => {
      const sequence = nextMessageSequence(messages)
      const currentTurnId = lastTurnId(messages) ?? turnId(sequence)

      return [
        ...messages,
        {
          id: messageId(sequence, 'assistant'),
          turnId: currentTurnId,
          sequence,
          role: 'assistant',
          parts: [AgentChatPart.ToolCall({ id: `tool-call-${call.id}`, call, state })]
        }
      ]
    },
    onSome: assistantIndex =>
      messages.map((message, messageIndex) =>
        messageIndex === assistantIndex
          ? {
              ...message,
              parts: [
                ...message.parts,
                AgentChatPart.ToolCall({ id: `tool-call-${call.id}`, call, state })
              ]
            }
          : message
      )
  })
}

const upsertToolCallPart = (
  messages: ReadonlyArray<AgentChatMessage>,
  call: ToolCall,
  state: ChatToolState
): ReadonlyArray<AgentChatMessage> => {
  const existingIndex = findLastMessageIndex(messages, message => hasToolCall(message, call.id))

  if (existingIndex !== -1) {
    return messages.map((message, messageIndex) =>
      messageIndex === existingIndex
        ? {
            ...message,
            parts: message.parts.map(part =>
              Predicate.isTagged(part, 'ToolCall') && part.call.id === call.id
                ? Predicate.isTagged(part.state, 'Accepted') && isOpenToolState(state)
                  ? part
                  : { ...part, call, state: mergeToolState(part.state, state) }
                : part
            )
          }
        : message
    )
  }

  return appendToolCallPart(messages, call, state)
}

const inputStreamingToolCall = (id: string, name: string | undefined) =>
  ToolCall.make({ id, name: name ?? id, params: {} })

const appendToolInputDelta = (
  messages: ReadonlyArray<AgentChatMessage>,
  id: string,
  delta: string
): ReadonlyArray<AgentChatMessage> =>
  messages.map(message => ({
    ...message,
    parts: message.parts.map(part =>
      Predicate.isTagged(part, 'ToolCall') &&
      part.call.id === id &&
      Predicate.isTagged(part.state, 'InputStreaming')
        ? { ...part, state: { ...part.state, input: `${part.state.input}${delta}` } }
        : part
    )
  }))

const finalizeAssistantParts = (
  parts: ReadonlyArray<AgentChatPart>
): ReadonlyArray<AgentChatPart> =>
  parts.map(part =>
    Match.value(part).pipe(
      Match.withReturnType<AgentChatPart>(),
      Match.tag('Text', 'Reasoning', current => ({
        ...current,
        state: 'done' satisfies ChatPartState
      })),
      Match.tag('Error', 'ToolCall', 'ToolResult', current => current),
      Match.exhaustive
    )
  )

const toolStateEntry = (part: AgentChatPart): ReadonlyArray<readonly [string, ChatToolState]> =>
  Predicate.isTagged(part, 'ToolCall') ? [[part.call.id, part.state]] : []

const toolStateByCallId = (parts: ReadonlyArray<AgentChatPart>) =>
  new Map(parts.flatMap(toolStateEntry))

const partsFromAssistantMessage = (
  message: AssistantAgentMessage,
  messageIndex: number,
  existingParts: ReadonlyArray<AgentChatPart>,
  acceptedCallIds: ReadonlySet<string>
) => {
  const states = toolStateByCallId(existingParts)

  const parts = assistantPartsFromMessage({
    message,
    messageIndex,
    toolResultsById: new Map(),
    toolRunsById: new Map()
  }).flatMap((part): ReadonlyArray<AgentChatPart> => {
    if (!Predicate.isTagged(part, 'ToolCall')) return [part]

    if (acceptedCallIds.has(part.call.id)) {
      const accepted = existingParts.find(
        existing =>
          Predicate.isTagged(existing, 'ToolCall') &&
          existing.call.id === part.call.id &&
          Predicate.isTagged(existing.state, 'Accepted')
      )

      // An accepted call belongs to its original message, never a replay's new target.
      return accepted === undefined ? [] : [accepted]
    }

    return [{ ...part, state: states.get(part.call.id) ?? part.state }]
  })

  const preservesAcknowledgement =
    existingParts.some(
      part => Predicate.isTagged(part, 'ToolCall') && Predicate.isTagged(part.state, 'Accepted')
    ) ||
    message.parts.some(
      part =>
        (Predicate.isTagged(part, 'HostToolCall') ||
          Predicate.isTagged(part, 'ProviderToolCall')) &&
        acceptedCallIds.has(part.call.id)
    )

  if (!preservesAcknowledgement) return parts

  // Partial/mixed replay cannot delete sibling calls already witnessed in this message.
  return [
    ...parts,
    ...existingParts.filter(
      existing =>
        Predicate.isTagged(existing, 'ToolCall') &&
        !parts.some(
          part => Predicate.isTagged(part, 'ToolCall') && part.call.id === existing.call.id
        )
    )
  ]
}

const appendOrReplaceAssistantMessage = (
  messages: ReadonlyArray<AgentChatMessage>,
  message: AssistantAgentMessage
) => {
  const acceptedCallIds = new Set(
    messages.flatMap(current =>
      current.parts.flatMap(part =>
        Predicate.isTagged(part, 'ToolCall') && Predicate.isTagged(part.state, 'Accepted')
          ? [part.call.id]
          : []
      )
    )
  )

  const isAcceptedCallReplay = (part: AssistantPart) =>
    (Predicate.isTagged(part, 'HostToolCall') || Predicate.isTagged(part, 'ProviderToolCall')) &&
    acceptedCallIds.has(part.call.id)

  // A call-only replay must not replace the assistant message and drop active siblings.
  if (message.parts.length > 0 && message.parts.every(isAcceptedCallReplay)) return messages

  const messageToolCallIds = message.parts.flatMap(part =>
    Predicate.isTagged(part, 'HostToolCall') || Predicate.isTagged(part, 'ProviderToolCall')
      ? [part.call.id]
      : []
  )

  const replayIndex = message.parts.some(isAcceptedCallReplay)
    ? findLastMessageIndex(
        messages,
        current =>
          current.role === 'assistant' &&
          messageToolCallIds.some(callId => hasToolCall(current, callId))
      )
    : -1

  const index =
    replayIndex !== -1
      ? Option.some(replayIndex)
      : Option.filter(lastAssistantIndex(messages), assistantIndex => {
          const current = messages[assistantIndex]

          return (
            hasStreamingPart(current) ||
            messageToolCallIds.some(callId => hasToolCall(current, callId))
          )
        })

  return Option.match(index, {
    onNone: () => {
      const parts = message.parts.filter(part => !isAcceptedCallReplay(part))

      if (parts.length === 0) return messages
      const sequence = nextMessageSequence(messages)

      return [
        ...messages,
        assistantChatMessage(
          AssistantAgentMessage.make({ ...message, parts }),
          sequence,
          lastTurnId(messages) ?? turnId(sequence)
        )
      ]
    },
    onSome: assistantIndex =>
      messages.map((current, messageIndex) =>
        messageIndex === assistantIndex
          ? {
              ...current,
              parts: partsFromAssistantMessage(
                message,
                current.sequence,
                current.parts,
                acceptedCallIds
              )
            }
          : current
      )
  })
}

const appendOrphanToolResult = (
  messages: ReadonlyArray<AgentChatMessage>,
  result: ToolResult
): ReadonlyArray<AgentChatMessage> => {
  const sequence = nextMessageSequence(messages)
  const currentTurnId = lastTurnId(messages) ?? turnId(sequence)

  return [
    ...messages,
    {
      id: `message-${sequence}-tool-result-message`,
      turnId: currentTurnId,
      sequence,
      role: 'system',
      parts: [
        {
          ...toolResultMessageFromResult(result),
          id: `tool-result-${result.toolCallId}`,
          name: result.toolCallId
        }
      ]
    }
  ]
}

const clearTransientParts = (
  messages: ReadonlyArray<AgentChatMessage>
): ReadonlyArray<AgentChatMessage> =>
  messages.flatMap(message => {
    const parts = message.parts.filter(part => !Predicate.isTagged(part, 'Error'))

    return parts.length > 0 ? [{ ...message, parts }] : []
  })

const finalizeStreamingParts = (
  messages: ReadonlyArray<AgentChatMessage>
): ReadonlyArray<AgentChatMessage> =>
  messages.map(message =>
    message.role === 'assistant'
      ? { ...message, parts: finalizeAssistantParts(message.parts) }
      : message
  )

const appendRunMessagesIfEmpty = (
  messages: ReadonlyArray<AgentChatMessage>,
  runMessages: ReadonlyArray<AgentMessage>
) => {
  const lastUserMessageIndex = findLastMessageIndex(messages, message => message.role === 'user')

  const hasAssistantAfterLastUser = messages.some(
    (message, index) => message.role === 'assistant' && index > lastUserMessageIndex
  )

  if (runMessages.length === 0 || hasAssistantAfterLastUser) {
    return messages
  }

  return [
    ...messages,
    ...buildAgentChatMessages({
      messages: runMessages,
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [],
      error: null
    })
  ]
}

export const appendProtocolMessage = (
  messages: ReadonlyArray<AgentChatMessage>,
  message: AgentMessage
) => {
  const sequence = nextMessageSequence(messages)

  return Match.value(message).pipe(
    Match.tag('User', current => [...messages, userChatMessage(current, sequence)]),
    Match.tag('Assistant', current => [
      ...messages,
      assistantChatMessage(current, sequence, lastTurnId(messages) ?? turnId(sequence))
    ]),
    Match.tag('ToolResult', current => {
      const result = toolResultFromMessage(current)

      if (
        current.acceptance !== undefined &&
        messages.some(existing => hasToolCall(existing, current.toolCallId))
      ) {
        return messages.map(existing => ({
          ...existing,
          parts: existing.parts.map(part =>
            Predicate.isTagged(part, 'ToolCall') && part.call.id === current.toolCallId
              ? {
                  ...part,
                  state: mergeToolState(
                    part.state,
                    ChatToolState.Accepted({
                      result,
                      resultEnvelope: chatMessageEnvelope(current)
                    })
                  )
                }
              : part
          )
        }))
      }

      return appendOrphanToolResult(messages, result)
    }),
    Match.exhaustive
  )
}

export const markChatError = (
  messages: ReadonlyArray<AgentChatMessage>,
  message: string
): ReadonlyArray<AgentChatMessage> => [
  ...messages.filter(
    chatMessage => !chatMessage.parts.some(part => Predicate.isTagged(part, 'Error'))
  ),
  {
    id: 'error-message',
    turnId: 'error-turn',
    sequence: nextMessageSequence(messages),
    role: 'system',
    parts: [AgentChatPartError.make({ id: 'error', message })]
  }
]

/**
 * Applies one event without tracking `eventId` replay state.
 *
 * Prefer `applyAgentEventToChatProjection` for durable streams that can replay
 * or overlap. Append-only text and reasoning deltas are not idempotent here.
 */
export const applyAgentEventToChatMessages = (
  messages: ReadonlyArray<AgentChatMessage>,
  event: AgentEvent,
  options: ApplyAgentEventToChatMessagesOptions = {}
): ReadonlyArray<AgentChatMessage> => {
  const eventTimeMs = event.createdAtMs ?? options.nowMs ?? 0

  return Match.value(event)
    .pipe(
      Match.tag('AgentStart', () => clearTransientParts(messages)),
      Match.tag('LLMTextDelta', current =>
        appendAssistantTextDelta(messages, { delta: current.text, textSoFar: current.textSoFar })
      ),
      Match.tag('LLMReasoningDelta', current =>
        appendAssistantReasoningDelta(messages, {
          delta: current.text,
          reasoningSoFar: current.reasoningSoFar
        })
      ),
      Match.tag('ToolInputEnd', current =>
        upsertToolCallPart(messages, current.call, ChatToolStateCalled.make({}))
      ),
      Match.tag('UserMessage', current => appendProtocolMessage(messages, current.message)),
      Match.tag('AssistantMessage', current =>
        appendOrReplaceAssistantMessage(messages, current.message)
      ),
      Match.tag('ToolInputStart', current =>
        upsertToolCallPart(
          messages,
          inputStreamingToolCall(current.id, current.name),
          ChatToolStateInputStreaming.make({ input: '' })
        )
      ),
      Match.tag('ToolInputDelta', current =>
        appendToolInputDelta(messages, current.id, current.delta)
      ),
      Match.tag('ToolApprovalRequested', current =>
        upsertToolCallPart(
          messages,
          current.call,
          ChatToolState.ApprovalRequested({ request: current.request })
        )
      ),
      Match.tag('ToolApprovalGranted', () => messages)
    )
    .pipe(
      Match.tag('ToolApprovalDenied', current =>
        messages.map(message => ({
          ...message,
          parts: message.parts.map(part =>
            Predicate.isTagged(part, 'ToolCall') && part.call.id === current.toolCallId
              ? { ...part, state: ChatToolStateDenied.make({ reason: current.reason }) }
              : part
          )
        }))
      ),
      Match.tag('QuestionRequested', current =>
        upsertToolCallPart(
          messages,
          current.request.call,
          ChatToolState.QuestionRequested({ request: current.request })
        )
      ),
      Match.tag('QuestionAnswered', current =>
        messages.map(message => ({
          ...message,
          parts: message.parts.map(part =>
            Predicate.isTagged(part, 'ToolCall') && part.call.id === current.response.toolCallId
              ? {
                  ...part,
                  state: preserveQuestionRequest(
                    questionRequestFromToolState(part.state),
                    ChatToolState.QuestionAnswered({ response: current.response })
                  )
                }
              : part
          )
        }))
      ),
      Match.tag('QuestionCancelled', current =>
        messages.map(message => ({
          ...message,
          parts: message.parts.map(part =>
            Predicate.isTagged(part, 'ToolCall') && part.call.id === current.response.toolCallId
              ? {
                  ...part,
                  state: preserveQuestionRequest(
                    questionRequestFromToolState(part.state),
                    ChatToolState.QuestionCancelled({ response: current.response })
                  )
                }
              : part
          )
        }))
      ),
      Match.tag('ToolExecutionStarted', current =>
        upsertToolCallPart(
          messages,
          current.call,
          ChatToolStateRunning.make({ startedAtMs: eventTimeMs })
        )
      ),
      Match.tag('ToolExecutionAccepted', 'ToolExecutionCompleted', current =>
        upsertToolCallPart(
          messages,
          current.call,
          Predicate.isTagged(current, 'ToolExecutionAccepted')
            ? ChatToolState.Accepted({ result: current.result, endedAtMs: eventTimeMs })
            : ChatToolState.Completed({ result: current.result, endedAtMs: eventTimeMs })
        )
      ),
      Match.tag('ToolExecutionError', current =>
        upsertToolCallPart(
          messages,
          current.call,
          ChatToolStateErroredEnded.make({ message: current.message, endedAtMs: eventTimeMs })
        )
      ),
      Match.tag('ProviderToolResult', current =>
        upsertToolCallPart(
          messages,
          current.call,
          ChatToolState.ProviderCompleted({ result: current.result })
        )
      ),
      Match.tag('AgentError', current => markChatError(messages, current.message)),
      Match.tag('AgentEnd', 'AgentAwaitingInput', current =>
        appendRunMessagesIfEmpty(finalizeStreamingParts(messages), current.messages)
      ),
      Match.tag(
        'AgentRetry',
        'CompactionEnd',
        'CompactionStart',
        'LLMStreamEnd',
        'LLMStreamStart',
        'SubagentCompleted',
        'SubagentStarted',
        'TurnEnd',
        'TurnStart',
        'UsageUpdate',
        () => messages
      ),
      Match.exhaustive
    )
}

const chatMessagesFromProtocolMessage = ({
  message,
  sequence,
  currentTurnId,
  toolNames,
  toolResultsById,
  toolCallIds,
  toolRunsById
}: {
  readonly message: AgentMessage
  readonly sequence: number
  readonly currentTurnId: string
  readonly toolNames: ReadonlyMap<string, string>
  readonly toolResultsById: ReadonlyMap<string, ToolResultMessage>
  readonly toolCallIds: ReadonlySet<string>
  readonly toolRunsById: ReadonlyMap<string, AgentToolRun>
}): ReadonlyArray<AgentChatMessage> =>
  Match.value(message).pipe(
    Match.withReturnType<ReadonlyArray<AgentChatMessage>>(),
    Match.tag('User', current => [userChatMessage(current, sequence)]),
    Match.tag('Assistant', current => [
      {
        id: messageId(sequence, 'assistant'),
        turnId: currentTurnId,
        sequence,
        role: 'assistant',
        parts: assistantPartsFromMessage({
          message: current,
          messageIndex: sequence,
          toolResultsById,
          toolRunsById
        })
      }
    ]),
    Match.tag('ToolResult', current =>
      toolCallIds.has(current.toolCallId)
        ? []
        : [
            {
              id: `message-${sequence}-tool-result-message`,
              turnId: currentTurnId,
              sequence,
              role: 'system',
              parts: [
                {
                  ...toolResultMessageFromResult(current),
                  id: `message-${sequence}-tool-result-${current.toolCallId}`,
                  name: toolNames.get(current.toolCallId) ?? current.toolCallId
                }
              ]
            }
          ]
    ),
    Match.exhaustive
  )

const draftUserMessage = (userDraft: string): ReadonlyArray<AgentChatMessage> =>
  userDraft.length > 0
    ? [
        {
          id: 'draft-user',
          turnId: 'draft-user-turn',
          sequence: -1,
          role: 'user',
          parts: [
            AgentChatPartStreamingText.make({
              id: 'draft-user-text',
              content: userDraft,
              state: 'streaming'
            })
          ]
        }
      ]
    : []

const draftReasoningPart = (reasoningDraft: string): ReadonlyArray<AgentChatPart> =>
  reasoningDraft.length > 0
    ? [
        AgentChatPartReasoning.make({
          id: 'draft-reasoning',
          text: reasoningDraft,
          state: 'streaming'
        })
      ]
    : []

const draftTextPart = (assistantDraft: string): ReadonlyArray<AgentChatPart> =>
  assistantDraft.length > 0
    ? [
        AgentChatPartStreamingText.make({
          id: 'draft-assistant-text',
          content: assistantDraft,
          state: 'streaming'
        })
      ]
    : []

const draftAssistantPart = ({
  reasoningDraft,
  assistantDraft
}: {
  readonly reasoningDraft: string
  readonly assistantDraft: string
}): ReadonlyArray<AgentChatPart> => [
  ...draftReasoningPart(reasoningDraft),
  ...draftTextPart(assistantDraft)
]

const draftAssistantMessage = ({
  reasoningDraft,
  assistantDraft
}: {
  readonly reasoningDraft: string
  readonly assistantDraft: string
}): ReadonlyArray<AgentChatMessage> => {
  const parts = draftAssistantPart({ reasoningDraft, assistantDraft })

  return parts.length > 0
    ? [
        {
          id: 'draft-assistant',
          turnId: 'draft-assistant-turn',
          sequence: -1,
          role: 'assistant',
          parts
        }
      ]
    : []
}

const errorChatMessage = (message: string | null): ReadonlyArray<AgentChatMessage> =>
  message === null
    ? []
    : [
        {
          id: 'error-message',
          turnId: 'error-turn',
          sequence: -1,
          role: 'system',
          parts: [AgentChatPartError.make({ id: 'error', message })]
        }
      ]

export const buildAgentChatMessages = ({
  messages,
  userDraft,
  assistantDraft,
  reasoningDraft,
  toolRuns,
  error
}: BuildAgentChatMessagesInput): ReadonlyArray<AgentChatMessage> => {
  const toolNames = collectToolNames(messages, toolRuns)
  const toolResultsById = collectToolResultsById(messages)
  const toolCallIds = collectToolCallIds(messages)
  const toolRunsById = collectToolRunsById(toolRuns)

  const builtMessages = messages.reduce<ReadonlyArray<AgentChatMessage>>(
    (current, message, index) => {
      const currentTurnId = Predicate.isTagged(message, 'User')
        ? turnId(index)
        : (lastTurnId(current) ?? turnId(index))

      return [
        ...current,
        ...chatMessagesFromProtocolMessage({
          message,
          sequence: index,
          currentTurnId,
          toolNames,
          toolResultsById,
          toolCallIds,
          toolRunsById
        })
      ]
    },
    []
  )

  return [
    ...builtMessages,
    ...draftUserMessage(userDraft),
    ...draftAssistantMessage({ reasoningDraft, assistantDraft }),
    ...errorChatMessage(error)
  ]
}

const collectContent = (parts: ReadonlyArray<AgentChatPart>): Content => {
  const contentPartsList = parts
    .filter(part => Predicate.isTagged(part, 'Text'))
    .flatMap(part => contentParts(part.content))

  const onlyPart = contentPartsList[0]

  if (
    onlyPart !== undefined &&
    contentPartsList.length === 1 &&
    Predicate.isTagged(onlyPart, 'Text')
  ) {
    return onlyPart.text
  }

  return contentPartsList
}

const collectToolResultMessages = (parts: ReadonlyArray<AgentChatPart>) =>
  parts.flatMap(part =>
    Match.value(part).pipe(
      Match.tag('ToolCall', current => {
        if (
          Predicate.isTagged(current.state, 'Completed') ||
          Predicate.isTagged(current.state, 'Accepted')
        ) {
          return [
            toolResultMessageFromResult(
              current.state.result,
              Predicate.isTagged(current.state, 'Accepted')
                ? current.state.resultEnvelope
                : undefined
            )
          ]
        }

        if (Predicate.isTagged(current.state, 'Denied')) {
          return [
            ToolResultMessage.make({
              toolCallId: current.call.id,
              content: `Tool call denied: ${current.state.reason}`,
              isError: true,
              structuredContent: { type: 'tool_approval_denied', reason: current.state.reason }
            })
          ]
        }

        if (
          Predicate.isTagged(current.state, 'QuestionAnswered') ||
          Predicate.isTagged(current.state, 'QuestionCancelled')
        ) {
          const response = current.state.response

          return [
            ToolResultMessage.make({
              toolCallId: response.toolCallId,
              content: formatQuestionResponseContent(response, current.state.request?.questions),
              isError: response.outcome === 'cancelled' ? true : undefined,
              structuredContent: questionResponseStructuredContent(response)
            })
          ]
        }

        return []
      }),
      Match.tag('ToolResult', current => [toolResultMessageFromResult(current)]),
      Match.tag('Error', 'Reasoning', 'Text', () => []),
      Match.exhaustive
    )
  )

const assistantProtocolPartsFromChatParts = (
  parts: ReadonlyArray<AgentChatPart>
): ReadonlyArray<AssistantPart> =>
  parts.flatMap((part): ReadonlyArray<AssistantPart> =>
    Match.value(part).pipe(
      Match.tag('Text', current =>
        isContentEmpty(current.content)
          ? []
          : [AssistantTextPart.make({ content: current.content })]
      ),
      Match.tag('Reasoning', current =>
        current.text.length === 0 ? [] : [AssistantReasoningPart.make({ text: current.text })]
      ),
      Match.tag('ToolCall', current =>
        Predicate.isTagged(current.state, 'ProviderCompleted')
          ? [
              ProviderToolCallPart.make({ call: current.call }),
              ProviderToolResultPart.make({
                toolCallId: current.call.id,
                result: current.state.result
              })
            ]
          : [HostToolCallPart.make({ call: current.call })]
      ),
      Match.tag('Error', 'ToolResult', () => []),
      Match.exhaustive
    )
  )

const assistantMessageFromParts = (message: AgentChatMessage) => {
  const parts = message.parts
  const assistantParts = assistantProtocolPartsFromChatParts(parts)

  if (assistantParts.length === 0) {
    return Option.none<AgentMessage>()
  }

  return Option.some(
    AssistantAgentMessage.make({ ...chatMessageEnvelope(message), parts: assistantParts })
  )
}

const protocolMessagesFromChatMessage = (
  message: AgentChatMessage
): ReadonlyArray<AgentMessage> => {
  switch (message.role) {
    case 'user': {
      const content = collectContent(message.parts)

      return isContentEmpty(content)
        ? []
        : [UserMessage.make({ ...chatMessageEnvelope(message), content })]
    }

    case 'assistant':
      return [
        ...Arr.getSomes([assistantMessageFromParts(message)]),
        ...collectToolResultMessages(message.parts)
      ]
    case 'system':
      return collectToolResultMessages(message.parts)
  }
}

export const toAgentMessages = (messages: ReadonlyArray<AgentChatMessage>) =>
  Arr.flatMap(messages, protocolMessagesFromChatMessage)
