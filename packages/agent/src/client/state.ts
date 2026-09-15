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
import { Data, Match, Predicate } from 'effect'
import * as Schema from 'effect/Schema'

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
      readonly _tag: 'Accepted'
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

export const AgentToolRun = Data.taggedEnum<AgentToolRun>()

type StartedAgentToolRun = Extract<
  AgentToolRun,
  { readonly _tag: 'Executing' | 'Accepted' | 'Completed' }
>

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

const AgentToolRunInputStreaming = Schema.TaggedStruct('InputStreaming', {
  id: Schema.String,
  name: Schema.UndefinedOr(Schema.String),
  input: Schema.String
})

const AgentToolRunDenied = Schema.TaggedStruct('Denied', {
  toolCallId: Schema.String,
  reason: Schema.String
})

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

const toolRunId = (run: AgentToolRun) =>
  Match.value(run).pipe(
    Match.tag('InputStreaming', current => current.id),
    Match.tag('Denied', current => current.toolCallId),
    Match.tag('QuestionRequested', current => current.request.toolCallId),
    Match.tag('QuestionAnswered', 'QuestionCancelled', current => current.response.toolCallId),
    Match.tag(
      'InputReady',
      'ApprovalRequested',
      'Executing',
      'Accepted',
      'Completed',
      'Errored',
      'ProviderCompleted',
      current => current.call.id
    ),
    Match.exhaustive
  )

export const isActiveToolRun = (run: AgentToolRun) =>
  !Predicate.isTagged(run, 'Accepted') &&
  !Predicate.isTagged(run, 'Completed') &&
  !Predicate.isTagged(run, 'Errored') &&
  !Predicate.isTagged(run, 'Denied') &&
  !Predicate.isTagged(run, 'QuestionAnswered') &&
  !Predicate.isTagged(run, 'QuestionCancelled') &&
  !Predicate.isTagged(run, 'ProviderCompleted')

export const completedToolRuns = (runs: ReadonlyArray<AgentToolRun>) =>
  runs.filter(run => Predicate.isTagged(run, 'Completed'))

// Retention is not completion: an acknowledgement remains replay-fenced between turns.
const retainedSettledToolRuns = (runs: ReadonlyArray<AgentToolRun>) =>
  runs.filter(run => Predicate.isTagged(run, 'Completed') || Predicate.isTagged(run, 'Accepted'))

export const toolRunsFromHitlRequests = (
  requests: ReadonlyArray<HitlRequest>
): ReadonlyArray<AgentToolRun> =>
  requests.map(request =>
    Match.value(request).pipe(
      Match.tag('QuestionRequest', current => AgentToolRun.QuestionRequested({ request: current })),
      Match.tag('ToolApprovalRequest', current =>
        AgentToolRun.ApprovalRequested({
          call: current.call,
          request: current
        })
      ),
      Match.exhaustive
    )
  )

const replaceToolRun = (
  runs: ReadonlyArray<AgentToolRun>,
  run: AgentToolRun
): ReadonlyArray<AgentToolRun> => {
  const id = toolRunId(run)
  const replaceIndex = runs.findIndex(current => toolRunId(current) === id)

  // Input/approval/Started replays without event ids cannot reopen an acknowledged call.
  if (runs[replaceIndex]?._tag === 'Accepted' && isActiveToolRun(run)) return runs

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
  Predicate.isTagged(run, 'Executing') ||
  Predicate.isTagged(run, 'Accepted') ||
  Predicate.isTagged(run, 'Completed')

const startedAtMsFor = (runs: ReadonlyArray<AgentToolRun>, toolCallId: string) =>
  runs.filter(isStartedToolRun).find(run => run.call.id === toolCallId)?.startedAtMs

const appendToolInputDelta = (
  runs: ReadonlyArray<AgentToolRun>,
  id: string,
  delta: string
): ReadonlyArray<AgentToolRun> =>
  runs.map(run =>
    Predicate.isTagged(run, 'InputStreaming') && run.id === id
      ? { ...run, input: `${run.input}${delta}` }
      : run
  )

const questionRequestForToolCall = (
  runs: ReadonlyArray<AgentToolRun>,
  toolCallId: string
): QuestionRequest | undefined =>
  runs.flatMap(run => {
    if (toolRunId(run) !== toolCallId) {
      return []
    }

    return Match.value(run).pipe(
      Match.tag('QuestionRequested', current => [current.request]),
      Match.tag('QuestionAnswered', 'QuestionCancelled', current =>
        current.request === undefined ? [] : [current.request]
      ),
      Match.tag(
        'InputStreaming',
        'InputReady',
        'ApprovalRequested',
        'Denied',
        'Executing',
        'Accepted',
        'Completed',
        'Errored',
        'ProviderCompleted',
        () => []
      ),
      Match.exhaustive
    )
  })[0]

const questionAnsweredRun = (
  response: QuestionResponse,
  request: QuestionRequest | undefined
): AgentToolRun =>
  request === undefined
    ? AgentToolRun.QuestionAnswered({ response })
    : AgentToolRun.QuestionAnswered({ response, request })

const questionCancelledRun = (
  response: QuestionResponse,
  request: QuestionRequest | undefined
): AgentToolRun =>
  request === undefined
    ? AgentToolRun.QuestionCancelled({ response })
    : AgentToolRun.QuestionCancelled({ response, request })

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

const activeEventToolCallId = (event: AgentEvent): string | undefined =>
  Match.value(event).pipe(
    Match.tag('ToolInputStart', 'ToolInputDelta', current => current.id),
    Match.tag(
      'ToolInputEnd',
      'ToolExecutionStarted',
      'ToolApprovalRequested',
      current => current.call.id
    ),
    Match.tag('QuestionRequested', current => current.request.toolCallId),
    Match.orElse(() => undefined)
  )

const applyAgentEventUnchecked = (
  state: AgentClientState,
  event: AgentEvent,
  nowMs: number
): AgentClientState => {
  const activeCallId = activeEventToolCallId(event)

  const acknowledgesActiveCall = (message: AgentMessage) =>
    Predicate.isTagged(message, 'ToolResult') &&
    message.toolCallId === activeCallId &&
    message.acceptance !== undefined

  if (
    activeCallId !== undefined &&
    (state.messages.some(acknowledgesActiveCall) || state.liveMessages.some(acknowledgesActiveCall))
  ) {
    // Hydration need not restore transient runs; the transcript itself is a replay fence.
    return {
      ...state,
      toolRuns: state.toolRuns.filter(
        run => toolRunId(run) !== activeCallId || !isActiveToolRun(run)
      )
    }
  }

  return Match.value(event)
    .pipe(
      Match.withReturnType<AgentClientState>(),
      Match.tag('AgentStart', () => ({
        ...state,
        status: 'running',
        text: '',
        reasoning: '',
        liveMessages: [],
        toolRuns: retainedSettledToolRuns(state.toolRuns),
        error: null,
        errorInfo: null,
        retryInfo: null
      })),
      Match.tag('AgentError', current => markAgentError(state, current.message, current)),
      Match.tag('LLMTextDelta', current =>
        clearRetryInfo({ ...state, text: `${state.text}${current.text}` })
      ),
      Match.tag('LLMReasoningDelta', current =>
        clearRetryInfo({ ...state, reasoning: `${state.reasoning}${current.text}` })
      ),
      Match.tag('ToolInputStart', current =>
        clearRetryInfo({
          ...state,
          toolRuns: replaceToolRun(
            state.toolRuns,
            AgentToolRunInputStreaming.make({ id: current.id, name: current.name, input: '' })
          )
        })
      ),
      Match.tag('ToolInputDelta', current =>
        clearRetryInfo({
          ...state,
          toolRuns: appendToolInputDelta(state.toolRuns, current.id, current.delta)
        })
      ),
      Match.tag('ToolInputEnd', current =>
        clearRetryInfo({
          ...state,
          toolRuns: replaceToolRun(state.toolRuns, AgentToolRun.InputReady({ call: current.call }))
        })
      ),
      Match.tag('ToolApprovalRequested', current => ({
        ...state,
        toolRuns: replaceToolRun(
          state.toolRuns,
          AgentToolRun.ApprovalRequested({
            call: current.call,
            request: current.request
          })
        )
      })),
      Match.tag('ToolApprovalGranted', () => state),
      Match.tag('ToolApprovalDenied', current => ({
        ...state,
        toolRuns: replaceToolRun(
          state.toolRuns,
          AgentToolRunDenied.make({ toolCallId: current.toolCallId, reason: current.reason })
        )
      })),
      Match.tag('QuestionRequested', current => ({
        ...state,
        toolRuns: replaceToolRun(
          state.toolRuns,
          AgentToolRun.QuestionRequested({ request: current.request })
        )
      }))
    )
    .pipe(
      Match.tag('QuestionAnswered', current => ({
        ...state,
        toolRuns: replaceToolRun(
          state.toolRuns,
          questionAnsweredRun(
            current.response,
            questionRequestForToolCall(state.toolRuns, current.response.toolCallId)
          )
        )
      })),
      Match.tag('QuestionCancelled', current => ({
        ...state,
        toolRuns: replaceToolRun(
          state.toolRuns,
          questionCancelledRun(
            current.response,
            questionRequestForToolCall(state.toolRuns, current.response.toolCallId)
          )
        )
      })),
      Match.tag('ToolExecutionStarted', current => ({
        ...state,
        toolRuns: replaceToolRun(
          state.toolRuns,
          AgentToolRun.Executing({ call: current.call, startedAtMs: nowMs })
        )
      })),
      Match.tag('ToolExecutionAccepted', 'ToolExecutionCompleted', current => {
        const endedAtMs = nowMs
        const startedAtMs = startedAtMsFor(state.toolRuns, current.call.id) ?? endedAtMs

        return {
          ...state,
          toolRuns: replaceToolRun(
            state.toolRuns,
            Predicate.isTagged(current, 'ToolExecutionAccepted')
              ? AgentToolRun.Accepted({
                  call: current.call,
                  result: current.result,
                  startedAtMs,
                  endedAtMs
                })
              : AgentToolRun.Completed({
                  call: current.call,
                  result: current.result,
                  startedAtMs,
                  endedAtMs
                })
          )
        }
      }),
      Match.tag('ToolExecutionError', current => ({
        ...state,
        toolRuns: replaceToolRun(
          state.toolRuns,
          AgentToolRun.Errored({
            call: current.call,
            message: current.message,
            endedAtMs: nowMs
          })
        )
      })),
      Match.tag('ProviderToolResult', current =>
        clearRetryInfo({
          ...state,
          toolRuns: replaceToolRun(
            state.toolRuns,
            AgentToolRun.ProviderCompleted({ call: current.call, result: current.result })
          )
        })
      ),
      Match.tag('UserMessage', 'AssistantMessage', current =>
        clearRetryInfo({
          ...state,
          liveMessages: [...state.liveMessages, current.message],
          text: '',
          reasoning: ''
        })
      ),
      Match.tag('AgentEnd', current => ({
        ...state,
        status: 'done',
        messages: [...state.messages, ...current.messages],
        liveMessages: [],
        text: '',
        reasoning: '',
        toolRuns: retainedSettledToolRuns(state.toolRuns),
        retryInfo: null
      })),
      Match.tag('AgentAwaitingInput', current => ({
        ...state,
        status: 'waiting',
        messages: [...state.messages, ...current.messages],
        liveMessages: [],
        text: '',
        reasoning: '',
        error: null,
        errorInfo: null,
        retryInfo: null
      })),
      Match.tag('AgentRetry', current => ({ ...state, retryInfo: current })),
      Match.tag(
        'CompactionEnd',
        'CompactionStart',
        'LLMStreamEnd',
        'LLMStreamStart',
        'SubagentCompleted',
        'SubagentStarted',
        'TurnEnd',
        'TurnStart',
        'UsageUpdate',
        () => state
      ),
      Match.exhaustive
    )
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
  toolRuns: retainedSettledToolRuns(state.toolRuns),
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
  toolRuns: retainedSettledToolRuns(state.toolRuns),
  error: message,
  errorInfo,
  retryInfo: null
})

export const markAgentAborted = (state: AgentClientState): AgentClientState => ({
  ...state,
  status: 'aborted',
  toolRuns: retainedSettledToolRuns(state.toolRuns),
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
