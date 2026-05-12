import {
  ToolResultMessage,
  type AgentEvent,
  type AgentMessage,
  type ToolCall,
  type ToolResult,
  type UserMessage
} from '@yolk/protocol'

export type AgentRunStatus = 'idle' | 'running' | 'done' | 'error' | 'aborted'

export type AgentToolRun =
  | { readonly _tag: 'Called'; readonly call: ToolCall }
  | { readonly _tag: 'Running'; readonly call: ToolCall; readonly startedAtMs: number }
  | {
      readonly _tag: 'Completed'
      readonly call: ToolCall
      readonly result: ToolResult
      readonly startedAtMs: number
      readonly endedAtMs: number
    }

type StartedAgentToolRun = Extract<AgentToolRun, { readonly _tag: 'Running' | 'Completed' }>

export type AgentClientState = {
  readonly status: AgentRunStatus
  readonly messages: ReadonlyArray<AgentMessage>
  readonly liveMessages: ReadonlyArray<AgentMessage>
  readonly text: string
  readonly reasoning: string
  readonly toolRuns: ReadonlyArray<AgentToolRun>
  readonly error: string | null
}

export type ApplyAgentEventOptions = {
  readonly nowMs?: number
}

export type AgentTranscript = readonly [AgentMessage, ...Array<AgentMessage>]

export const initialAgentClientState: AgentClientState = {
  status: 'idle',
  messages: [],
  liveMessages: [],
  text: '',
  reasoning: '',
  toolRuns: [],
  error: null
}

export const isActiveToolRun = (run: AgentToolRun) => run._tag !== 'Completed'

export const completedToolRuns = (runs: ReadonlyArray<AgentToolRun>) =>
  runs.filter(run => run._tag === 'Completed')

const replaceToolRun = (
  runs: ReadonlyArray<AgentToolRun>,
  run: AgentToolRun
): ReadonlyArray<AgentToolRun> => {
  const replaceIndex = runs.findIndex(current => current.call.id === run.call.id)

  if (replaceIndex === -1) {
    return [...runs, run]
  }

  return runs.flatMap((current, index) => {
    if (current.call.id !== run.call.id) {
      return [current]
    }

    return index === replaceIndex ? [run] : []
  })
}

const isStartedToolRun = (run: AgentToolRun): run is StartedAgentToolRun => run._tag !== 'Called'

const startedAtMsFor = (runs: ReadonlyArray<AgentToolRun>, toolCallId: string) =>
  runs.filter(isStartedToolRun).find(run => run.call.id === toolCallId)?.startedAtMs

export const appendAgentMessage = (
  messages: ReadonlyArray<AgentMessage>,
  message: AgentMessage
): AgentTranscript => {
  const first = messages[0]

  if (first === undefined) {
    return [message]
  }

  return [first, ...messages.slice(1), message]
}

export const applyAgentEvent = (state: AgentClientState, event: AgentEvent): AgentClientState => {
  const nowMs = 0

  return applyAgentEventWithOptions(state, event, { nowMs })
}

export const applyAgentEventWithOptions = (
  state: AgentClientState,
  event: AgentEvent,
  options: ApplyAgentEventOptions = {}
): AgentClientState => {
  const nowMs = options.nowMs ?? 0

  switch (event._tag) {
    case 'AgentStart':
      return {
        ...state,
        status: 'running',
        text: '',
        reasoning: '',
        liveMessages: [],
        toolRuns: completedToolRuns(state.toolRuns),
        error: null
      }
    case 'AgentError':
      return markAgentError(state, event.message)
    case 'LLMTextDelta':
      return { ...state, text: `${state.text}${event.text}` }
    case 'LLMReasoningDelta':
      return { ...state, reasoning: `${state.reasoning}${event.text}` }
    case 'LLMToolCall':
      return {
        ...state,
        toolRuns: replaceToolRun(state.toolRuns, { _tag: 'Called', call: event.call })
      }
    case 'ToolExecutionStart':
      return {
        ...state,
        toolRuns: replaceToolRun(state.toolRuns, {
          _tag: 'Running',
          call: event.call,
          startedAtMs: nowMs
        })
      }
    case 'ToolExecutionEnd': {
      const endedAtMs = nowMs
      const startedAtMs = startedAtMsFor(state.toolRuns, event.call.id) ?? endedAtMs

      return {
        ...state,
        toolRuns: replaceToolRun(state.toolRuns, {
          _tag: 'Completed',
          call: event.call,
          result: event.result,
          startedAtMs,
          endedAtMs
        })
      }
    }
    case 'AssistantMessage':
      return {
        ...state,
        liveMessages: [...state.liveMessages, event.message],
        text: '',
        reasoning: ''
      }
    case 'ToolResult':
      return {
        ...state,
        liveMessages: [
          ...state.liveMessages,
          ToolResultMessage.make({
            toolCallId: event.result.toolCallId,
            content: event.result.content
          })
        ]
      }
    case 'AgentEnd':
      return {
        ...state,
        status: 'done',
        messages: [...state.messages, ...event.messages],
        liveMessages: [],
        text: '',
        reasoning: '',
        toolRuns: completedToolRuns(state.toolRuns)
      }
    case 'AgentRetry':
    case 'CompactionEnd':
    case 'CompactionStart':
    case 'LLMStreamEnd':
    case 'LLMStreamStart':
    case 'TurnEnd':
    case 'TurnStart':
    case 'UsageUpdate':
      return state
  }
}

export const submitAgentUserMessage = (
  state: AgentClientState,
  message: UserMessage
): AgentClientState => ({
  ...state,
  status: 'running',
  messages: appendAgentMessage(state.messages, message),
  liveMessages: [],
  text: '',
  reasoning: '',
  toolRuns: completedToolRuns(state.toolRuns),
  error: null
})

export const markAgentError = (
  state: AgentClientState,
  message = 'Agent request failed'
): AgentClientState => ({
  ...state,
  status: 'error',
  toolRuns: completedToolRuns(state.toolRuns),
  error: message
})

export const markAgentAborted = (state: AgentClientState): AgentClientState => ({
  ...state,
  status: 'aborted',
  toolRuns: completedToolRuns(state.toolRuns),
  error: null
})

export const reduceAgentEvents = (
  events: ReadonlyArray<AgentEvent>,
  initialState: AgentClientState = initialAgentClientState,
  options: ApplyAgentEventOptions = {}
) => events.reduce((state, event) => applyAgentEventWithOptions(state, event, options), initialState)
