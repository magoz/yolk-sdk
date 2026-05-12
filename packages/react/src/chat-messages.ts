import { Array as Arr, Option } from 'effect'
import type { AgentToolRun } from '@yolk/client'
import {
  AssistantAgentMessage,
  AssistantReasoningPart,
  AssistantTextPart,
  HostToolCallPart,
  ProviderToolCallPart,
  ProviderToolResultPart,
  ToolResult,
  ToolResultMessage,
  ToolCall,
  UserMessage,
  appendTextToContent,
  contentParts,
  isContentEmpty,
  type AgentEvent,
  type AgentMessage,
  type AssistantPart,
  type Content
} from '@yolk/protocol'

export type ChatPartState = 'streaming' | 'done'

export type ChatToolState =
  | { readonly _tag: 'Called' }
  | { readonly _tag: 'InputStreaming'; readonly input: string }
  | { readonly _tag: 'ApprovalRequested' }
  | { readonly _tag: 'Denied'; readonly reason: string }
  | { readonly _tag: 'Running'; readonly startedAtMs: number }
  | {
      readonly _tag: 'Completed'
      readonly result: ToolResult
      readonly startedAtMs?: number
      readonly endedAtMs?: number
    }
  | { readonly _tag: 'Errored'; readonly message: string; readonly endedAtMs?: number }
  | { readonly _tag: 'ProviderCompleted'; readonly result: ToolResult }

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
    }
  | { readonly _tag: 'Error'; readonly id: string; readonly message: string }

export type AgentChatMessage = {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'system'
  readonly parts: ReadonlyArray<AgentChatPart>
}

export type ApplyAgentEventToChatMessagesOptions = {
  readonly nowMs?: number
}

const userChatMessage = (message: UserMessage, index: number): AgentChatMessage => ({
  id: `message-${index}-user`,
  role: 'user',
  parts: [
    {
      _tag: 'Text',
      id: `message-${index}-user-text`,
      content: message.content,
      state: 'done'
    }
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

const toolRunNameEntry = (run: AgentToolRun): ReadonlyArray<readonly [string, string]> => {
  switch (run._tag) {
    case 'InputStreaming':
      return run.name === undefined ? [] : [[run.id, run.name]]
    case 'Denied':
      return []
    case 'InputReady':
    case 'ApprovalRequested':
    case 'Executing':
    case 'Completed':
    case 'Errored':
    case 'ProviderCompleted':
      return [[run.call.id, run.call.name]]
  }
}

const assistantToolNameEntries = (
  message: AgentMessage
): ReadonlyArray<readonly [string, string]> =>
  message._tag === 'Assistant'
    ? message.parts.flatMap(part =>
        part._tag === 'HostToolCall' || part._tag === 'ProviderToolCall'
          ? [[part.call.id, part.call.name]]
          : []
      )
    : []

const collectToolNames = (
  messages: ReadonlyArray<AgentMessage>,
  toolRuns: ReadonlyArray<AgentToolRun>
): ReadonlyMap<string, string> =>
  new Map([...toolRuns.flatMap(toolRunNameEntry), ...messages.flatMap(assistantToolNameEntries)])

const toolResultEntry = (
  message: AgentMessage
): ReadonlyArray<readonly [string, ToolResult]> =>
  message._tag === 'ToolResult'
    ? [
        [
          message.toolCallId,
          ToolResult.make({
            toolCallId: message.toolCallId,
            content: message.content
          })
        ]
      ]
    : []

const collectToolResultsById = (messages: ReadonlyArray<AgentMessage>) =>
  new Map(messages.flatMap(toolResultEntry))

const collectToolCallIds = (messages: ReadonlyArray<AgentMessage>): ReadonlySet<string> =>
  new Set(
    messages.flatMap(message =>
      message._tag === 'Assistant'
        ? message.parts.flatMap(part =>
            part._tag === 'HostToolCall' || part._tag === 'ProviderToolCall' ? [part.call.id] : []
          )
        : []
    )
  )

const toolRunEntry = (run: AgentToolRun): readonly [string, AgentToolRun] => {
  switch (run._tag) {
    case 'InputStreaming':
      return [run.id, run]
    case 'Denied':
      return [run.toolCallId, run]
    case 'InputReady':
    case 'ApprovalRequested':
    case 'Executing':
    case 'Completed':
    case 'Errored':
    case 'ProviderCompleted':
      return [run.call.id, run]
  }
}

const collectToolRunsById = (runs: ReadonlyArray<AgentToolRun>): ReadonlyMap<string, AgentToolRun> =>
  new Map(runs.map(toolRunEntry))

const toolStateFor = (
  run: AgentToolRun | undefined,
  result: ToolResult | undefined
): ChatToolState => {
  if (run?._tag === 'Executing') {
    return { _tag: 'Running', startedAtMs: run.startedAtMs }
  }

  if (run?._tag === 'InputStreaming') {
    return { _tag: 'InputStreaming', input: run.input }
  }

  if (run?._tag === 'ApprovalRequested') {
    return { _tag: 'ApprovalRequested' }
  }

  if (run?._tag === 'Denied') {
    return { _tag: 'Denied', reason: run.reason }
  }

  if (run?._tag === 'Completed') {
    return {
      _tag: 'Completed',
      result: run.result,
      startedAtMs: run.startedAtMs,
      endedAtMs: run.endedAtMs
    }
  }

  if (run?._tag === 'Errored') {
    return { _tag: 'Errored', message: run.message, endedAtMs: run.endedAtMs }
  }

  if (run?._tag === 'ProviderCompleted') {
    return { _tag: 'ProviderCompleted', result: run.result }
  }

  if (result !== undefined) {
    return { _tag: 'Completed', result }
  }

  return { _tag: 'Called' }
}

const assistantPartsFromMessage = ({
  message,
  messageIndex,
  toolResultsById,
  toolRunsById
}: {
  readonly message: Extract<AgentMessage, { readonly _tag: 'Assistant' }>
  readonly messageIndex: number
  readonly toolResultsById: ReadonlyMap<string, ToolResult>
  readonly toolRunsById: ReadonlyMap<string, AgentToolRun>
}): ReadonlyArray<AgentChatPart> => {
  return message.parts.flatMap((part, partIndex): ReadonlyArray<AgentChatPart> => {
    switch (part._tag) {
      case 'Reasoning':
        return part.text.length > 0
          ? [
              {
                _tag: 'Reasoning',
                id: `message-${messageIndex}-reasoning-${partIndex}`,
                text: part.text,
                state: 'done'
              }
            ]
          : []
      case 'Text':
        return [
          {
            _tag: 'Text',
            id: `message-${messageIndex}-assistant-text-${partIndex}`,
            content: part.content,
            state: 'done'
          }
        ]
      case 'HostToolCall':
      case 'ProviderToolCall':
        return [
          {
            _tag: 'ToolCall',
            id: `message-${messageIndex}-tool-call-${part.call.id}`,
            call: part.call,
            state: toolStateFor(toolRunsById.get(part.call.id), toolResultsById.get(part.call.id))
          }
        ]
      case 'ProviderToolResult':
        return [
          {
            _tag: 'ToolResult',
            id: `message-${messageIndex}-provider-tool-result-${part.toolCallId}`,
            toolCallId: part.toolCallId,
            name: part.toolCallId,
            content: part.result.content
          }
        ]
    }
  })
}

const assistantChatMessage = (
  message: AssistantAgentMessage,
  index: number,
  parts: ReadonlyArray<AgentChatPart> = assistantPartsFromMessage({
    message,
    messageIndex: index,
    toolResultsById: new Map(),
    toolRunsById: new Map()
  })
): AgentChatMessage => ({
  id: `message-${index}-assistant`,
  role: 'assistant',
  parts
})

const hasStreamingPart = (message: AgentChatMessage) =>
  message.parts.some(
    part => (part._tag === 'Text' || part._tag === 'Reasoning') && part.state === 'streaming'
  )

const hasStreamingTextPart = (message: AgentChatMessage) =>
  message.parts.some(part => part._tag === 'Text' && part.state === 'streaming')

const hasToolCall = (message: AgentChatMessage, callId: string) =>
  message.parts.some(part => part._tag === 'ToolCall' && part.call.id === callId)

const findLastMessageIndex = (
  messages: ReadonlyArray<AgentChatMessage>,
  predicate: (message: AgentChatMessage) => boolean
) => messages.reduce((lastIndex, message, index) => (predicate(message) ? index : lastIndex), -1)

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
    onNone: () => [
      ...messages,
      { id: `message-${messages.length}-assistant`, role: 'assistant', parts: [part] }
    ],
    onSome: index =>
      messages.map((message, messageIndex) =>
        messageIndex === index ? { ...message, parts: [...message.parts, part] } : message
      )
  })

const appendAssistantTextDelta = (
  messages: ReadonlyArray<AgentChatMessage>,
  delta: string
): ReadonlyArray<AgentChatMessage> => {
  const index = targetAssistantIndex(messages)

  if (Option.isNone(index)) {
    return appendAssistantPart(messages, {
      _tag: 'Text',
      id: `message-${messages.length}-assistant-text`,
      content: delta,
      state: 'streaming'
    })
  }

  return messages.map((message, messageIndex) =>
    messageIndex === index.value
      ? {
          ...message,
          parts: hasStreamingTextPart(message)
            ? message.parts.map(part =>
                part._tag === 'Text' && part.state === 'streaming'
                  ? { ...part, content: appendTextToContent(part.content, delta) }
                  : part
              )
            : [
                ...message.parts,
                {
                  _tag: 'Text',
                  id: `message-${messageIndex}-assistant-text`,
                  content: delta,
                  state: 'streaming'
                }
              ]
        }
      : message
  )
}

const appendAssistantReasoningDelta = (
  messages: ReadonlyArray<AgentChatMessage>,
  delta: string
): ReadonlyArray<AgentChatMessage> => {
  const index = targetAssistantIndex(messages)

  if (Option.isNone(index)) {
    return appendAssistantPart(messages, {
      _tag: 'Reasoning',
      id: `message-${messages.length}-reasoning`,
      text: delta,
      state: 'streaming'
    })
  }

  return messages.map((message, messageIndex) =>
    messageIndex === index.value
      ? {
          ...message,
          parts: message.parts.some(part => part._tag === 'Reasoning' && part.state === 'streaming')
            ? message.parts.map(part =>
                part._tag === 'Reasoning' && part.state === 'streaming'
                  ? { ...part, text: `${part.text}${delta}` }
                  : part
              )
            : [
                ...message.parts,
                {
                  _tag: 'Reasoning',
                  id: `message-${messageIndex}-reasoning`,
                  text: delta,
                  state: 'streaming'
                }
              ]
        }
      : message
  )
}

const mergeToolState = (existing: ChatToolState, next: ChatToolState): ChatToolState => {
  if (next._tag === 'Errored' || next._tag === 'Denied' || next._tag === 'ProviderCompleted') {
    return next
  }

  if (next._tag === 'Completed') {
    return {
      ...next,
      startedAtMs:
        next.startedAtMs ??
        (existing._tag === 'Running' || existing._tag === 'Completed'
          ? existing.startedAtMs
          : undefined),
      endedAtMs: next.endedAtMs ?? (existing._tag === 'Completed' ? existing.endedAtMs : undefined)
    }
  }

  if (next._tag === 'Running' && existing._tag === 'Completed') {
    return existing
  }

  return next
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
              part._tag === 'ToolCall' && part.call.id === call.id
                ? { ...part, call, state: mergeToolState(part.state, state) }
                : part
            )
          }
        : message
    )
  }

  return appendAssistantPart(messages, {
    _tag: 'ToolCall',
    id: `tool-call-${call.id}`,
    call,
    state
  })
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
      part._tag === 'ToolCall' && part.call.id === id && part.state._tag === 'InputStreaming'
        ? { ...part, state: { ...part.state, input: `${part.state.input}${delta}` } }
        : part
    )
  }))

const finalizeAssistantParts = (
  parts: ReadonlyArray<AgentChatPart>
): ReadonlyArray<AgentChatPart> =>
  parts.map(part => {
    switch (part._tag) {
      case 'Text':
      case 'Reasoning':
        return { ...part, state: 'done' satisfies ChatPartState }
      case 'Error':
      case 'ToolCall':
      case 'ToolResult':
        return part
    }
  })

const toolStateEntry = (
  part: AgentChatPart
): ReadonlyArray<readonly [string, ChatToolState]> =>
  part._tag === 'ToolCall' ? [[part.call.id, part.state]] : []

const toolStateByCallId = (parts: ReadonlyArray<AgentChatPart>) =>
  new Map(parts.flatMap(toolStateEntry))

const partsFromAssistantMessage = (
  message: AssistantAgentMessage,
  messageIndex: number,
  existingParts: ReadonlyArray<AgentChatPart>
) => {
  const states = toolStateByCallId(existingParts)

  return assistantPartsFromMessage({
    message,
    messageIndex,
    toolResultsById: new Map(),
    toolRunsById: new Map()
  }).map(part =>
    part._tag === 'ToolCall' ? { ...part, state: states.get(part.call.id) ?? part.state } : part
  )
}

const appendOrReplaceAssistantMessage = (
  messages: ReadonlyArray<AgentChatMessage>,
  message: AssistantAgentMessage
) => {
  const messageToolCallIds = message.parts.flatMap(part =>
    part._tag === 'HostToolCall' || part._tag === 'ProviderToolCall' ? [part.call.id] : []
  )
  const index = Option.filter(lastAssistantIndex(messages), assistantIndex => {
    const current = messages[assistantIndex]

    return hasStreamingPart(current) || messageToolCallIds.some(callId => hasToolCall(current, callId))
  })

  return Option.match(index, {
    onNone: () => [...messages, assistantChatMessage(message, messages.length)],
    onSome: assistantIndex =>
      messages.map((current, messageIndex) =>
        messageIndex === assistantIndex
          ? {
              ...current,
              parts: partsFromAssistantMessage(message, messageIndex, current.parts)
            }
          : current
      )
  })
}

const appendOrphanToolResult = (
  messages: ReadonlyArray<AgentChatMessage>,
  result: ToolResult
): ReadonlyArray<AgentChatMessage> => [
  ...messages,
  {
    id: `message-${messages.length}-tool-result-message`,
    role: 'system',
    parts: [
      {
        _tag: 'ToolResult',
        id: `tool-result-${result.toolCallId}`,
        toolCallId: result.toolCallId,
        name: result.toolCallId,
        content: result.content
      }
    ]
  }
]

const clearTransientParts = (
  messages: ReadonlyArray<AgentChatMessage>
): ReadonlyArray<AgentChatMessage> =>
  messages.flatMap(message => {
    const parts = message.parts.filter(part => part._tag !== 'Error')

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
  if (runMessages.length === 0 || messages.some(message => message.role === 'assistant')) {
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
  switch (message._tag) {
    case 'User':
      return [...messages, userChatMessage(message, messages.length)]
    case 'Assistant':
      return [...messages, assistantChatMessage(message, messages.length)]
    case 'ToolResult':
      return appendOrphanToolResult(
        messages,
        ToolResult.make({ toolCallId: message.toolCallId, content: message.content })
      )
  }
}

export const markChatError = (
  messages: ReadonlyArray<AgentChatMessage>,
  message: string
): ReadonlyArray<AgentChatMessage> => [
  ...messages.filter(chatMessage => !chatMessage.parts.some(part => part._tag === 'Error')),
  {
    id: 'error-message',
    role: 'system',
    parts: [{ _tag: 'Error', id: 'error', message }]
  }
]

export const applyAgentEventToChatMessages = (
  messages: ReadonlyArray<AgentChatMessage>,
  event: AgentEvent,
  options: ApplyAgentEventToChatMessagesOptions = {}
): ReadonlyArray<AgentChatMessage> => {
  const nowMs = options.nowMs ?? 0

  switch (event._tag) {
    case 'AgentStart':
      return clearTransientParts(messages)
    case 'LLMTextDelta':
      return appendAssistantTextDelta(messages, event.text)
    case 'LLMReasoningDelta':
      return appendAssistantReasoningDelta(messages, event.text)
    case 'ToolInputEnd':
      return upsertToolCallPart(messages, event.call, { _tag: 'Called' })
    case 'AssistantMessage':
      return appendOrReplaceAssistantMessage(messages, event.message)
    case 'ToolInputStart':
      return upsertToolCallPart(messages, inputStreamingToolCall(event.id, event.name), {
        _tag: 'InputStreaming',
        input: ''
      })
    case 'ToolInputDelta':
      return appendToolInputDelta(messages, event.id, event.delta)
    case 'ToolApprovalRequested':
      return upsertToolCallPart(messages, event.call, { _tag: 'ApprovalRequested' })
    case 'ToolApprovalGranted':
      return messages
    case 'ToolApprovalDenied':
      return messages.map(message => ({
        ...message,
        parts: message.parts.map(part =>
          part._tag === 'ToolCall' && part.call.id === event.toolCallId
            ? { ...part, state: { _tag: 'Denied', reason: event.reason } }
            : part
        )
      }))
    case 'ToolExecutionStarted':
      return upsertToolCallPart(messages, event.call, { _tag: 'Running', startedAtMs: nowMs })
    case 'ToolExecutionCompleted':
      return upsertToolCallPart(messages, event.call, {
        _tag: 'Completed',
        result: event.result,
        endedAtMs: nowMs
      })
    case 'ToolExecutionError':
      return upsertToolCallPart(messages, event.call, {
        _tag: 'Errored',
        message: event.message,
        endedAtMs: nowMs
      })
    case 'ProviderToolResult':
      return upsertToolCallPart(messages, event.call, {
        _tag: 'ProviderCompleted',
        result: event.result
      })
    case 'AgentError':
      return markChatError(messages, event.message)
    case 'AgentEnd':
      return appendRunMessagesIfEmpty(finalizeStreamingParts(messages), event.messages)
    case 'AgentRetry':
    case 'CompactionEnd':
    case 'CompactionStart':
    case 'LLMStreamEnd':
    case 'LLMStreamStart':
    case 'TurnEnd':
    case 'TurnStart':
    case 'UsageUpdate':
      return messages
  }
}

const chatMessagesFromProtocolMessage = ({
  message,
  index,
  toolNames,
  toolResultsById,
  toolCallIds,
  toolRunsById
}: {
  readonly message: AgentMessage
  readonly index: number
  readonly toolNames: ReadonlyMap<string, string>
  readonly toolResultsById: ReadonlyMap<string, ToolResult>
  readonly toolCallIds: ReadonlySet<string>
  readonly toolRunsById: ReadonlyMap<string, AgentToolRun>
}): ReadonlyArray<AgentChatMessage> => {
  switch (message._tag) {
    case 'User':
      return [userChatMessage(message, index)]
    case 'Assistant':
      return [
        {
          id: `message-${index}-assistant`,
          role: 'assistant',
          parts: assistantPartsFromMessage({
            message,
            messageIndex: index,
            toolResultsById,
            toolRunsById
          })
        }
      ]
    case 'ToolResult':
      return toolCallIds.has(message.toolCallId)
        ? []
        : [
            {
              id: `message-${index}-tool-result-message`,
              role: 'system',
              parts: [
                {
                  _tag: 'ToolResult',
                  id: `message-${index}-tool-result-${message.toolCallId}`,
                  toolCallId: message.toolCallId,
                  name: toolNames.get(message.toolCallId) ?? message.toolCallId,
                  content: message.content
                }
              ]
            }
          ]
  }
}

const draftUserMessage = (userDraft: string): ReadonlyArray<AgentChatMessage> =>
  userDraft.length > 0
    ? [
        {
          id: 'draft-user',
          role: 'user',
          parts: [{ _tag: 'Text', id: 'draft-user-text', content: userDraft, state: 'streaming' }]
        }
      ]
    : []

const draftReasoningPart = (reasoningDraft: string): ReadonlyArray<AgentChatPart> =>
  reasoningDraft.length > 0
    ? [
        {
          _tag: 'Reasoning',
          id: 'draft-reasoning',
          text: reasoningDraft,
          state: 'streaming'
        }
      ]
    : []

const draftTextPart = (assistantDraft: string): ReadonlyArray<AgentChatPart> =>
  assistantDraft.length > 0
    ? [
        {
          _tag: 'Text',
          id: 'draft-assistant-text',
          content: assistantDraft,
          state: 'streaming'
        }
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

  return parts.length > 0 ? [{ id: 'draft-assistant', role: 'assistant', parts }] : []
}

const errorChatMessage = (message: string | null): ReadonlyArray<AgentChatMessage> =>
  message === null
    ? []
    : [
        {
          id: 'error-message',
          role: 'system',
          parts: [{ _tag: 'Error', id: 'error', message }]
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

  return [
    ...messages.flatMap((message, index) =>
      chatMessagesFromProtocolMessage({
        message,
        index,
        toolNames,
        toolResultsById,
        toolCallIds,
        toolRunsById
      })
    ),
    ...draftUserMessage(userDraft),
    ...draftAssistantMessage({ reasoningDraft, assistantDraft }),
    ...errorChatMessage(error)
  ]
}

const collectContent = (parts: ReadonlyArray<AgentChatPart>): Content => {
  const contentPartsList = parts
    .filter(part => part._tag === 'Text')
    .flatMap(part => contentParts(part.content))

  const onlyPart = contentPartsList[0]

  if (onlyPart !== undefined && contentPartsList.length === 1 && onlyPart._tag === 'Text') {
    return onlyPart.text
  }

  return contentPartsList
}

const collectToolResultMessages = (parts: ReadonlyArray<AgentChatPart>) =>
  parts.flatMap(part => {
    switch (part._tag) {
      case 'ToolCall':
        return part.state._tag === 'Completed'
          ? [
              ToolResultMessage.make({
                toolCallId: part.state.result.toolCallId,
                content: part.state.result.content,
                structuredContent: part.state.result.structuredContent
              })
            ]
          : []
      case 'ToolResult':
        return [ToolResultMessage.make({ toolCallId: part.toolCallId, content: part.content })]
      case 'Error':
      case 'Reasoning':
      case 'Text':
        return []
    }
  })

const assistantProtocolPartsFromChatParts = (
  parts: ReadonlyArray<AgentChatPart>
): ReadonlyArray<AssistantPart> =>
  parts.flatMap((part): ReadonlyArray<AssistantPart> => {
    switch (part._tag) {
      case 'Text':
        return isContentEmpty(part.content) ? [] : [AssistantTextPart.make({ content: part.content })]
      case 'Reasoning':
        return part.text.length === 0 ? [] : [AssistantReasoningPart.make({ text: part.text })]
      case 'ToolCall':
        return part.state._tag === 'ProviderCompleted'
          ? [
              ProviderToolCallPart.make({ call: part.call }),
              ProviderToolResultPart.make({
                toolCallId: part.call.id,
                result: part.state.result
              })
            ]
          : [HostToolCallPart.make({ call: part.call })]
      case 'Error':
      case 'ToolResult':
        return []
    }
  })

const assistantMessageFromParts = (parts: ReadonlyArray<AgentChatPart>) => {
  const assistantParts = assistantProtocolPartsFromChatParts(parts)

  if (assistantParts.length === 0) {
    return Option.none<AgentMessage>()
  }

  return Option.some(AssistantAgentMessage.make({ parts: assistantParts }))
}

const protocolMessagesFromChatMessage = (
  message: AgentChatMessage
): ReadonlyArray<AgentMessage> => {
  switch (message.role) {
    case 'user': {
      const content = collectContent(message.parts)

      return isContentEmpty(content) ? [] : [UserMessage.make({ content })]
    }
    case 'assistant':
      return [
        ...Arr.getSomes([assistantMessageFromParts(message.parts)]),
        ...collectToolResultMessages(message.parts)
      ]
    case 'system':
      return collectToolResultMessages(message.parts)
  }
}

export const toAgentMessages = (messages: ReadonlyArray<AgentChatMessage>) =>
  Arr.flatMap(messages, protocolMessagesFromChatMessage)
