import type { AgentMessage, Content, ToolCall, ToolResult } from '@yolk/protocol'

export type LiveToolState =
  | { readonly _tag: 'Running' }
  | { readonly _tag: 'Completed'; readonly result: ToolResult }

export type AgentChatItem =
  | { readonly _tag: 'UserMessage'; readonly id: string; readonly content: Content }
  | { readonly _tag: 'AssistantMessage'; readonly id: string; readonly content: Content }
  | { readonly _tag: 'Reasoning'; readonly id: string; readonly text: string }
  | { readonly _tag: 'ToolCall'; readonly id: string; readonly call: ToolCall }
  | { readonly _tag: 'LiveTool'; readonly id: string; readonly call: ToolCall; readonly state: LiveToolState }
  | {
      readonly _tag: 'ToolResult'
      readonly id: string
      readonly toolCallId: string
      readonly name: string
      readonly content: Content
    }
  | { readonly _tag: 'UserDraft'; readonly id: string; readonly text: string }
  | { readonly _tag: 'AssistantDraft'; readonly id: string; readonly text: string }
  | { readonly _tag: 'AssistantStatus'; readonly id: string; readonly label: string }
  | { readonly _tag: 'Error'; readonly id: string; readonly message: string }

export type BuildAgentChatItemsInput = {
  readonly messages: ReadonlyArray<AgentMessage>
  readonly userDraft: string
  readonly assistantDraft: string
  readonly reasoningDraft: string
  readonly activeToolCalls: ReadonlyArray<ToolCall>
  readonly completedToolCalls: ReadonlyArray<ToolCall>
  readonly liveToolResults: ReadonlyArray<ToolResult>
  readonly isRunning: boolean
  readonly error: string | null
}

const activeStatusLabel = ({
  activeToolCalls,
  assistantDraft,
  reasoningDraft
}: Pick<BuildAgentChatItemsInput, 'activeToolCalls' | 'assistantDraft' | 'reasoningDraft'>) => {
  const firstCall = activeToolCalls[0]

  if (firstCall !== undefined) {
    return activeToolCalls.length === 1
      ? `Running ${firstCall.name}`
      : `Running ${activeToolCalls.length} tools`
  }

  if (assistantDraft.length > 0) {
    return 'Responding'
  }

  if (reasoningDraft.length > 0) {
    return 'Thinking'
  }

  return 'Thinking'
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

const addToolCallNames = (names: Map<string, string>, calls: ReadonlyArray<ToolCall>) => {
  for (const call of calls) {
    names.set(call.id, call.name)
  }
}

const collectToolCallsById = (calls: ReadonlyArray<ToolCall>) => {
  const callsById = new Map<string, ToolCall>()

  for (const call of calls) {
    callsById.set(call.id, call)
  }

  return callsById
}

export const buildAgentChatItems = ({
  messages,
  userDraft,
  assistantDraft,
  reasoningDraft,
  activeToolCalls,
  completedToolCalls,
  liveToolResults,
  isRunning,
  error
}: BuildAgentChatItemsInput): ReadonlyArray<AgentChatItem> => {
  const toolNames = collectToolNames(messages)
  const items: Array<AgentChatItem> = []

  addToolCallNames(toolNames, activeToolCalls)
  addToolCallNames(toolNames, completedToolCalls)
  const completedToolCallsById = collectToolCallsById(completedToolCalls)

  messages.forEach((message, index) => {
    switch (message._tag) {
      case 'User':
        items.push({ _tag: 'UserMessage', id: `message-${index}-user`, content: message.content })
        return
      case 'Assistant':
        if (message.reasoning !== undefined && message.reasoning.length > 0) {
          items.push({
            _tag: 'Reasoning',
            id: `message-${index}-reasoning`,
            text: message.reasoning
          })
        }

        items.push({
          _tag: 'AssistantMessage',
          id: `message-${index}-assistant`,
          content: message.content
        })

        for (const call of message.toolCalls) {
          items.push({ _tag: 'ToolCall', id: `message-${index}-tool-call-${call.id}`, call })
        }
        return
      case 'ToolResult':
        items.push({
          _tag: 'ToolResult',
          id: `message-${index}-tool-result-${message.toolCallId}`,
          toolCallId: message.toolCallId,
          name: toolNames.get(message.toolCallId) ?? message.toolCallId,
          content: message.content
        })
        return
    }
  })

  if (reasoningDraft.length > 0) {
    items.push({ _tag: 'Reasoning', id: 'draft-reasoning', text: reasoningDraft })
  }

  if (userDraft.length > 0) {
    items.push({ _tag: 'UserDraft', id: 'draft-user', text: userDraft })
  }

  if (assistantDraft.length > 0) {
    items.push({ _tag: 'AssistantDraft', id: 'draft-assistant', text: assistantDraft })
  }

  for (const call of activeToolCalls) {
    items.push({
      _tag: 'LiveTool',
      id: `live-tool-${call.id}`,
      call,
      state: { _tag: 'Running' }
    })
  }

  if (isRunning) {
    for (const result of liveToolResults) {
      const call = completedToolCallsById.get(result.toolCallId)

      if (call === undefined) {
        items.push({
          _tag: 'ToolResult',
          id: `live-tool-result-${result.toolCallId}`,
          toolCallId: result.toolCallId,
          name: toolNames.get(result.toolCallId) ?? result.toolCallId,
          content: result.content
        })
      } else {
        items.push({
          _tag: 'LiveTool',
          id: `live-tool-${call.id}`,
          call,
          state: { _tag: 'Completed', result }
        })
      }
    }
  }

  if (isRunning) {
    items.push({
      _tag: 'AssistantStatus',
      id: 'assistant-status',
      label: activeStatusLabel({ activeToolCalls, assistantDraft, reasoningDraft })
    })
  }

  if (error !== null) {
    items.push({ _tag: 'Error', id: 'error', message: error })
  }

  return items
}
