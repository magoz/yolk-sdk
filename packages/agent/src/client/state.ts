import {
  AgentAwaitingInput,
  AgentFailed,
  idleAgentStatus,
  isTerminalAgentEvent,
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
import { Array as Arr, Data, Equal, Match, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import {
  agentEventToolCallIds,
  disputedAgentTurns,
  recordAgentExecutionEvent,
  routeAgentExecutionEvent,
  type AgentExecution,
  type AgentExecutionRoute,
  type AgentExecutions
} from './executions.ts'

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
  | {
      readonly _tag: 'Denied'
      readonly toolCallId: string
      readonly reason: string
      /** The approval request it denies, when that was seen (it names the denied call). */
      readonly request?: ToolApprovalRequest
    }
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

/** What a model-step execution produced in client state, for removal when it is superseded. */
export type AgentClientExecutionOutput = Data.TaggedEnum<{
  LiveMessage: { readonly message: AgentMessage }
  /** A tool run it touched first; `prior` is the run it replaced, if any. */
  ToolRun: { readonly callId: string; readonly prior: Option.Option<AgentToolRun> }
}>

export const AgentClientExecutionOutput = Data.taggedEnum<AgentClientExecutionOutput>()

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
  /**
   * Tool runs in the order their calls appeared. Providers reuse call ids across turns, so a call id
   * can have one run per turn (see `turnStart`); reading them by id, the last run is the latest.
   */
  readonly toolRuns: ReadonlyArray<AgentToolRun>
  readonly seenEventIds: ReadonlyArray<string>
  /**
   * Model-step executions seen on this stream (events carrying `executionId`); a superseded one's
   * live messages and unacknowledged tool runs are removed. Absent in states built before it.
   */
  readonly executions?: AgentExecutions<AgentClientExecutionOutput>
  /**
   * The latest model turn's start (`AgentClientTurnStart`); carry it with `seenEventIds` and
   * `toolRuns`. `AgentStart` and a local submit set a run start (`runTurnStart`). Absent until a
   * start is seen and in states built before it: tool events then act on the last run holding a
   * call id, in any turn.
   */
  readonly turnStart?: AgentClientTurnStart
}

/**
 * Where the latest turn's runs start in `toolRuns`: a model turn's start
 * (`AgentClientModelTurnStart`) or a run's (`AgentClientRunStart`). Providers reuse tool call ids
 * across turns, so a turn's events act on its own runs, from `firstRun` on.
 */
export type AgentClientTurnStart = AgentClientModelTurnStart | AgentClientRunStart

/**
 * The start of the latest model turn the client state saw (its `LLMStreamStart`, with or without
 * `executionId`). The model's events (input, provider results) act only on its runs, so a later
 * turn's call reusing an id gets a run of its own; host events (requests, the tool batch, answers)
 * there first, else on the earlier run they replay (a replay without event id, or a batch event
 * after the next turn started): a request or batch event the last earlier run holding the same
 * call, an answer the last earlier run holding its request.
 */
export type AgentClientModelTurnStart = {
  /** The start's `streamId` (`''` when none). */
  readonly streamId: string
  readonly turn: number
  /** The index in `toolRuns` of the turn's first run; the runs before it are earlier turns'. */
  readonly firstRun: number
  /**
   * A terminal event or user message followed the start: a later start of the same turn number is
   * a new turn (a run that numbers its turns afresh), not a retry of this one.
   */
  readonly closed?: true
  readonly run?: undefined
  /**
   * The starts of the earlier turns seen since `AgentStart` (oldest first; absent in states built
   * before it), the run's start among them as turn `0`: each earlier turn's runs run from its
   * `firstRun` up to the next start's, so a reconciled earlier turn (`AgentAwaitingInput`,
   * `AgentEnd`) only changes its own runs.
   */
  readonly earlier?: ReadonlyArray<AgentClientEarlierTurnStart>
}

/**
 * A run's start (`AgentStart`, `submitAgentUserMessage`), before its first model turn: the runs
 * kept so far are earlier turns'. A resumed run's tool batch comes before its first model turn: its
 * host events reach those runs only as the same call or the request an answer answers, else add
 * runs of their own, so a provider's reused call id never lands on an earlier turn's call. The
 * model's events then replay an earlier run's (a run's own model output follows an
 * `LLMStreamStart`): they act on the runs before `firstRun` when one holds their id, else on the
 * run's own (a host that streams without `LLMStreamStart`). The run's first `LLMStreamStart` starts
 * a new turn (turn `0` in `earlier`).
 */
export type AgentClientRunStart = {
  /** The `AgentStart`'s `streamId` (`''` when none, and for a local submit). */
  readonly streamId: string
  /** The loop numbers model turns from 1. */
  readonly turn: 0
  /** The index in `toolRuns` of the run's first run. */
  readonly firstRun: number
  readonly closed?: undefined
  readonly run: true
  readonly earlier?: undefined
}

/** An earlier turn's start (`AgentClientModelTurnStart.earlier`). */
export type AgentClientEarlierTurnStart = {
  readonly streamId: string
  readonly turn: number
  /** The index in `toolRuns` of the turn's first run. */
  readonly firstRun: number
}

export type ApplyAgentEventOptions = {
  readonly nowMs?: number
}

const AgentToolRunInputStreaming = Schema.TaggedStruct('InputStreaming', {
  id: Schema.String,
  name: Schema.UndefinedOr(Schema.String),
  input: Schema.String
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
  seenEventIds: [],
  executions: []
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
const isRetainedToolRun = (run: AgentToolRun) =>
  Predicate.isTagged(run, 'Completed') ||
  Predicate.isTagged(run, 'Accepted') ||
  Predicate.isTagged(run, 'InteractionSubmitted') ||
  (Predicate.isTagged(run, 'Executing') && run.interaction === true)

/** The index of the latest turn's first run; `0` (every run) when no turn start is known. */
const turnFirstRun = (state: AgentClientState) =>
  state.turnStart === undefined
    ? 0
    : Math.min(Math.max(state.turnStart.firstRun, 0), state.toolRuns.length)

/**
 * Whether a run at `index` is one the model's events about `callId` may act on: the latest turn's.
 * Before a run's first model turn (`AgentClientRunStart`), a model event replays an earlier run's,
 * so the runs before the run's start come first when one holds the id; else the run's own (a host
 * that streams model events without `LLMStreamStart`). Never the resumed batch's run for an id an
 * earlier run holds.
 */
const modelRunScope = (state: AgentClientState, callId: string): ((index: number) => boolean) => {
  const from = turnFirstRun(state)

  const replays =
    state.turnStart?.run === true &&
    state.toolRuns.some((run, index) => index < from && toolRunId(run) === callId)

  return replays ? index => index < from : index => index >= from
}

/**
 * Starts a run (`AgentClientRunStart`): earlier turns' starts are dropped (`AgentStart` and a
 * submit leave no model-stream run of them to reconcile).
 */
const runTurnStart = (state: AgentClientState, streamId: string): AgentClientState => ({
  ...state,
  turnStart: { streamId, turn: 0, firstRun: state.toolRuns.length, run: true }
})

/**
 * Rewrites each run into none, itself or others, keeping the latest turn's start on the runs that
 * came from its runs.
 */
const flatMapToolRuns = (
  state: AgentClientState,
  rewrite: (run: AgentToolRun, index: number) => ReadonlyArray<AgentToolRun>
): AgentClientState => {
  const rewritten = state.toolRuns.map(rewrite)

  const unchanged = rewritten.every(
    (runs, index) => runs.length === 1 && runs[0] === state.toolRuns[index]
  )

  if (unchanged) return state

  const toolRuns = rewritten.flat()
  const turnStart = state.turnStart

  if (turnStart === undefined) return { ...state, toolRuns }

  // Where a run that was at `index` is now: after the runs the ones before it became.
  const moved = (index: number) =>
    rewritten.slice(0, Math.max(index, 0)).reduce((count, runs) => count + runs.length, 0)

  const firstRun = moved(turnFirstRun(state))

  return turnStart.earlier === undefined
    ? { ...state, toolRuns, turnStart: { ...turnStart, firstRun } }
    : {
        ...state,
        toolRuns,
        turnStart: {
          ...turnStart,
          firstRun,
          earlier: turnStart.earlier.map(start => ({ ...start, firstRun: moved(start.firstRun) }))
        }
      }
}

const retainSettledToolRuns = (state: AgentClientState) =>
  flatMapToolRuns(state, run => (isRetainedToolRun(run) ? [run] : []))

const findLastRunIndex = (
  runs: ReadonlyArray<AgentToolRun>,
  predicate: (run: AgentToolRun, index: number) => boolean
) => runs.reduce((last, run, index) => (predicate(run, index) ? index : last), -1)

const toolRunAt = (state: AgentClientState, index: number): AgentToolRun | undefined =>
  index < 0 ? undefined : state.toolRuns[index]

/** The call a run holds, when it holds one (`InputStreaming` holds only its id). */
const toolRunCall = (run: AgentToolRun): ToolCall | undefined =>
  Match.value(run).pipe(
    Match.tag('InputStreaming', () => undefined),
    Match.tag('Denied', current => current.request?.call),
    Match.tag(
      'QuestionRequested',
      'InputRequested',
      'InteractionRequested',
      current => current.request.call
    ),
    Match.tag(
      'QuestionAnswered',
      'QuestionCancelled',
      'InputSubmitted',
      'InputCancelled',
      'InteractionSubmitted',
      'InteractionCancelled',
      current => current.request?.call
    ),
    Match.tag(
      'InputReady',
      'ApprovalRequested',
      'Executing',
      'Accepted',
      'Completed',
      'Errored',
      'ProviderCompleted',
      current => current.call
    ),
    Match.exhaustive
  )

/** The request a run carries (pending or answered), if any. */
const toolRunRequestId = (run: AgentToolRun): string | undefined =>
  Match.value(run).pipe(
    Match.tag('ApprovalRequested', 'Denied', current => current.request?.requestId),
    Match.tag(
      'QuestionRequested',
      'InputRequested',
      'InteractionRequested',
      current => current.request.requestId
    ),
    Match.tag(
      'QuestionAnswered',
      'QuestionCancelled',
      'InputSubmitted',
      'InputCancelled',
      'InteractionSubmitted',
      'InteractionCancelled',
      current => current.response.requestId
    ),
    Match.tag(
      'InputStreaming',
      'InputReady',
      'Executing',
      'Accepted',
      'Completed',
      'Errored',
      'ProviderCompleted',
      () => undefined
    ),
    Match.exhaustive
  )

/**
 * Whether a run is the one a host event replays: `true`, `false` (it is another call, or holds
 * another request), or `undefined` when the run does not say (an input still streaming, a call
 * before its request).
 */
type ReplayedRun = (run: AgentToolRun) => boolean | undefined

/** A request or tool-batch event replays the run holding the same call it names. */
const sameCall =
  (call: ToolCall): ReplayedRun =>
  run => {
    const held = toolRunCall(run)

    return held === undefined ? undefined : Equal.equals(held, call)
  }

/** An answer replays the run holding the request it answers. */
const answeredRequest =
  (requestId: string): ReplayedRun =>
  run => {
    const held = toolRunRequestId(run)

    return held === undefined ? undefined : held === requestId
  }

/** A denial replays a pending approval. */
const pendingApproval: ReplayedRun = run =>
  Predicate.isTagged(run, 'ApprovalRequested') ? true : undefined

/**
 * The run an event about a call acts on (`-1`: none): the last run of the latest turn holding the
 * call; else, for a host event (`replayed`), the last earlier run it replays. The latest turn's run
 * also gives way to that earlier run when it is known to be another call or to hold another request
 * (a replay without event id of an earlier turn's event, after a later turn reused the id). The
 * model's events (`replayed` absent) never act on an earlier turn's run: a later call reusing the
 * id is another (before a run's first model turn, an earlier run's first: `modelRunScope`).
 */
const toolRunIndex = (
  state: AgentClientState,
  callId: string,
  replayed: ReplayedRun | undefined
) => {
  if (replayed === undefined) {
    const inScope = modelRunScope(state, callId)

    return findLastRunIndex(
      state.toolRuns,
      (run, runIndex) => inScope(runIndex) && toolRunId(run) === callId
    )
  }

  const from = turnFirstRun(state)

  const index = findLastRunIndex(
    state.toolRuns,
    (run, runIndex) => runIndex >= from && toolRunId(run) === callId
  )

  const current = toolRunAt(state, index)

  if (current !== undefined && replayed(current) !== false) return index

  const earlier = findLastRunIndex(
    state.toolRuns,
    (run, runIndex) => runIndex < from && toolRunId(run) === callId && replayed(run) === true
  )

  return earlier === -1 ? index : earlier
}

/**
 * Where an answer goes: the run it acts on, a new run in the latest turn (`-1`: the turn lacks the
 * call and no earlier run holds its request, for example a resumed run's answer whose pending run
 * `AgentStart` dropped; an earlier turn's call reusing the id is another call), or none.
 */
const answerRunIndex = (
  state: AgentClientState,
  callId: string,
  replayed: ReplayedRun
): Option.Option<number> => {
  const index = toolRunIndex(state, callId, replayed)
  const run = toolRunAt(state, index)

  if (run === undefined) return Option.some(-1)

  // The latest turn's run of the call holds another request, and no run holds this one: a stale
  // answer (its request's run was never seen, for example after hydration) answers nothing here.
  return replayed(run) === false ? Option.none() : Option.some(index)
}

/** A pending human request: approval, question, typed input or interaction. */
const isRequestToolRun = (run: AgentToolRun) =>
  Predicate.isTagged(run, 'ApprovalRequested') ||
  Predicate.isTagged(run, 'QuestionRequested') ||
  Predicate.isTagged(run, 'InputRequested') ||
  Predicate.isTagged(run, 'InteractionRequested')

/**
 * Whether a call is past its human request: the request answered or cancelled, the approval
 * denied, or the call finished (completed, accepted, errored, provider result). Before it: the
 * model's stream, pending requests, and a running call: a run that stopped (aborted, failed or
 * paused) while the call ran is resumed by asking the same call again (an approval, an
 * interaction under the same request id), which must apply.
 */
const isPastRequestToolRun = (run: AgentToolRun): boolean =>
  Match.value(run).pipe(
    Match.tag(
      'InputStreaming',
      'InputReady',
      'ApprovalRequested',
      'QuestionRequested',
      'InputRequested',
      'InteractionRequested',
      'Executing',
      () => false
    ),
    Match.tag(
      'Denied',
      'QuestionAnswered',
      'QuestionCancelled',
      'InputSubmitted',
      'InputCancelled',
      'InteractionSubmitted',
      'InteractionCancelled',
      'Completed',
      'Accepted',
      'Errored',
      'ProviderCompleted',
      () => true
    ),
    Match.exhaustive
  )

/** A finished call the tool batch ran: a replayed start of it must not reopen it. */
const isFinishedToolRun = (run: AgentToolRun) =>
  Predicate.isTagged(run, 'Completed') ||
  Predicate.isTagged(run, 'Accepted') ||
  Predicate.isTagged(run, 'Errored')

/**
 * Whether a call's run keeps its state when an event sets `run`:
 *
 * - an accepted call ignores active runs (replays of its input, request or start);
 * - a completed or errored call ignores a start of the same call (a replayed tool-batch event);
 * - a call past its request ignores a request for the same call (id, name and arguments equal).
 *   The loop asks for a call only until it settles: an invalid input re-pends the same request
 *   while the run still pends, a stopped run asks a running call again, and a later turn reusing
 *   the id asks on its own run. So such a request, with or without event id, is a replay; a
 *   request naming another call with the id is that call's and applies, as does one reaching a
 *   run that does not know its call (an answer whose request was never seen).
 */
const keepsToolRun = (current: AgentToolRun, run: AgentToolRun) => {
  if (Predicate.isTagged(current, 'Accepted') && isActiveToolRun(run)) return true

  if (Predicate.isTagged(run, 'Executing')) {
    return isFinishedToolRun(current) && sameCall(run.call)(current) === true
  }

  const requested = isRequestToolRun(run) ? toolRunCall(run) : undefined

  return (
    requested !== undefined &&
    isPastRequestToolRun(current) &&
    sameCall(requested)(current) === true
  )
}

/**
 * Sets the run at `index`, or adds `run` to the latest turn (`-1`), unless the current run keeps
 * its state (`keepsToolRun`).
 */
const putToolRun = (
  state: AgentClientState,
  index: number,
  run: AgentToolRun
): AgentClientState => {
  const current = toolRunAt(state, index)

  if (current === undefined) return { ...state, toolRuns: [...state.toolRuns, run] }

  if (keepsToolRun(current, run)) return state

  return {
    ...state,
    toolRuns: state.toolRuns.map((existing, runIndex) => (runIndex === index ? run : existing))
  }
}

/** Sets the run of a call a model event acts on (in the latest turn), or adds it there. */
const putModelToolRun = (state: AgentClientState, run: AgentToolRun) =>
  putToolRun(state, toolRunIndex(state, toolRunId(run), undefined), run)

/** Sets the run of the call a request or tool-batch event names, or adds it to the latest turn. */
const putHostToolRun = (state: AgentClientState, call: ToolCall, run: AgentToolRun) =>
  putToolRun(state, toolRunIndex(state, call.id, sameCall(call)), run)

/** Sets the run an answer acts on (`answerRunIndex`) to what `answered` makes of it. */
const putAnswerToolRun = (
  state: AgentClientState,
  callId: string,
  replayed: ReplayedRun,
  answered: (current: AgentToolRun | undefined) => AgentToolRun
) =>
  Option.match(answerRunIndex(state, callId, replayed), {
    onNone: () => state,
    onSome: index => putToolRun(state, index, answered(toolRunAt(state, index)))
  })

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

const isStartedToolRun = (run: AgentToolRun): run is StartedAgentToolRun =>
  Predicate.isTagged(run, 'Executing') ||
  Predicate.isTagged(run, 'Accepted') ||
  Predicate.isTagged(run, 'Completed')

const questionRequestOf = (run: AgentToolRun | undefined): QuestionRequest | undefined =>
  run === undefined
    ? undefined
    : Match.value(run).pipe(
        Match.tag('QuestionRequested', current => current.request),
        Match.tag('QuestionAnswered', 'QuestionCancelled', current => current.request),
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
          () => undefined
        ),
        Match.exhaustive
      )

const inputRequestOf = (run: AgentToolRun | undefined): InputRequest | undefined =>
  run === undefined
    ? undefined
    : Match.value(run).pipe(
        Match.tag('InputRequested', current => current.request),
        Match.tag('InputSubmitted', 'InputCancelled', current => current.request),
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
          () => undefined
        ),
        Match.exhaustive
      )

/** The approval request a run carries (pending, or the one a denial denied). */
const approvalRequestOf = (run: AgentToolRun | undefined): ToolApprovalRequest | undefined =>
  Predicate.isTagged(run, 'ApprovalRequested') || Predicate.isTagged(run, 'Denied')
    ? run.request
    : undefined

const deniedRun = (
  toolCallId: string,
  reason: string,
  request: ToolApprovalRequest | undefined
): AgentToolRun =>
  request === undefined
    ? AgentToolRun.Denied({ toolCallId, reason })
    : AgentToolRun.Denied({ toolCallId, reason, request })

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

const interactionRequestOf = (run: AgentToolRun | undefined): InteractionRequest | undefined =>
  run === undefined
    ? undefined
    : Match.value(run).pipe(
        Match.tag('InteractionRequested', current => current.request),
        Match.tag('InteractionSubmitted', 'InteractionCancelled', current => current.request),
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
          () => undefined
        ),
        Match.exhaustive
      )

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

  const executions = state.executions ?? []
  const route = routeAgentExecutionEvent(executions, event)

  if (Predicate.isTagged(route, 'Drop')) {
    const recorded = recordAgentExecutionEvent(executions, event, route, [])

    return rememberEvent(
      recorded === executions ? state : { ...state, executions: recorded },
      event
    )
  }

  if (Predicate.isTagged(route, 'Stale')) {
    return rememberEvent({ ...state, executions: route.executions }, event)
  }

  // Latest first: a later execution's run replaced an earlier one's, which it restores first.
  const started = Predicate.isTagged(route, 'Start')
    ? discardExecutionOutput(state, [...route.superseded].reverse(), event.streamId ?? '')
    : state

  // The terminal's messages are the committed transcript; a turn that showed another execution's
  // answer also drops that execution's unacknowledged tool runs.
  const routed =
    Predicate.isTagged(event, 'AgentEnd') || Predicate.isTagged(event, 'AgentAwaitingInput')
      ? discardExecutionOutput(
          started,
          disputedAgentTurns(executions, event).map(turn => turn.shown),
          event.streamId
        )
      : started

  const owner = Predicate.isTagged(route, 'Owned')
    ? route.execution
    : Predicate.isTagged(route, 'Start')
      ? route.started
      : undefined

  const applied = nextTurnStart(applyAgentEventRouted(routed, event, nowMs), event, route)
  const before = Predicate.isTagged(route, 'Start') ? route.executions : executions

  const after = recordAgentExecutionEvent(
    before,
    event,
    route,
    owner === undefined ? [] : executionOutput(owner, event, routed, applied)
  )

  return after === executions ? applied : { ...applied, executions: after }
}

/**
 * The latest turn's start after an event: an `LLMStreamStart` (tagged or not) starts a turn whose
 * runs follow the current ones, unless it retries the latest turn (same stream and turn, no
 * terminal event or user message since), which keeps its start and runs; a terminal event or user
 * message closes the start to retries; `AgentStart` sets a run start (`runTurnStart`; a run's turns
 * are numbered afresh).
 */
const nextTurnStart = (
  state: AgentClientState,
  event: AgentEvent,
  route: AgentExecutionRoute<AgentClientExecutionOutput>
): AgentClientState => {
  if (Predicate.isTagged(event, 'AgentStart')) return runTurnStart(state, event.streamId ?? '')

  const latest = state.turnStart

  if (isTerminalAgentEvent(event) || Predicate.isTagged(event, 'UserMessage')) {
    // A run start already starts the run's first model turn afresh.
    return latest === undefined || latest.run === true || latest.closed === true
      ? state
      : { ...state, turnStart: { ...latest, closed: true } }
  }

  if (!Predicate.isTagged(event, 'LLMStreamStart') || Predicate.isTagged(route, 'Owned')) {
    return state
  }

  const streamId = event.streamId ?? ''

  const retried =
    latest !== undefined &&
    latest.run !== true &&
    latest.closed !== true &&
    latest.streamId === streamId &&
    latest.turn === event.turn

  if (retried) return state

  const started = { streamId, turn: event.turn, firstRun: state.toolRuns.length }

  return latest === undefined
    ? { ...state, turnStart: started }
    : {
        ...state,
        turnStart: {
          ...started,
          earlier: [
            ...(latest.earlier ?? []),
            { streamId: latest.streamId, turn: latest.turn, firstRun: turnFirstRun(state) }
          ]
        }
      }
}

/**
 * What an execution's event produced: its `AssistantMessage`, and each tool run of its turn it
 * touched first, with the run it replaced (a provider can reuse a call id within a turn), so removal
 * can restore it.
 */
const executionOutput = (
  execution: AgentExecution<AgentClientExecutionOutput>,
  event: AgentEvent,
  before: AgentClientState,
  after: AgentClientState
): ReadonlyArray<AgentClientExecutionOutput> => {
  const touched = new Set(
    execution.output.flatMap(output =>
      Predicate.isTagged(output, 'ToolRun') ? [output.callId] : []
    )
  )

  // An execution's events are the model's: they act on the latest turn's runs only.
  const runs = agentEventToolCallIds(event).flatMap(callId => {
    if (touched.has(callId)) return []

    const prior = Option.fromNullishOr(toolRunAt(before, toolRunIndex(before, callId, undefined)))
    const exists = toolRunIndex(after, callId, undefined) !== -1

    return Option.isSome(prior) || exists
      ? [AgentClientExecutionOutput.ToolRun({ callId, prior })]
      : []
  })

  return Predicate.isTagged(event, 'AssistantMessage')
    ? [AgentClientExecutionOutput.LiveMessage({ message: event.message }), ...runs]
    : runs
}

/**
 * A superseded execution's output, or one the step did not commit, is provisional: its live
 * messages, and the tool runs of its turn it touched that no other event acknowledged and only the
 * model's stream changed (restored to the run they replaced, else removed). `discarded` comes
 * latest first.
 */
const discardExecutionOutput = (
  state: AgentClientState,
  discarded: ReadonlyArray<AgentExecution<AgentClientExecutionOutput>>,
  streamId: string | undefined
): AgentClientState => {
  if (discarded.length === 0) return state

  const messages = new Set(
    discarded
      .flatMap(execution => execution.output)
      .flatMap(output => (Predicate.isTagged(output, 'LiveMessage') ? [output.message] : []))
  )

  return discarded.reduce<AgentClientState>(
    (current, execution) => discardExecutionToolRuns(current, execution, streamId),
    {
      ...state,
      text: '',
      reasoning: '',
      liveMessages: state.liveMessages.filter(message => !messages.has(message))
    }
  )
}

const discardExecutionToolRuns = (
  state: AgentClientState,
  execution: AgentExecution<AgentClientExecutionOutput>,
  streamId: string | undefined
): AgentClientState => {
  const unacknowledged = new Set(execution.calls)

  const priors = new Map(
    execution.output.flatMap(
      (output): ReadonlyArray<readonly [string, Option.Option<AgentToolRun>]> =>
        Predicate.isTagged(output, 'ToolRun') && unacknowledged.has(output.callId)
          ? [[output.callId, output.prior]]
          : []
    )
  )

  if (priors.size === 0) return state

  const inTurn = executionTurnRuns(state, execution.turn, streamId)

  return flatMapToolRuns(state, (run, index) => {
    const prior = inTurn(index) ? priors.get(toolRunId(run)) : undefined

    // A run a host event set belongs to a later call that reused the id: it stays.
    return prior === undefined || !isModelToolRun(run) ? [run] : Option.toArray(prior)
  })
}

/**
 * The runs of an execution's turn (of the run `streamId`, any run when absent): the latest turn's
 * when it is the latest start's turn; an earlier turn's from its start up to the next start's;
 * every run when no start is known; none for an earlier turn whose start this state did not see.
 */
const executionTurnRuns = (
  state: AgentClientState,
  turn: number,
  streamId: string | undefined
): ((index: number) => boolean) => {
  const latest = state.turnStart

  if (latest === undefined) return () => true

  const from = turnFirstRun(state)

  const sameRun = (start: { readonly streamId: string }) =>
    streamId === undefined || start.streamId === streamId

  if (latest.turn === turn && sameRun(latest)) return index => index >= from

  const earlier = latest.earlier ?? []

  const position = earlier.reduce(
    (found, start, index) => (start.turn === turn && sameRun(start) ? index : found),
    -1
  )

  const start = position === -1 ? undefined : earlier[position]

  if (start === undefined) return () => false

  const end = earlier[position + 1]?.firstRun ?? from

  return index => index >= start.firstRun && index < end
}

/** A run only the model's stream produced (its input, a call, a provider result). */
const isModelToolRun = (run: AgentToolRun) =>
  Predicate.isTagged(run, 'InputStreaming') ||
  Predicate.isTagged(run, 'InputReady') ||
  Predicate.isTagged(run, 'ProviderCompleted')

const applyAgentEventRouted = (
  state: AgentClientState,
  event: AgentEvent,
  nowMs: number
): AgentClientState => {
  const replay = acknowledgedReplay(state, event)

  if (Option.isSome(replay)) {
    // Hydration need not restore transient runs; the transcript itself is a replay fence.
    return rememberEvent(
      flatMapToolRuns(state, (run, index) => (replay.value(run, index) ? [] : [run])),
      event
    )
  }

  const applied = applyAgentEventUnchecked(state, event, nowMs)
  const statusEvent = eventForStatus(applied, event)

  return rememberEvent(
    statusEvent === undefined
      ? applied
      : withStatusTree(applied, nextAgentStatusTree(statusTree(state), statusEvent)),
    event
  )
}

/** The run a host event naming `call` acts on (`toolRunIndex`), if any. */
const hostToolRun = (state: AgentClientState, call: ToolCall) =>
  toolRunAt(state, toolRunIndex(state, call.id, sameCall(call)))

/** Whether the run of `call` is that call, past its request (`isPastRequestToolRun`). */
const isPastRequestCall = (state: AgentClientState, call: ToolCall) => {
  const run = hostToolRun(state, call)

  return run !== undefined && isPastRequestToolRun(run) && sameCall(call)(run) === true
}

/** Whether the run of `call` is that call, finished (`isFinishedToolRun`). */
const isFinishedCall = (state: AgentClientState, call: ToolCall) => {
  const run = hostToolRun(state, call)

  return run !== undefined && isFinishedToolRun(run) && sameCall(call)(run) === true
}

/**
 * The event the run's status follows, `undefined` when it must not move it, decided from the
 * result (`applied`): a start of a call already finished is a replay the state kept; a pause blocks
 * only on its requests still pending, none (status unchanged) when every one names a call past its
 * request (request events themselves never move the status).
 */
const eventForStatus = (applied: AgentClientState, event: AgentEvent): AgentEvent | undefined => {
  if (Predicate.isTagged(event, 'ToolExecutionStarted')) {
    return isFinishedCall(applied, event.call) ? undefined : event
  }

  if (!Predicate.isTagged(event, 'AgentAwaitingInput')) return event

  const pending = event.requests.filter(request => !isPastRequestCall(applied, request.call))

  if (pending.length === event.requests.length) return event

  if (!Arr.isReadonlyArrayNonEmpty(pending)) return undefined

  return AgentAwaitingInput.make({ ...event, requests: pending })
}

/**
 * Whether an event that opens a run (input, a request, a start) replays a call the transcript
 * acknowledged (an accepted background call), and then which stale active runs to drop. With no
 * turn start known (for the model's events, also a run start), any such event about an
 * acknowledged id replays it. Otherwise the model's events and events about the call the latest
 * turn holds under the id are that turn's own call (providers reuse ids across turns); another host
 * event replays it when it names the call the transcript acknowledged.
 */
const acknowledgedReplay = (
  state: AgentClientState,
  event: AgentEvent
): Option.Option<(run: AgentToolRun, index: number) => boolean> => {
  const callId = activeEventToolCallId(event)

  if (callId === undefined) return Option.none()

  const acknowledged = acknowledgedToolCalls(state, callId)

  if (acknowledged.length === 0) return Option.none()

  const call = hostEventToolCall(event)

  // No model turn start known for this event (none seen, or a model event before a run's first
  // model turn): any event about the id replays it.
  if (state.turnStart === undefined) {
    return Option.some(run => toolRunId(run) === callId && isActiveToolRun(run))
  }

  const from = turnFirstRun(state)

  // A model event before a run's first model turn replays an earlier run's: it drops only the
  // earlier runs' stale active runs, never the resumed batch's.
  if (call === undefined && state.turnStart.run === true) {
    return Option.some(
      (run, index) => index < from && toolRunId(run) === callId && isActiveToolRun(run)
    )
  }

  if (call === undefined) return Option.none()

  const current = toolRunAt(
    state,
    findLastRunIndex(state.toolRuns, (run, index) => index >= from && toolRunId(run) === callId)
  )

  const same = sameCall(call)

  // The latest turn's run of this call (or one that does not say which call it is).
  if (current !== undefined && same(current) !== false) return Option.none()

  // An acknowledgement whose call the transcript lacks fences the id, as before turns were known.
  const replays = acknowledged.some(held =>
    Option.match(held, { onNone: () => true, onSome: named => Equal.equals(named, call) })
  )

  return replays
    ? Option.some((run, index) => index < from && isActiveToolRun(run) && same(run) === true)
    : Option.none()
}

/**
 * The calls the transcript acknowledges under an id (a `ToolResult` with `acceptance`), each the
 * last host call with the id before its result, when there is one.
 */
const acknowledgedToolCalls = (
  state: AgentClientState,
  toolCallId: string
): ReadonlyArray<Option.Option<ToolCall>> => {
  const messages = [...state.messages, ...state.liveMessages]

  const hostCalls = (message: AgentMessage): ReadonlyArray<ToolCall> =>
    Predicate.isTagged(message, 'Assistant')
      ? message.parts.flatMap(part =>
          Predicate.isTagged(part, 'HostToolCall') && part.call.id === toolCallId ? [part.call] : []
        )
      : []

  return messages.flatMap((message, index) =>
    Predicate.isTagged(message, 'ToolResult') &&
    message.toolCallId === toolCallId &&
    message.acceptance !== undefined
      ? [Option.fromNullishOr(messages.slice(0, index).flatMap(hostCalls).at(-1))]
      : []
  )
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

/** The call a host event that opens a run names (a request, the tool batch's start). */
const hostEventToolCall = (event: AgentEvent): ToolCall | undefined =>
  Match.value(event).pipe(
    Match.tag('ToolExecutionStarted', 'ToolApprovalRequested', current => current.call),
    Match.tag(
      'QuestionRequested',
      'InputRequested',
      'InteractionRequested',
      current => current.request.call
    ),
    Match.orElse(() => undefined)
  )

/**
 * A model response ends with its `AssistantMessage`, so output still streaming when the next one
 * starts belongs to a superseded execution (a retried or redelivered model step): drop it.
 */
const discardUnfinishedStream = (state: AgentClientState): AgentClientState => {
  const streamed = flatMapToolRuns(state, run =>
    Predicate.isTagged(run, 'InputStreaming') ? [] : [run]
  )

  return state.text === '' && state.reasoning === '' && streamed === state
    ? state
    : { ...streamed, text: '', reasoning: '' }
}

/** Appends streamed input to the latest turn's run of the call. */
const appendToolInputDelta = (state: AgentClientState, id: string, delta: string) => {
  const inScope = modelRunScope(state, id)

  return flatMapToolRuns(state, (run, index) =>
    inScope(index) && Predicate.isTagged(run, 'InputStreaming') && run.id === id
      ? [{ ...run, input: `${run.input}${delta}` }]
      : [run]
  )
}

const applyAgentEventUnchecked = (
  state: AgentClientState,
  event: AgentEvent,
  nowMs: number
): AgentClientState =>
  Match.value(event)
    .pipe(
      Match.withReturnType<AgentClientState>(),
      Match.tag('AgentStart', () => ({
        ...retainSettledToolRuns(state),
        text: '',
        reasoning: '',
        liveMessages: []
      })),
      Match.tag('AgentError', () => retainSettledToolRuns(state)),
      Match.tag('LLMTextDelta', current => ({ ...state, text: `${state.text}${current.text}` })),
      Match.tag('LLMReasoningDelta', current => ({
        ...state,
        reasoning: `${state.reasoning}${current.text}`
      })),
      Match.tag('ToolInputStart', current =>
        putModelToolRun(
          state,
          AgentToolRunInputStreaming.make({ id: current.id, name: current.name, input: '' })
        )
      ),
      Match.tag('ToolInputDelta', current =>
        appendToolInputDelta(state, current.id, current.delta)
      ),
      Match.tag('ToolInputEnd', current =>
        putModelToolRun(state, AgentToolRun.InputReady({ call: current.call }))
      ),
      Match.tag('LLMReasoningReplay', () => state),
      Match.tag('ToolApprovalRequested', current =>
        putHostToolRun(
          state,
          current.call,
          AgentToolRun.ApprovalRequested({ call: current.call, request: current.request })
        )
      ),
      Match.tag('ToolApprovalGranted', () => state),
      Match.tag('ToolApprovalDenied', current =>
        putAnswerToolRun(state, current.toolCallId, pendingApproval, run =>
          deniedRun(current.toolCallId, current.reason, approvalRequestOf(run))
        )
      ),
      Match.tag('QuestionRequested', current =>
        putHostToolRun(
          state,
          current.request.call,
          AgentToolRun.QuestionRequested({ request: current.request })
        )
      ),
      Match.tag('InputRequested', current =>
        putHostToolRun(
          state,
          current.request.call,
          AgentToolRun.InputRequested({ request: current.request })
        )
      ),
      Match.tag('InteractionRequested', current =>
        putHostToolRun(
          state,
          current.request.call,
          AgentToolRun.InteractionRequested({ request: current.request })
        )
      )
    )
    .pipe(
      Match.tag('QuestionAnswered', current =>
        putAnswerToolRun(
          state,
          current.response.toolCallId,
          answeredRequest(current.response.requestId),
          run => questionAnsweredRun(current.response, questionRequestOf(run))
        )
      ),
      Match.tag('QuestionCancelled', current =>
        putAnswerToolRun(
          state,
          current.response.toolCallId,
          answeredRequest(current.response.requestId),
          run => questionCancelledRun(current.response, questionRequestOf(run))
        )
      ),
      Match.tag('InputSubmitted', current =>
        putAnswerToolRun(
          state,
          current.response.toolCallId,
          answeredRequest(current.response.requestId),
          run => inputSubmittedRun(current.response, inputRequestOf(run))
        )
      ),
      Match.tag('InputCancelled', current =>
        putAnswerToolRun(
          state,
          current.response.toolCallId,
          answeredRequest(current.response.requestId),
          run => inputCancelledRun(current.response, inputRequestOf(run))
        )
      ),
      Match.tag('InteractionSubmitted', current =>
        putAnswerToolRun(
          state,
          current.response.toolCallId,
          answeredRequest(current.response.requestId),
          run => interactionSubmittedRun(current.response, interactionRequestOf(run))
        )
      ),
      Match.tag('InteractionCancelled', current =>
        putAnswerToolRun(
          state,
          current.response.toolCallId,
          answeredRequest(current.response.requestId),
          run => interactionCancelledRun(current.response, interactionRequestOf(run))
        )
      ),
      Match.tag('ToolExecutionStarted', current => {
        const index = toolRunIndex(state, current.call.id, sameCall(current.call))
        const prior = toolRunAt(state, index)
        const executing = AgentToolRun.Executing({ call: current.call, startedAtMs: nowMs })

        const isInteraction =
          Predicate.isTagged(prior, 'InteractionSubmitted') ||
          (Predicate.isTagged(prior, 'Executing') && prior.interaction === true)

        return putToolRun(
          state,
          index,
          isInteraction ? { ...executing, interaction: true } : executing
        )
      }),
      Match.tag('ToolExecutionAccepted', 'ToolExecutionCompleted', current => {
        const index = toolRunIndex(state, current.call.id, sameCall(current.call))
        const prior = toolRunAt(state, index)
        const endedAtMs = nowMs

        const startedAtMs =
          prior !== undefined && isStartedToolRun(prior) ? prior.startedAtMs : endedAtMs

        return putToolRun(
          state,
          index,
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
      }),
      Match.tag('ToolExecutionError', current =>
        putHostToolRun(
          state,
          current.call,
          AgentToolRun.Errored({
            call: current.call,
            message: current.message,
            endedAtMs: nowMs
          })
        )
      ),
      Match.tag('ProviderToolResult', current =>
        putModelToolRun(
          state,
          AgentToolRun.ProviderCompleted({ call: current.call, result: current.result })
        )
      ),
      Match.tag('UserMessage', 'AssistantMessage', current => ({
        ...state,
        liveMessages: [...state.liveMessages, current.message],
        text: '',
        reasoning: ''
      })),
      Match.tag('AgentEnd', current => ({
        ...retainSettledToolRuns(state),
        messages: [...state.messages, ...current.messages],
        liveMessages: [],
        text: '',
        reasoning: ''
      })),
      Match.tag('AgentAwaitingInput', current => ({
        ...state,
        messages: [...state.messages, ...current.messages],
        liveMessages: [],
        text: '',
        reasoning: ''
      })),
      Match.tag('LLMStreamStart', () => discardUnfinishedStream(state)),
      Match.tag(
        'AgentRetry',
        'CompactionEnd',
        'CompactionStart',
        'LLMStreamEnd',
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
      // A new stream starts: its event ids, executions and turns are its own (a run start, so a
      // resumed tool batch without `AgentStart` still stays off earlier turns' calls).
      ...runTurnStart(retainSettledToolRuns(state), ''),
      messages: appendAgentMessage(state.messages, message),
      liveMessages: [],
      text: '',
      reasoning: '',
      seenEventIds: [],
      executions: []
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
    retainSettledToolRuns(state),
    settleAgentStatusTree(
      statusTree(state),
      error === undefined ? AgentFailed.make({ message }) : AgentFailed.make({ message, error })
    )
  )

/** The person stopped the run; per OSC 7501 a cancelled run is `Idle`. */
export const markAgentAborted = (state: AgentClientState): AgentClientState =>
  withStatusTree(
    retainSettledToolRuns(state),
    settleAgentStatusTree(statusTree(state), idleAgentStatus)
  )

export const reduceAgentEvents = (
  events: ReadonlyArray<AgentEvent>,
  initialState: AgentClientState = initialAgentClientState,
  options: ApplyAgentEventOptions = {}
) =>
  events.reduce((state, event) => applyAgentEventWithOptions(state, event, options), initialState)
