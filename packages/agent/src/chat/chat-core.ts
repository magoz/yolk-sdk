import { Array as Arr, HashSet, Match, Option, Predicate, Struct } from 'effect'
import {
  AgentAwaitingInput,
  AgentFailed,
  hitlResponseEvent,
  idleAgentStatus,
  nextAgentStatusTree,
  settleAgentStatusTree,
  startAgentStatusTree,
  type AgentEvent,
  type AgentMessage,
  type AgentStatusTree,
  type Content,
  type HitlRequest,
  type HitlResponse,
  type LLMStreamStart,
  type ToolCall,
  type UserMessage
} from '@yolk-sdk/agent/protocol'
import {
  agentEventToolCallIds,
  disputedAgentTurns,
  isReleasedAgentExecutionRun,
  missedAgentExecutionStart,
  recordAgentExecutionEvent,
  routeAgentExecutionEvent,
  type AgentExecution,
  type AgentExecutionRoute,
  type AgentExecutions
} from '../client/executions.ts'
import { emptyHitlPauses, rememberHitlPause } from '../client/hitl-pauses.ts'
import {
  appendProtocolMessage,
  applyAgentEventToChatMessages,
  applyExecutionEventToChatMessages,
  discardChatExecutionOutput,
  executionTurnAnchor,
  isFinishedToolCall,
  isLatestTurnAnchor,
  isPastRequestToolCall,
  messagesAfterAnchor,
  replaceWithCommittedAnswer,
  streamingDraftMessage,
  deleteChatTurn,
  editChatUserMessage,
  markChatError,
  regenerateChatMessagesFrom,
  turnStartIndex,
  turnToolCallMessage,
  type ApplyAgentEventToChatMessagesOptions,
  type ChatTurnAnchor
} from './chat-messages.ts'
import {
  AgentChatExecutionOutput,
  type AgentChatEventProjectionState,
  type AgentChatMessage,
  type AgentChatPart,
  type AgentChatState,
  type AgentChatTurnStart
} from './chat-schemas.ts'
import {
  MessagesRegenerated,
  ProtocolMessageAppended,
  TurnDeleted,
  UserMessageEdited,
  UserMessageSubmitted
} from './chat-session-events.ts'

/**
 * A run's start (`AgentStart`, a local submit/HITL/regenerate/edit): its turn's output follows the
 * last chat message. A resumed run's tool batch comes before its first model turn: it reaches
 * earlier parts only as the same call or the request an answer answers, else adds parts of its
 * own, so a provider's reused call id never lands on an earlier turn's call.
 */
const runTurnStart = (
  streamId: string,
  messages: ReadonlyArray<AgentChatMessage>
): AgentChatTurnStart => ({
  streamId,
  turn: 0,
  after: Option.fromNullishOr(messages.at(-1)?.id),
  run: true
})

export const initialAgentChatState: AgentChatState = {
  status: idleAgentStatus,
  subagents: [],
  chatMessages: [],
  sessionEvents: [],
  seenEventIds: HashSet.empty()
}

const hasSeenEventId = (seenEventIds: HashSet.HashSet<string>, event: AgentEvent) =>
  event.eventId !== undefined && HashSet.has(seenEventIds, event.eventId)

const rememberEventId = (seenEventIds: HashSet.HashSet<string>, event: AgentEvent) =>
  event.eventId === undefined ? seenEventIds : HashSet.add(seenEventIds, event.eventId)

const hasSeenEvent = (state: AgentChatState, event: AgentEvent) =>
  hasSeenEventId(state.seenEventIds, event)

const statusTree = (state: AgentChatState): AgentStatusTree => ({
  root: state.status,
  subagents: state.subagents
})

const withStatusTree = (state: AgentChatState, tree: AgentStatusTree): AgentChatState =>
  tree.root === state.status && tree.subagents === state.subagents
    ? state
    : { ...state, status: tree.root, subagents: tree.subagents }

/**
 * Whether the call a tool-batch event acts on (`hostToolCallMessage`) is that call, finished
 * (`isFinishedToolCall`): a start of it is a replay the chat keeps, as `reduceAgentEvents` does.
 */
const isSettledToolCall = (state: AgentChatEventProjectionState, call: ToolCall) =>
  isFinishedToolCall(state.chatMessages, call, state.turnStart?.after)

const started = (state: AgentChatState, next: AgentChatState): AgentChatState =>
  withStatusTree(next, startAgentStatusTree(statusTree(state)))

/**
 * Marks a run start after the chat's last message (`turnStart`: turn `0`, `run: true`), as
 * `AgentStart` does, for a host that rebuilt the chat from a snapshot (`buildAgentChatMessages`,
 * `makeAgentChatEventProjectionState`) whose run may resume: the resumed run's tool batch, which
 * runs before its first model turn and may come after the snapshot's `AgentStart`, then reaches the
 * snapshot's parts only as the same call (id, name and arguments) or, for answers, the part holding
 * their request, and adds a part of its own otherwise, never landing on an earlier turn's call
 * reusing its id. A snapshot taken mid-turn keeps working: that turn's later host events for calls
 * in the snapshot's messages find them as the same call. Its later model events carrying
 * `executionTurn` start the turn they name (its missed `LLMStreamStart`); untagged ones (before the
 * next `LLMStreamStart`) still act as replays of an earlier run's: a reused id among them can reach
 * an earlier turn's call, as without a start. Pure; works on either chat state, typed with the new
 * `turnStart` (a narrower `turnStart` type the input had does not survive).
 */
export const markChatRunStart = <
  State extends {
    readonly chatMessages: ReadonlyArray<AgentChatMessage>
    // `| undefined`: the chat Schemas type `turnStart` with `Schema.optional`.
    readonly turnStart?: AgentChatTurnStart | undefined
  }
>(
  state: State
): Omit<State, 'turnStart'> & { readonly turnStart: AgentChatTurnStart } => ({
  ...state,
  turnStart: runTurnStart('', state.chatMessages)
})

export const makeAgentChatEventProjectionState = (
  chatMessages: ReadonlyArray<AgentChatMessage> = []
): AgentChatEventProjectionState => ({
  chatMessages,
  seenEventIds: HashSet.empty()
})

/**
 * Applies replayable agent events to chat messages while deduping by `eventId`.
 *
 * Use this for durable streams that may reconnect, overlap, or replay events.
 * For ephemeral local streams, `applyAgentEventToChatMessages` is still useful. A host that also
 * folds the run's status uses `stepAgentChatProjection`, which returns the same projection.
 */
export const applyAgentEventToChatProjection = (
  state: AgentChatEventProjectionState,
  event: AgentEvent,
  options: ApplyAgentEventToChatMessagesOptions = {}
): AgentChatEventProjectionState => stepAgentChatProjection(state, event, options).projection

/** One event applied to a chat projection (`stepAgentChatProjection`). */
export type AgentChatProjectionStep = {
  /** The projection after the event, as `applyAgentEventToChatProjection` returns it. */
  readonly projection: AgentChatEventProjectionState
  /**
   * The event the run's status follows (`nextAgentStatus`, `nextAgentStatusTree`), as the
   * `useAgentChat` reducer folds it; `undefined` when the status must not move. An
   * `AgentAwaitingInput` keeps only the requests the projection shows pending after it, read in
   * the turn the event acted in; it is `undefined` when every request names a call already
   * answered, cancelled, denied or finished (a replayed pause). Also `undefined` for an event seen
   * before (`eventId`), an event of a superseded, settled or stale execution, and a replayed start
   * of a call already finished.
   */
  readonly statusEvent: AgentEvent | undefined
  /**
   * The `LLMStreamStart` the event's execution missed, which the projection applied first (the
   * event names its turn with `executionTurn`, and its `executionId` was unseen: a mid-turn
   * snapshot rebuild). Fold it into the status before `statusEvent`, as the `useAgentChat` reducer
   * and `reduceAgentEvents` do. Absent when nothing was missed or the missed start was stale.
   */
  readonly missedStart?: LLMStreamStart
}

/**
 * Applies one event as `applyAgentEventToChatProjection` does and returns the event a host's own
 * status fold should apply (`statusEvent`), so its status agrees with the chat: a replayed pause
 * whose calls are past their requests leaves the status as it was instead of blocking the run
 * with no card to answer, and a pause naming some such calls blocks only on its other requests.
 * The `useAgentChat` reducer folds its status from the same `missedStart` (when present) and then
 * `statusEvent`. Pure.
 */
export const stepAgentChatProjection = (
  state: AgentChatEventProjectionState,
  event: AgentEvent,
  options: ApplyAgentEventToChatMessagesOptions = {}
): AgentChatProjectionStep =>
  stepAgentChatProjectionWith(chatExecutionOutput, state, event, options)

/**
 * What an execution's event produced (`chatExecutionOutput`): `before` is the chat the event is
 * applied to, `after` the chat it gave, `turn` and `modelTurn` the anchors its tool events and its
 * model output were scoped to.
 */
export type ChatExecutionOutputRecorder = (
  execution: AgentExecution<AgentChatExecutionOutput>,
  event: AgentEvent,
  before: ReadonlyArray<AgentChatMessage>,
  after: ReadonlyArray<AgentChatMessage>,
  turn: ChatTurnAnchor,
  modelTurn: ChatTurnAnchor
) => ReadonlyArray<AgentChatExecutionOutput>

/**
 * `stepAgentChatProjection` with the execution output recorder given (package-internal: the
 * differential test folds with a reference recorder that compares the whole chat).
 */
export const stepAgentChatProjectionWith = (
  executionOutput: ChatExecutionOutputRecorder,
  state: AgentChatEventProjectionState,
  event: AgentEvent,
  options: ApplyAgentEventToChatMessagesOptions
): AgentChatProjectionStep => {
  if (hasSeenEventId(state.seenEventIds, event)) {
    return { projection: state, statusEvent: undefined }
  }

  // A start this chat missed (a mid-turn snapshot rebuild) is applied first, as it would have
  // been, except that it keeps the draft: a rebuilt draft is the missed execution's own output.
  const missed = missedAgentExecutionStart(state.executions ?? [], event)

  const started =
    missed === undefined
      ? undefined
      : projectExecutionEvent(state, missed, options, 'missed', executionOutput)

  const before = started === undefined ? state : { ...state, ...projectionFields(started) }
  const routed = projectExecutionEvent(before, event, options, 'seen', executionOutput)

  const step: AgentChatProjectionStep = {
    projection: {
      ...projectionFields(routed),
      seenEventIds: rememberEventId(state.seenEventIds, event)
    },
    statusEvent: routed.applied ? eventForStatus(before, event, routed.pendingRequests) : undefined
  }

  return missed !== undefined && started?.applied === true ? { ...step, missedStart: missed } : step
}

/** A batch of events applied to a chat projection (`stepAgentChatProjectionAll`). */
export type AgentChatProjectionBatch = {
  /** The projection after the events, as folding `stepAgentChatProjection` over them gives it. */
  readonly projection: AgentChatEventProjectionState
  /**
   * The events the run's status follows, in order: each event's `missedStart` (when present), then
   * its `statusEvent` (when defined). Fold every one, as the `useAgentChat` reducer does.
   */
  readonly statusEvents: ReadonlyArray<AgentEvent>
  /**
   * Whether the chat's message ids, in order, differ from the input's: a list keyed by message id
   * changes only then. Messages the events did not change keep their references either way.
   */
  readonly messageIdsChanged: boolean
}

/**
 * Applies events in order, as folding `stepAgentChatProjection` over them does (events seen before
 * are skipped by `eventId`), for a host that receives a run's events in batches (one render per
 * batch). Pure; each event costs what one step does, plus one pass of reference comparisons over
 * the chat per batch for `messageIdsChanged`.
 */
export const stepAgentChatProjectionAll = (
  state: AgentChatEventProjectionState,
  events: Iterable<AgentEvent>,
  options: ApplyAgentEventToChatMessagesOptions = {}
): AgentChatProjectionBatch => {
  let projection = state
  const statusEvents: Array<AgentEvent> = []

  for (const event of events) {
    const step = stepAgentChatProjection(projection, event, options)

    projection = step.projection

    if (step.missedStart !== undefined) statusEvents.push(step.missedStart)

    if (step.statusEvent !== undefined) statusEvents.push(step.statusEvent)
  }

  return {
    projection,
    statusEvents,
    messageIdsChanged: !sameMessageIds(state.chatMessages, projection.chatMessages)
  }
}

const sameMessageIds = (
  before: ReadonlyArray<AgentChatMessage>,
  after: ReadonlyArray<AgentChatMessage>
) =>
  before === after ||
  (before.length === after.length &&
    before.every((message, index) => {
      const next = after[index]

      return message === next || message.id === next?.id
    }))

type ExecutionProjection = {
  readonly chatMessages: ReadonlyArray<AgentChatMessage>
  readonly executions?: AgentExecutions<AgentChatExecutionOutput>
  readonly turnStart?: AgentChatTurnStart
}

type ExecutionProjectionFields = {
  chatMessages: ReadonlyArray<AgentChatMessage>
  executions?: AgentExecutions<AgentChatExecutionOutput>
  turnStart?: AgentChatTurnStart
}

const projectionFields = (projection: ExecutionProjection): ExecutionProjection => {
  const fields: ExecutionProjectionFields = { chatMessages: projection.chatMessages }

  if (projection.executions !== undefined) fields.executions = projection.executions

  if (projection.turnStart !== undefined) fields.turnStart = projection.turnStart

  return fields
}

type ProjectedExecutionEvent = ExecutionProjection & {
  /** False when the event belonged to a superseded, settled or stale execution. */
  readonly applied: boolean
  /**
   * An applied `AgentAwaitingInput`'s requests the chat now shows pending: those it kept as they
   * were, naming a call already past its request (a replay), are left out.
   */
  readonly pendingRequests?: ReadonlyArray<HitlRequest>
}

/**
 * Applies one event with model-step execution routing (`executionId`): drops a superseded,
 * settled or stale execution's events, removes a superseded execution's provisional output when a
 * newer one of the same turn starts, and at `AgentEnd` / `AgentAwaitingInput` shows the committed
 * answer of every turn of the run that ran more than once and shows another one. Tool events match
 * a call only in their turn: an owned event's execution's, any other the latest turn's.
 */
const projectExecutionEvent = (
  projection: ExecutionProjection,
  event: AgentEvent,
  options: ApplyAgentEventToChatMessagesOptions,
  origin: 'seen' | 'missed',
  executionOutput: ChatExecutionOutputRecorder
): ProjectedExecutionEvent => {
  const executions = projection.executions ?? []
  const route = routeAgentExecutionEvent(executions, event)

  if (Predicate.isTagged(route, 'Drop')) {
    const recorded = recordAgentExecutionEvent(executions, event, route, [])

    return recorded === executions
      ? { ...projection, applied: false }
      : { ...projection, executions: recorded, applied: false }
  }

  if (Predicate.isTagged(route, 'Stale')) {
    return { ...projection, executions: route.executions, applied: false }
  }

  const started = Predicate.isTagged(route, 'Start')
    ? discardChatExecutionOutput(
        projection.chatMessages,
        route.superseded.flatMap(execution => execution.output),
        new Set(route.superseded.flatMap(execution => execution.calls))
      )
    : projection.chatMessages

  const latest = projection.turnStart

  const committed =
    Predicate.isTagged(event, 'AgentEnd') || Predicate.isTagged(event, 'AgentAwaitingInput')
      ? disputedAgentTurns(executions, event).reduce(
          (messages, turn) =>
            replaceWithCommittedAnswer(
              messages,
              turn.shown.output,
              new Set(turn.shown.calls),
              turn.committed
            ),
          started
        )
      : started

  const owner = Predicate.isTagged(route, 'Owned')
    ? route.execution
    : Predicate.isTagged(route, 'Start')
      ? route.started
      : undefined

  // A missed start that supersedes nothing owns the draft still streaming (a rebuilt draft is its
  // output): its turn starts before it, and a newer execution removes it, as the client's `text`.
  const streaming =
    origin === 'missed' && Predicate.isTagged(route, 'Start') && route.superseded.length === 0
      ? streamingDraftMessage(started)
      : undefined

  // Never another execution's message: only a draft no execution this chat saw produced.
  const draft =
    streaming !== undefined &&
    !executions.some(run =>
      run.executions.some(execution =>
        execution.output.some(
          output => Predicate.isTagged(output, 'Message') && output.messageId === streaming.id
        )
      )
    )
      ? streaming
      : undefined

  const startAnchor = !Predicate.isTagged(route, 'Start')
    ? undefined
    : draft === undefined
      ? turnAnchor(route.superseded, started)
      : Option.fromNullishOr(started.at(-2)?.id)

  const ownTurn =
    startAnchor ?? (owner === undefined ? undefined : executionTurnAnchor(owner.output))

  const turn = ownTurn ?? latest?.after

  // Model events before a run's first model turn replay an earlier run's (any turn, an earlier
  // run's call first), never the resumed batch's call reusing its id.
  const runStart = ownTurn === undefined && latest?.run === true ? latest : undefined

  const modelTurn = runStart === undefined ? turn : undefined

  // A missed start (`stepAgentChatProjection`) keeps the draft: a start only finalizes it here.
  const chatMessages =
    origin === 'missed'
      ? committed
      : applyExecutionEventToChatMessages(committed, event, options, {
          foreign: owner === undefined ? new Set<string>() : foreignMessages(executions, owner),
          turn,
          modelTurn,
          runOutput:
            runStart === undefined ? undefined : messagesAfterAnchor(committed, runStart.after)
        })

  const after = recordAgentExecutionEvent(
    Predicate.isTagged(route, 'Start')
      ? endEarlierTurns(route.executions, route.started.turn, event.streamId ?? '', started)
      : Predicate.isTagged(event, 'LLMStreamStart')
        ? endEarlierTurns(executions, event.turn, event.streamId ?? '', chatMessages)
        : executions,
    event,
    route,
    owner === undefined
      ? []
      : [
          ...(startAnchor === undefined
            ? []
            : [AgentChatExecutionOutput.After({ messageId: startAnchor })]),
          ...(draft === undefined
            ? []
            : [AgentChatExecutionOutput.Message({ messageId: draft.id })]),
          ...executionOutput(owner, event, committed, chatMessages, turn, modelTurn)
        ]
  )

  const turnStart = nextTurnStart(latest, event, route, startAnchor, chatMessages)

  const projected: ExecutionProjectionFields = { chatMessages }

  if (after !== executions || projection.executions !== undefined) projected.executions = after

  if (turnStart !== undefined) projected.turnStart = turnStart

  if (!Predicate.isTagged(event, 'AgentAwaitingInput')) return { ...projected, applied: true }

  // Read from the result, through the turn the event acted in: a request the chat kept leaves its
  // call past its request; one it applied made the call pending.
  const pendingRequests = event.requests.filter(
    request => !isPastRequestToolCall(chatMessages, request.call, turn)
  )

  return { ...projected, applied: true, pendingRequests }
}

/**
 * The latest turn's start after an event: an `LLMStreamStart` records its turn (a tagged one where
 * its execution's turn starts; an untagged retry of the latest turn keeps that turn's start), and
 * `AgentStart` sets a run start (`runTurnStart`; a run's turns are numbered afresh).
 */
const nextTurnStart = (
  latest: AgentChatTurnStart | undefined,
  event: AgentEvent,
  route: AgentExecutionRoute<AgentChatExecutionOutput>,
  startAnchor: Option.Option<string> | undefined,
  messages: ReadonlyArray<AgentChatMessage>
): AgentChatTurnStart | undefined => {
  if (Predicate.isTagged(event, 'AgentStart')) return runTurnStart(event.streamId ?? '', messages)

  if (!Predicate.isTagged(event, 'LLMStreamStart') || Predicate.isTagged(route, 'Owned')) {
    return latest
  }

  const streamId = event.streamId ?? ''

  if (startAnchor !== undefined) return { streamId, turn: event.turn, after: startAnchor }

  return latest !== undefined &&
    latest.run !== true &&
    latest.streamId === streamId &&
    latest.turn === event.turn &&
    isLatestTurnAnchor(messages, latest.after)
    ? latest
    : { streamId, turn: event.turn, after: Option.fromNullishOr(messages.at(-1)?.id) }
}

/**
 * Where a turn's output starts, recorded when an execution starts: the anchor of the execution it
 * superseded (the turn's first), else the last chat message.
 */
const turnAnchor = (
  superseded: ReadonlyArray<AgentExecution<AgentChatExecutionOutput>>,
  messages: ReadonlyArray<AgentChatMessage>
): Option.Option<string> =>
  executionTurnAnchor(superseded.flatMap(execution => execution.output)) ??
  Option.fromNullishOr(messages.at(-1)?.id)

/**
 * The chat messages other executions still hold as their output (an earlier turn's answer kept
 * for reconciling): the owner's events never change them. Released runs (ended or retired) hold
 * no output and are skipped, so an owned event's cost does not grow with the runs folded before.
 */
const foreignMessages = (
  executions: AgentExecutions<AgentChatExecutionOutput>,
  owner: AgentExecution<AgentChatExecutionOutput>
): ReadonlySet<string> => {
  const foreign = new Set<string>()

  for (const run of executions) {
    if (isReleasedAgentExecutionRun(run)) continue

    for (const execution of run.executions) {
      if (execution.executionId === owner.executionId) continue

      for (const output of execution.output) {
        if (Predicate.isTagged(output, 'Message')) foreign.add(output.messageId)
      }
    }
  }

  return foreign
}

/**
 * When a later turn of a run starts (with or without `executionId`), the executions of its earlier
 * turns kept for reconciling record where their turn's output ends (`Until`), once: the last chat
 * message before the first later turn. An untagged start settles nothing, so the kept execution
 * can still be live then.
 */
const endEarlierTurns = (
  runs: AgentExecutions<AgentChatExecutionOutput>,
  turn: number,
  streamId: string,
  messages: ReadonlyArray<AgentChatMessage>
): AgentExecutions<AgentChatExecutionOutput> => {
  const until = AgentChatExecutionOutput.Until({
    messageId: Option.fromNullishOr(messages.at(-1)?.id)
  })

  const ends = (execution: AgentExecution<AgentChatExecutionOutput>) =>
    execution.status !== 'Superseded' &&
    execution.turn < turn &&
    execution.output.length > 0 &&
    !execution.output.some(output => Predicate.isTagged(output, 'Until'))

  return runs.map(run =>
    run.streamId !== streamId || run.retired || !run.executions.some(ends)
      ? run
      : {
          ...run,
          executions: run.executions.map(execution =>
            ends(execution) ? { ...execution, output: [...execution.output, until] } : execution
          )
        }
  )
}

/**
 * What an execution's event produced: the chat messages it created, and each tool part it touched
 * first in its turn (`turn`), with the part it replaced (a provider can reuse a call id within a
 * turn) so removal can restore it.
 */
const chatExecutionOutput: ChatExecutionOutputRecorder = (
  execution,
  event,
  before,
  after,
  turn,
  modelTurn
) => {
  const messageWithToolCall = (messages: ReadonlyArray<AgentChatMessage>, callId: string) =>
    turnToolCallMessage(messages, callId, turn)

  // An execution's events add messages only at the chat's end and replace only messages after the
  // model's turn start (`modelTurn`; every message when it is unknown), so only those are compared:
  // an event's cost follows its turn, not the chat (checked against a whole-chat comparison:
  // `test/property/chat-execution-output.property.test.ts`). It assumes owned events never reuse
  // the id of a message before the turn's start: one that did would be recorded as created here,
  // where the whole chat holds the id already. Messages the model stream creates take the next
  // sequence's id; only a host event tagged against the contract (host events carry no
  // `executionId`) can: a tagged `AgentError` writes `markChatError`'s fixed `'error-message'`,
  // which an earlier turn's error may hold before the turn's start.
  const turnBefore = before.slice(turnStartIndex(before, modelTurn))
  const turnAfter = after.slice(turnStartIndex(after, modelTurn))
  const known = new Set(turnBefore.map(message => message.id))

  const touched = new Set(
    execution.output.flatMap(output =>
      Predicate.isTagged(output, 'ToolPart') ? [output.callId] : []
    )
  )

  const created = turnAfter.flatMap(message =>
    known.has(message.id) ? [] : [AgentChatExecutionOutput.Message({ messageId: message.id })]
  )

  const parts = agentEventToolCallIds(event).flatMap(callId => {
    if (touched.has(callId)) return []

    const prior = messageWithToolCall(before, callId)
    const current = messageWithToolCall(after, callId)
    const holder = prior ?? current

    if (holder === undefined) return []

    const priorPart = Option.fromNullishOr(
      prior?.parts.find(part => Predicate.isTagged(part, 'ToolCall') && part.call.id === callId)
    )

    return [AgentChatExecutionOutput.ToolPart({ callId, messageId: holder.id, prior: priorPart })]
  })

  return [...created, ...replacedMessages(execution, event, turnBefore, turnAfter), ...parts]
}

/**
 * Messages an execution's `AssistantMessage` replaced without having created them (one in its turn
 * matched by a reused call id, or any message when no start was seen), recorded once with how they
 * were.
 */
const replacedMessages = (
  execution: AgentExecution<AgentChatExecutionOutput>,
  event: AgentEvent,
  before: ReadonlyArray<AgentChatMessage>,
  after: ReadonlyArray<AgentChatMessage>
): ReadonlyArray<AgentChatExecutionOutput> => {
  if (!Predicate.isTagged(event, 'AssistantMessage')) return []

  const recorded = new Set(
    execution.output.flatMap(output =>
      Predicate.isTagged(output, 'Message')
        ? [output.messageId]
        : Predicate.isTagged(output, 'ReplacedMessage')
          ? [output.prior.id]
          : []
    )
  )

  const current = new Map(after.map(message => [message.id, message]))

  return before.flatMap(prior => {
    const next = current.get(prior.id)

    return next === undefined || next === prior || recorded.has(prior.id)
      ? []
      : [AgentChatExecutionOutput.ReplacedMessage({ prior })]
  })
}

export type AgentChatAction =
  | { readonly _tag: 'HydrateMessage'; readonly message: AgentMessage }
  | { readonly _tag: 'Submit'; readonly message: UserMessage }
  | { readonly _tag: 'AppendMessage'; readonly message: AgentMessage }
  | { readonly _tag: 'SubmitHitlResponse'; readonly response: HitlResponse }
  | { readonly _tag: 'DeleteTurn'; readonly messageId: string }
  | { readonly _tag: 'RegenerateFrom'; readonly messageId: string }
  | { readonly _tag: 'EditUserMessage'; readonly messageId: string; readonly content: Content }
  | ({ readonly _tag: 'Event'; readonly event: AgentEvent } & ApplyAgentEventToChatMessagesOptions)
  | { readonly _tag: 'Error'; readonly message: string }
  | { readonly _tag: 'Abort' }

/**
 * A new stream starts with `chatMessages`: its event ids, executions, turns and pauses are its own,
 * from a run start after the last message (`runTurnStart`), so a resumed tool batch without
 * `AgentStart` still stays off earlier turns' calls.
 */
const restarted = (
  state: AgentChatState,
  chatMessages: ReadonlyArray<AgentChatMessage>
): AgentChatState => ({
  ...Struct.omit(state, ['hitlPauses']),
  chatMessages,
  seenEventIds: HashSet.empty(),
  executions: [],
  turnStart: runTurnStart('', chatMessages)
})

/**
 * Records the pause every `AgentAwaitingInput` names (`rememberHitlPause`), seen or not: a replay
 * from an earlier index re-reads the later pauses after the earlier ones, so it ends at the latest
 * even when an answer cleared `seenEventIds` and only the earlier pauses read as new.
 */
const rememberPause = (state: AgentChatState, event: AgentEvent): AgentChatState => {
  const pauses = state.hitlPauses ?? emptyHitlPauses
  const next = rememberHitlPause(pauses, event)

  return next === pauses ? state : { ...state, hitlPauses: next }
}

const withoutFailure = (state: AgentChatState): AgentChatState =>
  Predicate.isTagged(state.status, 'Failed') ? { ...state, status: idleAgentStatus } : state

/**
 * The event the run's status follows after an applied event (`state`: the projection before it),
 * `undefined` when it must not move it: a replayed start of an already settled call must not
 * reopen the run, and a pause blocks only on the requests the chat shows pending
 * (`pendingRequests`), none when every one names a call past its request (a replay the chat kept
 * as it was).
 */
const eventForStatus = (
  state: AgentChatEventProjectionState,
  event: AgentEvent,
  pendingRequests: ReadonlyArray<HitlRequest> | undefined
): AgentEvent | undefined => {
  if (Predicate.isTagged(event, 'ToolExecutionStarted')) {
    return isSettledToolCall(state, event.call) ? undefined : event
  }

  if (!Predicate.isTagged(event, 'AgentAwaitingInput') || pendingRequests === undefined) {
    return event
  }

  if (!Arr.isReadonlyArrayNonEmpty(pendingRequests)) return undefined

  return pendingRequests.length === event.requests.length
    ? event
    : AgentAwaitingInput.make({ ...event, requests: pendingRequests })
}

export const reduceAgentChatState = (
  state: AgentChatState,
  action: AgentChatAction
): AgentChatState =>
  Match.value(action).pipe(
    Match.withReturnType<AgentChatState>(),
    Match.tag('HydrateMessage', current =>
      withoutFailure({
        ...state,
        chatMessages: appendProtocolMessage(state.chatMessages, current.message)
      })
    ),
    Match.tag('Submit', current =>
      started(state, {
        ...restarted(state, appendProtocolMessage(state.chatMessages, current.message)),
        sessionEvents: [
          ...state.sessionEvents,
          UserMessageSubmitted.make({ message: current.message })
        ]
      })
    ),
    Match.tag('AppendMessage', current =>
      withoutFailure({
        ...state,
        chatMessages: appendProtocolMessage(state.chatMessages, current.message),
        sessionEvents: [
          ...state.sessionEvents,
          ProtocolMessageAppended.make({ message: current.message })
        ]
      })
    ),
    Match.tag('SubmitHitlResponse', current =>
      started(
        state,
        restarted(
          state,
          // User data is not a validated tool result until the server accepts it. Keep the
          // form mounted while submitting and never replay an optimistic invalid payload.
          Predicate.isTagged(current.response, 'InputResponse') ||
            Predicate.isTagged(current.response, 'InteractionResponse')
            ? state.chatMessages
            : applyAgentEventToChatMessages(state.chatMessages, hitlResponseEvent(current.response))
        )
      )
    ),
    Match.tag('DeleteTurn', current =>
      Match.value(deleteChatTurn(state.chatMessages, current.messageId)).pipe(
        Match.withReturnType<AgentChatState>(),
        Match.tag('NotFound', () => state),
        Match.tag('Deleted', next =>
          withoutFailure({
            ...state,
            chatMessages: next.messages,
            sessionEvents: [
              ...state.sessionEvents,
              TurnDeleted.make({
                turnStartMessageId: next.turnStartMessageId,
                deletedMessageIds: next.deletedMessageIds
              })
            ]
          })
        ),
        Match.exhaustive
      )
    ),
    Match.tag('RegenerateFrom', current =>
      Match.value(regenerateChatMessagesFrom(state.chatMessages, current.messageId)).pipe(
        Match.withReturnType<AgentChatState>(),
        Match.tag('NotFound', () => state),
        Match.tag('Regenerated', next =>
          started(state, {
            ...restarted(state, next.messages),
            sessionEvents: [
              ...state.sessionEvents,
              MessagesRegenerated.make({
                fromMessageId: current.messageId,
                keptMessageIds: next.messages.map(message => message.id)
              })
            ]
          })
        ),
        Match.exhaustive
      )
    ),
    Match.tag('EditUserMessage', current =>
      Match.value(editChatUserMessage(state.chatMessages, current.messageId, current.content)).pipe(
        Match.withReturnType<AgentChatState>(),
        Match.tag('NotFound', 'NotUserMessage', () => state),
        Match.tag('Edited', next =>
          started(state, {
            ...restarted(state, next.messages),
            sessionEvents: [
              ...state.sessionEvents,
              UserMessageEdited.make({
                messageId: next.messageId,
                content: current.content,
                keptMessageIds: next.messages.map(message => message.id)
              })
            ]
          })
        ),
        Match.exhaustive
      )
    ),
    Match.tag('Event', current => {
      const paused = rememberPause(state, current.event)

      if (hasSeenEvent(paused, current.event)) {
        return paused
      }

      const step = stepAgentChatProjection(paused, current.event, current)

      const projected: AgentChatState = {
        ...Struct.omit(paused, ['executions', 'turnStart']),
        ...step.projection
      }

      const tree = [step.missedStart, step.statusEvent].reduce(
        (current: AgentStatusTree, event) =>
          event === undefined ? current : nextAgentStatusTree(current, event),
        statusTree(paused)
      )

      return withStatusTree(projected, tree)
    }),
    Match.tag('Error', current =>
      withStatusTree(
        { ...state, chatMessages: markChatError(state.chatMessages, current.message) },
        settleAgentStatusTree(statusTree(state), AgentFailed.make({ message: current.message }))
      )
    ),
    Match.tag('Abort', () =>
      withStatusTree(state, settleAgentStatusTree(statusTree(state), idleAgentStatus))
    ),
    Match.exhaustive
  )

export const hasAgentMessageReasoning = (message: AgentMessage) =>
  Predicate.isTagged(message, 'Assistant') &&
  message.parts.some(part => Predicate.isTagged(part, 'Reasoning') && part.text.length > 0)

export const hasAgentChatReasoningSummary = (state: AgentChatState) =>
  state.chatMessages.some(message =>
    message.parts.some(part => Predicate.isTagged(part, 'Reasoning') && part.text.length > 0)
  )

export const isActiveChatToolPart = (part: AgentChatPart) =>
  Predicate.isTagged(part, 'ToolCall') &&
  !Predicate.isTagged(part.state, 'Completed') &&
  !Predicate.isTagged(part.state, 'Accepted') &&
  !Predicate.isTagged(part.state, 'ProviderCompleted') &&
  !Predicate.isTagged(part.state, 'QuestionAnswered') &&
  !Predicate.isTagged(part.state, 'QuestionCancelled') &&
  !Predicate.isTagged(part.state, 'InputSubmitted') &&
  !Predicate.isTagged(part.state, 'InputCancelled') &&
  !Predicate.isTagged(part.state, 'InteractionCancelled') &&
  !Predicate.isTagged(part.state, 'Errored') &&
  !Predicate.isTagged(part.state, 'Denied')

export type ActiveChatToolPart = Extract<AgentChatPart, { readonly _tag: 'ToolCall' }>

export const isCompletedChatToolPart = (part: AgentChatPart) =>
  Predicate.isTagged(part, 'ToolCall') && Predicate.isTagged(part.state, 'Completed')

export type CompletedChatToolPart = Extract<AgentChatPart, { readonly _tag: 'ToolCall' }>

export const getActiveChatToolParts = (messages: ReadonlyArray<AgentChatMessage>) =>
  messages.flatMap(message =>
    message.parts.filter((part): part is ActiveChatToolPart => isActiveChatToolPart(part))
  )

export const getCompletedChatToolParts = (messages: ReadonlyArray<AgentChatMessage>) =>
  messages.flatMap(message =>
    message.parts.filter((part): part is CompletedChatToolPart => isCompletedChatToolPart(part))
  )

type AgentChatLiveActivityInput = {
  readonly isTextRunning: boolean
  readonly activeToolCallCount: number
  readonly isVoiceActive: boolean
}

export const getAgentChatLiveActivityCount = ({
  isTextRunning,
  activeToolCallCount,
  isVoiceActive
}: AgentChatLiveActivityInput) =>
  (isTextRunning ? 1 : 0) + activeToolCallCount + (isVoiceActive ? 1 : 0)
