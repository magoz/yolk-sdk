import type { AgentToolRun } from '@yolk/client'
import { ToolResult, type AgentMessage, type Content, type ToolCall } from '@yolk/protocol'

export type ToolDuration =
  | { readonly _tag: 'Known'; readonly milliseconds: number }
  | { readonly _tag: 'Unknown' }

export type ToolRunState =
  | { readonly _tag: 'Running'; readonly duration: ToolDuration }
  | { readonly _tag: 'Called'; readonly duration: ToolDuration }
  | { readonly _tag: 'Completed'; readonly duration: ToolDuration; readonly result: ToolResult }

export type AgentChatItem =
  | { readonly _tag: 'UserMessage'; readonly id: string; readonly content: Content }
  | { readonly _tag: 'AssistantMessage'; readonly id: string; readonly content: Content }
  | { readonly _tag: 'Reasoning'; readonly id: string; readonly text: string }
  | {
      readonly _tag: 'ToolRun'
      readonly id: string
      readonly call: ToolCall
      readonly state: ToolRunState
    }
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
  readonly toolRuns: ReadonlyArray<AgentToolRun>
  readonly isRunning: boolean
  readonly error: string | null
}

const activeStatusLabel = ({
  toolRuns,
  assistantDraft,
  reasoningDraft
}: Pick<BuildAgentChatItemsInput, 'toolRuns' | 'assistantDraft' | 'reasoningDraft'>) => {
  const activeRuns = toolRuns.filter(run => run._tag !== 'Completed')
  const firstRun = activeRuns[0]

  if (firstRun !== undefined) {
    return activeRuns.length === 1
      ? `Running ${firstRun.call.name}`
      : `Running ${activeRuns.length} tools`
  }

  if (assistantDraft.length > 0) {
    return 'Responding'
  }

  if (reasoningDraft.length > 0) {
    return 'Thinking'
  }

  return 'Thinking'
}

const collectToolNames = (
  messages: ReadonlyArray<AgentMessage>,
  toolRuns: ReadonlyArray<AgentToolRun>
) => {
  const names = new Map<string, string>()

  for (const run of toolRuns) {
    names.set(run.call.id, run.call.name)
  }

  for (const message of messages) {
    if (message._tag === 'Assistant') {
      for (const call of message.toolCalls) {
        names.set(call.id, call.name)
      }
    }
  }

  return names
}

const collectToolResultsById = (messages: ReadonlyArray<AgentMessage>) => {
  const resultsById = new Map<string, ToolResult>()

  for (const message of messages) {
    if (message._tag === 'ToolResult') {
      resultsById.set(
        message.toolCallId,
        ToolResult.make({
          toolCallId: message.toolCallId,
          content: message.content
        })
      )
    }
  }

  return resultsById
}

const collectToolCallIds = (messages: ReadonlyArray<AgentMessage>) => {
  const ids = new Set<string>()

  for (const message of messages) {
    if (message._tag === 'Assistant') {
      for (const call of message.toolCalls) {
        ids.add(call.id)
      }
    }
  }

  return ids
}

const collectToolRunsById = (runs: ReadonlyArray<AgentToolRun>) => {
  const runsById = new Map<string, AgentToolRun>()

  for (const run of runs) {
    runsById.set(run.call.id, run)
  }

  return runsById
}

const durationFromRun = (run: AgentToolRun | undefined): ToolDuration => {
  if (run === undefined || run._tag !== 'Completed') {
    return { _tag: 'Unknown' }
  }

  return { _tag: 'Known', milliseconds: Math.max(0, run.endedAtMs - run.startedAtMs) }
}

const toolRunStateFor = (
  run: AgentToolRun | undefined,
  result: ToolResult | undefined
): ToolRunState => {
  if (run?._tag === 'Running') {
    return { _tag: 'Running', duration: { _tag: 'Unknown' } }
  }

  if (run?._tag === 'Completed') {
    return { _tag: 'Completed', duration: durationFromRun(run), result: run.result }
  }

  if (result !== undefined) {
    return { _tag: 'Completed', duration: { _tag: 'Unknown' }, result }
  }

  return { _tag: 'Called', duration: { _tag: 'Unknown' } }
}

export const buildAgentChatItems = ({
  messages,
  userDraft,
  assistantDraft,
  reasoningDraft,
  toolRuns,
  isRunning,
  error
}: BuildAgentChatItemsInput): ReadonlyArray<AgentChatItem> => {
  const toolNames = collectToolNames(messages, toolRuns)
  const toolResultsById = collectToolResultsById(messages)
  const toolCallIds = collectToolCallIds(messages)
  const toolRunsById = collectToolRunsById(toolRuns)
  const items: Array<AgentChatItem> = []

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
          const result = toolResultsById.get(call.id)

          items.push({
            _tag: 'ToolRun',
            id: `message-${index}-tool-run-${call.id}`,
            call,
            state: toolRunStateFor(toolRunsById.get(call.id), result)
          })
        }
        return
      case 'ToolResult':
        if (toolCallIds.has(message.toolCallId)) {
          return
        }

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

  if (isRunning) {
    items.push({
      _tag: 'AssistantStatus',
      id: 'assistant-status',
      label: activeStatusLabel({ toolRuns, assistantDraft, reasoningDraft })
    })
  }

  if (error !== null) {
    items.push({ _tag: 'Error', id: 'error', message: error })
  }

  return items
}
