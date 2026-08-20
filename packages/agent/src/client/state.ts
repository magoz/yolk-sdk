import {
  type AgentError,
  type AgentEvent,
  type AgentMessage,
  type AgentRetry,
  type HitlRequest,
  type QuestionRequest,
  type QuestionResponse,
  type ToolCall,
  type ToolApprovalRequest,
  type ToolResult,
  type UserMessage
} from '@yolk-sdk/agent/protocol'

export type AgentRunStatus = 'idle' | 'running' | 'waiting' | 'done' | 'error' | 'aborted'

export type AgentToolRun =
  | {
      readonly _tag: 'InputStreaming'
      readonly id: string
      readonly name?: string
      readonly input: string
    }
  | { readonly _tag: 'InputReady'; readonly call: ToolCall }
  | {
      readonly _tag: 'ApprovalRequested'
      readonly call: ToolCall
      readonly request?: ToolApprovalRequest
    }
  | { readonly _tag: 'Denied'; readonly toolCallId: string; readonly reason: string }
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
  | { readonly _tag: 'Executing'; readonly call: ToolCall; readonly startedAtMs: number }
  | {
      readonly _tag: 'Completed'
      readonly call: ToolCall
      readonly result: ToolResult
      readonly startedAtMs: number
      readonly endedAtMs: number
    }
  | {
      readonly _tag: 'Errored'
      readonly call: ToolCall
      readonly message: string
      readonly endedAtMs: number
    }
  | { readonly _tag: 'ProviderCompleted'; readonly call: ToolCall; readonly result: ToolResult }

type StartedAgentToolRun = Extract<AgentToolRun, { readonly _tag: 'Executing' | 'Completed' }>

export type AgentClientState = {
  readonly status: AgentRunStatus
  readonly messages: ReadonlyArray<AgentMessage>
  readonly liveMessages: ReadonlyArray<AgentMessage>
  readonly text: string
  readonly reasoning: string
  readonly toolRuns: ReadonlyArray<AgentToolRun>
  readonly error: string | null
  readonly errorInfo: AgentError | null
  readonly retryInfo: AgentRetry | null
  readonly seenEventIds: ReadonlyArray<string>
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
  error: null,
  errorInfo: null,
  retryInfo: null,
  seenEventIds: []
}

const clearRetryInfo = (state: AgentClientState): AgentClientState =>
  state.retryInfo === null ? state : { ...state, retryInfo: null }

const hasSeenEvent = (state: AgentClientState, event: AgentEvent) =>
  event.eventId !== undefined && state.seenEventIds.includes(event.eventId)

const rememberEvent = (state: AgentClientState, event: AgentEvent): AgentClientState =>
  event.eventId === undefined
    ? state
    : { ...state, seenEventIds: [...state.seenEventIds, event.eventId] }

const toolRunId = (run: AgentToolRun) => {
  switch (run._tag) {
    case 'InputStreaming':
      return run.id
    case 'Denied':
      return run.toolCallId
    case 'QuestionRequested':
      return run.request.toolCallId
    case 'QuestionAnswered':
    case 'QuestionCancelled':
      return run.response.toolCallId
    case 'InputReady':
    case 'ApprovalRequested':
    case 'Executing':
    case 'Completed':
    case 'Errored':
    case 'ProviderCompleted':
      return run.call.id
  }
}

export const isActiveToolRun = (run: AgentToolRun) =>
  run._tag !== 'Completed' &&
  run._tag !== 'Errored' &&
  run._tag !== 'Denied' &&
  run._tag !== 'QuestionAnswered' &&
  run._tag !== 'QuestionCancelled' &&
  run._tag !== 'ProviderCompleted'

export const completedToolRuns = (runs: ReadonlyArray<AgentToolRun>) =>
  runs.filter(run => run._tag === 'Completed')

export const toolRunsFromHitlRequests = (
  requests: ReadonlyArray<HitlRequest>
): ReadonlyArray<AgentToolRun> =>
  requests.map(request => {
    switch (request._tag) {
      case 'QuestionRequest':
        return { _tag: 'QuestionRequested', request }
      case 'ToolApprovalRequest':
        return { _tag: 'ApprovalRequested', call: request.call, request }
    }
  })

const replaceToolRun = (
  runs: ReadonlyArray<AgentToolRun>,
  run: AgentToolRun
): ReadonlyArray<AgentToolRun> => {
  const id = toolRunId(run)
  const replaceIndex = runs.findIndex(current => toolRunId(current) === id)

  if (replaceIndex === -1) {
    return [...runs, run]
  }

  return runs.flatMap((current, index) => {
    if (toolRunId(current) !== id) {
      return [current]
    }

    return index === replaceIndex ? [run] : []
  })
}

const isStartedToolRun = (run: AgentToolRun): run is StartedAgentToolRun =>
  run._tag === 'Executing' || run._tag === 'Completed'

const startedAtMsFor = (runs: ReadonlyArray<AgentToolRun>, toolCallId: string) =>
  runs.filter(isStartedToolRun).find(run => run.call.id === toolCallId)?.startedAtMs

const appendToolInputDelta = (
  runs: ReadonlyArray<AgentToolRun>,
  id: string,
  delta: string
): ReadonlyArray<AgentToolRun> =>
  runs.map(run =>
    run._tag === 'InputStreaming' && run.id === id ? { ...run, input: `${run.input}${delta}` } : run
  )

const questionRequestForToolCall = (
  runs: ReadonlyArray<AgentToolRun>,
  toolCallId: string
): QuestionRequest | undefined =>
  runs.flatMap(run => {
    if (toolRunId(run) !== toolCallId) {
      return []
    }

    switch (run._tag) {
      case 'QuestionRequested':
        return [run.request]
      case 'QuestionAnswered':
      case 'QuestionCancelled':
        return run.request === undefined ? [] : [run.request]
      case 'InputStreaming':
      case 'InputReady':
      case 'ApprovalRequested':
      case 'Denied':
      case 'Executing':
      case 'Completed':
      case 'Errored':
      case 'ProviderCompleted':
        return []
    }
  })[0]

const questionAnsweredRun = (
  response: QuestionResponse,
  request: QuestionRequest | undefined
): AgentToolRun =>
  request === undefined
    ? { _tag: 'QuestionAnswered', response }
    : { _tag: 'QuestionAnswered', response, request }

const questionCancelledRun = (
  response: QuestionResponse,
  request: QuestionRequest | undefined
): AgentToolRun =>
  request === undefined
    ? { _tag: 'QuestionCancelled', response }
    : { _tag: 'QuestionCancelled', response, request }

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

  if (hasSeenEvent(state, event)) {
    return state
  }

  return rememberEvent(applyAgentEventUnchecked(state, event, nowMs), event)
}

const applyAgentEventUnchecked = (
  state: AgentClientState,
  event: AgentEvent,
  nowMs: number
): AgentClientState => {
  switch (event._tag) {
    case 'AgentStart':
      return {
        ...state,
        status: 'running',
        text: '',
        reasoning: '',
        liveMessages: [],
        toolRuns: completedToolRuns(state.toolRuns),
        error: null,
        errorInfo: null,
        retryInfo: null
      }
    case 'AgentError':
      return markAgentError(state, event.message, event)
    case 'LLMTextDelta':
      return clearRetryInfo({ ...state, text: `${state.text}${event.text}` })
    case 'LLMReasoningDelta':
      return clearRetryInfo({ ...state, reasoning: `${state.reasoning}${event.text}` })
    case 'ToolInputStart':
      return clearRetryInfo({
        ...state,
        toolRuns: replaceToolRun(state.toolRuns, {
          _tag: 'InputStreaming',
          id: event.id,
          name: event.name,
          input: ''
        })
      })
    case 'ToolInputDelta':
      return clearRetryInfo({
        ...state,
        toolRuns: appendToolInputDelta(state.toolRuns, event.id, event.delta)
      })
    case 'ToolInputEnd':
      return clearRetryInfo({
        ...state,
        toolRuns: replaceToolRun(state.toolRuns, { _tag: 'InputReady', call: event.call })
      })
    case 'ToolApprovalRequested':
      return {
        ...state,
        toolRuns: replaceToolRun(state.toolRuns, {
          _tag: 'ApprovalRequested',
          call: event.call,
          request: event.request
        })
      }
    case 'ToolApprovalGranted':
      return state
    case 'ToolApprovalDenied':
      return {
        ...state,
        toolRuns: replaceToolRun(state.toolRuns, {
          _tag: 'Denied',
          toolCallId: event.toolCallId,
          reason: event.reason
        })
      }
    case 'QuestionRequested':
      return {
        ...state,
        toolRuns: replaceToolRun(state.toolRuns, {
          _tag: 'QuestionRequested',
          request: event.request
        })
      }
    case 'QuestionAnswered':
      return {
        ...state,
        toolRuns: replaceToolRun(
          state.toolRuns,
          questionAnsweredRun(
            event.response,
            questionRequestForToolCall(state.toolRuns, event.response.toolCallId)
          )
        )
      }
    case 'QuestionCancelled':
      return {
        ...state,
        toolRuns: replaceToolRun(
          state.toolRuns,
          questionCancelledRun(
            event.response,
            questionRequestForToolCall(state.toolRuns, event.response.toolCallId)
          )
        )
      }
    case 'ToolExecutionStarted':
      return {
        ...state,
        toolRuns: replaceToolRun(state.toolRuns, {
          _tag: 'Executing',
          call: event.call,
          startedAtMs: nowMs
        })
      }
    case 'ToolExecutionCompleted': {
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
    case 'ToolExecutionError':
      return {
        ...state,
        toolRuns: replaceToolRun(state.toolRuns, {
          _tag: 'Errored',
          call: event.call,
          message: event.message,
          endedAtMs: nowMs
        })
      }
    case 'ProviderToolResult':
      return clearRetryInfo({
        ...state,
        toolRuns: replaceToolRun(state.toolRuns, {
          _tag: 'ProviderCompleted',
          call: event.call,
          result: event.result
        })
      })
    case 'UserMessage':
    case 'AssistantMessage':
      return clearRetryInfo({
        ...state,
        liveMessages: [...state.liveMessages, event.message],
        text: '',
        reasoning: ''
      })
    case 'AgentEnd':
      return {
        ...state,
        status: 'done',
        messages: [...state.messages, ...event.messages],
        liveMessages: [],
        text: '',
        reasoning: '',
        toolRuns: completedToolRuns(state.toolRuns),
        retryInfo: null
      }
    case 'AgentAwaitingInput':
      return {
        ...state,
        status: 'waiting',
        messages: [...state.messages, ...event.messages],
        liveMessages: [],
        text: '',
        reasoning: '',
        error: null,
        errorInfo: null,
        retryInfo: null
      }
    case 'AgentRetry':
      return { ...state, retryInfo: event }
    case 'CompactionEnd':
    case 'CompactionStart':
    case 'LLMStreamEnd':
    case 'LLMStreamStart':
    case 'SubagentCompleted':
    case 'SubagentStarted':
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
  error: null,
  errorInfo: null,
  retryInfo: null,
  seenEventIds: []
})

export const markAgentError = (
  state: AgentClientState,
  message = 'Agent request failed',
  errorInfo: AgentError | null = null
): AgentClientState => ({
  ...state,
  status: 'error',
  toolRuns: completedToolRuns(state.toolRuns),
  error: message,
  errorInfo,
  retryInfo: null
})

export const markAgentAborted = (state: AgentClientState): AgentClientState => ({
  ...state,
  status: 'aborted',
  toolRuns: completedToolRuns(state.toolRuns),
  error: null,
  errorInfo: null,
  retryInfo: null
})

export const reduceAgentEvents = (
  events: ReadonlyArray<AgentEvent>,
  initialState: AgentClientState = initialAgentClientState,
  options: ApplyAgentEventOptions = {}
) =>
  events.reduce((state, event) => applyAgentEventWithOptions(state, event, options), initialState)
