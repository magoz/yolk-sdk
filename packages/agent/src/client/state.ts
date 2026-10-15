import {
  AgentFailed,
  idleAgentStatus,
  nextAgentStatusTree,
  settleAgentStatusTree,
  startAgentStatusTree,
  type AgentError,
  type AgentEvent,
  type AgentMessage,
  type AgentStatus,
  type AgentStatusTree,
  type HitlRequest,
  type InputRequest,
  type InputResponse,
  type InteractionRequest,
  type InteractionResponse,
  type QuestionRequest,
  type QuestionResponse,
  type ToolCall,
  type ToolApprovalRequest,
  type ToolResult,
  type UserMessage
} from '@yolk-sdk/agent/protocol'
import { Data, Match, Predicate } from 'effect'
import * as Schema from 'effect/Schema'

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
  | { readonly _tag: 'InputRequested'; readonly request: InputRequest }
  | {
      readonly _tag: 'InputSubmitted'
      readonly response: InputResponse
      readonly request?: InputRequest
    }
  | {
      readonly _tag: 'InputCancelled'
      readonly response: InputResponse
      readonly request?: InputRequest
    }
  | { readonly _tag: 'InteractionRequested'; readonly request: InteractionRequest }
  | {
      readonly _tag: 'InteractionSubmitted'
      readonly response: InteractionResponse
      readonly request?: InteractionRequest
    }
  | {
      readonly _tag: 'InteractionCancelled'
      readonly response: InteractionResponse
      readonly request?: InteractionRequest
    }
  | {
      readonly _tag: 'Executing'
      readonly call: ToolCall
      readonly startedAtMs: number
      /** Preserve witnessed interaction acceptance across transport interruptions. */
      readonly interaction?: true
    }
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
  /** Run status; failures and pending retries live here (`Failed`, `Working(Retrying)`). */
  readonly status: AgentStatus
  readonly subagents: AgentStatusTree['subagents']
  readonly messages: ReadonlyArray<AgentMessage>
  readonly liveMessages: ReadonlyArray<AgentMessage>
  readonly text: string
  readonly reasoning: string
  readonly toolRuns: ReadonlyArray<AgentToolRun>
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
  status: idleAgentStatus,
  subagents: [],
  messages: [],
  liveMessages: [],
  text: '',
  reasoning: '',
  toolRuns: [],
  seenEventIds: []
}

const statusTree = (state: AgentClientState): AgentStatusTree => ({
  root: state.status,
  subagents: state.subagents
})

const withStatusTree = (state: AgentClientState, tree: AgentStatusTree): AgentClientState =>
  tree.root === state.status && tree.subagents === state.subagents
    ? state
    : { ...state, status: tree.root, subagents: tree.subagents }

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
    Match.tag('InputRequested', current => current.request.toolCallId),
    Match.tag('InputSubmitted', 'InputCancelled', current => current.response.toolCallId),
    Match.tag('InteractionRequested', current => current.request.toolCallId),
    Match.tag(
      'InteractionSubmitted',
      'InteractionCancelled',
      current => current.response.toolCallId
    ),
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
  !Predicate.isTagged(run, 'InputSubmitted') &&
  !Predicate.isTagged(run, 'InputCancelled') &&
  !Predicate.isTagged(run, 'InteractionCancelled') &&
  !Predicate.isTagged(run, 'ProviderCompleted')

export const completedToolRuns = (runs: ReadonlyArray<AgentToolRun>) =>
  runs.filter(run => Predicate.isTagged(run, 'Completed'))

// Retention is not completion: transport interruption cannot revoke witnessed acceptance.
const retainedSettledToolRuns = (runs: ReadonlyArray<AgentToolRun>) =>
  runs.filter(
    run =>
      Predicate.isTagged(run, 'Completed') ||
      Predicate.isTagged(run, 'Accepted') ||
      Predicate.isTagged(run, 'InteractionSubmitted') ||
      (Predicate.isTagged(run, 'Executing') && run.interaction === true)
  )

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
      Match.tag('InputRequest', current => AgentToolRun.InputRequested({ request: current })),
      Match.tag('InteractionRequest', current =>
        AgentToolRun.InteractionRequested({ request: current })
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
        'InputRequested',
        'InputSubmitted',
        'InputCancelled',
        'InteractionRequested',
        'InteractionSubmitted',
        'InteractionCancelled',
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

const inputRequestForToolCall = (
  runs: ReadonlyArray<AgentToolRun>,
  toolCallId: string
): InputRequest | undefined =>
  runs.flatMap(run => {
    if (toolRunId(run) !== toolCallId) {
      return []
    }

    return Match.value(run).pipe(
      Match.tag('InputRequested', current => [current.request]),
      Match.tag('InputSubmitted', 'InputCancelled', current =>
        current.request === undefined ? [] : [current.request]
      ),
      Match.tag(
        'InputStreaming',
        'InputReady',
        'InteractionRequested',
        'InteractionSubmitted',
        'InteractionCancelled',
        'ApprovalRequested',
        'Denied',
        'Executing',
        'Accepted',
        'Completed',
        'Errored',
        'ProviderCompleted',
        'QuestionRequested',
        'QuestionAnswered',
        'QuestionCancelled',
        () => []
      ),
      Match.exhaustive
    )
  })[0]

const inputSubmittedRun = (
  response: InputResponse,
  request: InputRequest | undefined
): AgentToolRun =>
  request === undefined
    ? AgentToolRun.InputSubmitted({ response })
    : AgentToolRun.InputSubmitted({ response, request })

const inputCancelledRun = (
  response: InputResponse,
  request: InputRequest | undefined
): AgentToolRun =>
  request === undefined
    ? AgentToolRun.InputCancelled({ response })
    : AgentToolRun.InputCancelled({ response, request })

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

const interactionSubmittedRun = (
  response: InteractionResponse,
  request: InteractionRequest | undefined
): AgentToolRun =>
  request === undefined
    ? AgentToolRun.InteractionSubmitted({ response })
    : AgentToolRun.InteractionSubmitted({ response, request })

const interactionCancelledRun = (
  response: InteractionResponse,
  request: InteractionRequest | undefined
): AgentToolRun =>
  request === undefined
    ? AgentToolRun.InteractionCancelled({ response })
    : AgentToolRun.InteractionCancelled({ response, request })

const interactionRequestForToolCall = (
  runs: ReadonlyArray<AgentToolRun>,
  toolCallId: string
): InteractionRequest | undefined =>
  runs.flatMap(run => {
    if (toolRunId(run) !== toolCallId) {
      return []
    }

    return Match.value(run).pipe(
      Match.tag('InteractionRequested', current => [current.request]),
      Match.tag('InteractionSubmitted', 'InteractionCancelled', current =>
        current.request === undefined ? [] : [current.request]
      ),
      Match.tag(
        'InputStreaming',
        'InputReady',
        'InputRequested',
        'InputSubmitted',
        'InputCancelled',
        'ApprovalRequested',
        'Denied',
        'Executing',
        'Accepted',
        'Completed',
        'Errored',
        'ProviderCompleted',
        'QuestionRequested',
        'QuestionAnswered',
        'QuestionCancelled',
        () => []
      ),
      Match.exhaustive
    )
  })[0]

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

  const activeCallId = activeEventToolCallId(event)

  if (activeCallId !== undefined && isAcknowledgedCall(state, activeCallId)) {
    // Hydration need not restore transient runs; the transcript itself is a replay fence.
    return rememberEvent(
      {
        ...state,
        toolRuns: state.toolRuns.filter(
          run => toolRunId(run) !== activeCallId || !isActiveToolRun(run)
        )
      },
      event
    )
  }

  return rememberEvent(
    withStatusTree(
      applyAgentEventUnchecked(state, event, nowMs),
      nextAgentStatusTree(statusTree(state), event)
    ),
    event
  )
}

const isAcknowledgedCall = (state: AgentClientState, toolCallId: string) => {
  const acknowledges = (message: AgentMessage) =>
    Predicate.isTagged(message, 'ToolResult') &&
    message.toolCallId === toolCallId &&
    message.acceptance !== undefined

  return state.messages.some(acknowledges) || state.liveMessages.some(acknowledges)
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
    Match.tag('InputRequested', current => current.request.toolCallId),
    Match.tag('InteractionRequested', current => current.request.toolCallId),
    Match.orElse(() => undefined)
  )

const applyAgentEventUnchecked = (
  state: AgentClientState,
  event: AgentEvent,
  nowMs: number
): AgentClientState =>
  Match.value(event)
    .pipe(
      Match.withReturnType<AgentClientState>(),
      Match.tag('AgentStart', () => ({
        ...state,
        text: '',
        reasoning: '',
        liveMessages: [],
        toolRuns: retainedSettledToolRuns(state.toolRuns)
      })),
      Match.tag('AgentError', () => ({
        ...state,
        toolRuns: retainedSettledToolRuns(state.toolRuns)
      })),
      Match.tag('LLMTextDelta', current => ({ ...state, text: `${state.text}${current.text}` })),
      Match.tag('LLMReasoningDelta', current => ({
        ...state,
        reasoning: `${state.reasoning}${current.text}`
      })),
      Match.tag('ToolInputStart', current => ({
        ...state,
        toolRuns: replaceToolRun(
          state.toolRuns,
          AgentToolRunInputStreaming.make({ id: current.id, name: current.name, input: '' })
        )
      })),
      Match.tag('ToolInputDelta', current => ({
        ...state,
        toolRuns: appendToolInputDelta(state.toolRuns, current.id, current.delta)
      })),
      Match.tag('ToolInputEnd', current => ({
        ...state,
        toolRuns: replaceToolRun(state.toolRuns, AgentToolRun.InputReady({ call: current.call }))
      })),
      Match.tag('LLMReasoningReplay', () => state),
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
      })),
      Match.tag('InputRequested', current => ({
        ...state,
        toolRuns: replaceToolRun(
          state.toolRuns,
          AgentToolRun.InputRequested({ request: current.request })
        )
      })),
      Match.tag('InteractionRequested', current => ({
        ...state,
        toolRuns: replaceToolRun(
          state.toolRuns,
          AgentToolRun.InteractionRequested({ request: current.request })
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
      Match.tag('InputSubmitted', current => ({
        ...state,
        toolRuns: replaceToolRun(
          state.toolRuns,
          inputSubmittedRun(
            current.response,
            inputRequestForToolCall(state.toolRuns, current.response.toolCallId)
          )
        )
      })),
      Match.tag('InputCancelled', current => ({
        ...state,
        toolRuns: replaceToolRun(
          state.toolRuns,
          inputCancelledRun(
            current.response,
            inputRequestForToolCall(state.toolRuns, current.response.toolCallId)
          )
        )
      })),
      Match.tag('InteractionSubmitted', current => ({
        ...state,
        toolRuns: replaceToolRun(
          state.toolRuns,
          interactionSubmittedRun(
            current.response,
            interactionRequestForToolCall(state.toolRuns, current.response.toolCallId)
          )
        )
      })),
      Match.tag('InteractionCancelled', current => ({
        ...state,
        toolRuns: replaceToolRun(
          state.toolRuns,
          interactionCancelledRun(
            current.response,
            interactionRequestForToolCall(state.toolRuns, current.response.toolCallId)
          )
        )
      })),
      Match.tag('ToolExecutionStarted', current => {
        const prior = state.toolRuns.find(run => toolRunId(run) === current.call.id)
        const executing = AgentToolRun.Executing({ call: current.call, startedAtMs: nowMs })

        const isInteraction =
          Predicate.isTagged(prior, 'InteractionSubmitted') ||
          (Predicate.isTagged(prior, 'Executing') && prior.interaction === true)

        return {
          ...state,
          toolRuns: replaceToolRun(
            state.toolRuns,
            isInteraction ? { ...executing, interaction: true } : executing
          )
        }
      }),
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
      Match.tag('ProviderToolResult', current => ({
        ...state,
        toolRuns: replaceToolRun(
          state.toolRuns,
          AgentToolRun.ProviderCompleted({ call: current.call, result: current.result })
        )
      })),
      Match.tag('UserMessage', 'AssistantMessage', current => ({
        ...state,
        liveMessages: [...state.liveMessages, current.message],
        text: '',
        reasoning: ''
      })),
      Match.tag('AgentEnd', current => ({
        ...state,
        messages: [...state.messages, ...current.messages],
        liveMessages: [],
        text: '',
        reasoning: '',
        toolRuns: retainedSettledToolRuns(state.toolRuns)
      })),
      Match.tag('AgentAwaitingInput', current => ({
        ...state,
        messages: [...state.messages, ...current.messages],
        liveMessages: [],
        text: '',
        reasoning: ''
      })),
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
        () => state
      ),
      Match.exhaustive
    )

export const submitAgentUserMessage = (
  state: AgentClientState,
  message: UserMessage
): AgentClientState =>
  withStatusTree(
    {
      ...state,
      messages: appendAgentMessage(state.messages, message),
      liveMessages: [],
      text: '',
      reasoning: '',
      toolRuns: retainedSettledToolRuns(state.toolRuns),
      seenEventIds: []
    },
    startAgentStatusTree(statusTree(state))
  )

/** Marks the run `Failed`, e.g. after a transport failure that produced no `AgentError` event. */
export const markAgentError = (
  state: AgentClientState,
  message = 'Agent request failed',
  error?: AgentError
): AgentClientState =>
  withStatusTree(
    { ...state, toolRuns: retainedSettledToolRuns(state.toolRuns) },
    settleAgentStatusTree(
      statusTree(state),
      error === undefined ? AgentFailed.make({ message }) : AgentFailed.make({ message, error })
    )
  )

/** The person stopped the run; per OSC 7501 a cancelled run is `Idle`. */
export const markAgentAborted = (state: AgentClientState): AgentClientState =>
  withStatusTree(
    { ...state, toolRuns: retainedSettledToolRuns(state.toolRuns) },
    settleAgentStatusTree(statusTree(state), idleAgentStatus)
  )

export const reduceAgentEvents = (
  events: ReadonlyArray<AgentEvent>,
  initialState: AgentClientState = initialAgentClientState,
  options: ApplyAgentEventOptions = {}
) =>
  events.reduce((state, event) => applyAgentEventWithOptions(state, event, options), initialState)
