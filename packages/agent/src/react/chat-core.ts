import { Match, Option, Predicate, Struct } from 'effect'
import {
  AgentFailed,
  hitlResponseEvent,
  idleAgentStatus,
  nextAgentStatusTree,
  settleAgentStatusTree,
  startAgentStatusTree,
  type AgentEvent,
  type AgentMessage,
  type AgentStatus,
  type AgentStatusTree,
  type Content,
  type HitlResponse,
  type ToolCall,
  type UserMessage
} from '@yolk-sdk/agent/protocol'
import {
  agentEventToolCallIds,
  disputedAgentTurns,
  recordAgentExecutionEvent,
  routeAgentExecutionEvent,
  type AgentExecution,
  type AgentExecutionRoute,
  type AgentExecutions
} from '../client/executions.ts'
import {
  appendProtocolMessage,
  applyAgentEventToChatMessages,
  applyExecutionEventToChatMessages,
  AgentChatExecutionOutput,
  discardChatExecutionOutput,
  executionTurnAnchor,
  hostToolCallMessage,
  isLatestTurnAnchor,
  replaceWithCommittedAnswer,
  deleteChatTurn,
  editChatUserMessage,
  markChatError,
  regenerateChatMessagesFrom,
  turnToolCallMessage,
  type AgentChatMessage,
  type AgentChatPart,
  type ApplyAgentEventToChatMessagesOptions,
  type ChatTurnAnchor
} from './chat-messages.ts'
import {
  MessagesRegenerated,
  ProtocolMessageAppended,
  TurnDeleted,
  UserMessageEdited,
  UserMessageSubmitted,
  type AgentChatSessionEvent
} from './chat-session-events.ts'

export type AgentChatState = {
  /** Run status; failures and pending retries live here (`Failed`, `Working(Retrying)`). */
  readonly status: AgentStatus
  readonly subagents: AgentStatusTree['subagents']
  readonly chatMessages: ReadonlyArray<AgentChatMessage>
  readonly sessionEvents: ReadonlyArray<AgentChatSessionEvent>
  readonly seenEventIds: ReadonlyArray<string>
  /** Model-step executions seen on this stream; see `AgentChatEventProjectionState`. */
  readonly executions?: AgentExecutions<AgentChatExecutionOutput>
  /** The latest model turn's start; see `AgentChatEventProjectionState`. */
  readonly turnStart?: AgentChatTurnStart
}

/**
 * The start of the latest model turn a chat projection saw (its `LLMStreamStart`, tagged or not).
 * Providers reuse tool call ids across turns, so the turn's tool events match a call only in the
 * messages after `after`: the model's stream (its own execution's start, when tagged) and host
 * events (the tool batch, approvals, questions and their answers act on the latest turn's calls).
 */
export type AgentChatTurnStart = {
  /** The start's `streamId` (`''` when none). */
  readonly streamId: string
  readonly turn: number
  /** The turn's output follows this chat message (none: the chat was empty). */
  readonly after: Option.Option<string>
}

export type AgentChatEventProjectionState = {
  readonly chatMessages: ReadonlyArray<AgentChatMessage>
  readonly seenEventIds: ReadonlyArray<string>
  /**
   * Model-step executions seen on this stream (events carrying `executionId`), with the chat
   * message ids and tool calls each produced. Carry it with `seenEventIds` between events; absent
   * in states built before it.
   */
  readonly executions?: AgentExecutions<AgentChatExecutionOutput>
  /**
   * The latest model turn's start (`AgentChatTurnStart`); carry it with `seenEventIds`. Absent
   * until a start is seen and after `AgentStart`: tool events then match the last message holding
   * a call, in any turn.
   */
  readonly turnStart?: AgentChatTurnStart
}

export const initialAgentChatState: AgentChatState = {
  status: idleAgentStatus,
  subagents: [],
  chatMessages: [],
  sessionEvents: [],
  seenEventIds: []
}

const hasSeenEventId = (seenEventIds: ReadonlyArray<string>, event: AgentEvent) =>
  event.eventId !== undefined && seenEventIds.includes(event.eventId)

const rememberEventId = (seenEventIds: ReadonlyArray<string>, event: AgentEvent) =>
  event.eventId === undefined ? seenEventIds : [...seenEventIds, event.eventId]

const hasSeenEvent = (state: AgentChatState, event: AgentEvent) =>
  hasSeenEventId(state.seenEventIds, event)

const rememberEvent = (state: AgentChatState, event: AgentEvent): AgentChatState =>
  event.eventId === undefined
    ? state
    : { ...state, seenEventIds: rememberEventId(state.seenEventIds, event) }

const statusTree = (state: AgentChatState): AgentStatusTree => ({
  root: state.status,
  subagents: state.subagents
})

const withStatusTree = (state: AgentChatState, tree: AgentStatusTree): AgentChatState =>
  tree.root === state.status && tree.subagents === state.subagents
    ? state
    : { ...state, status: tree.root, subagents: tree.subagents }

/** Whether the call a tool-batch event acts on (`hostToolCallMessage`) already settled. */
const isSettledToolCall = (state: AgentChatState, call: ToolCall) =>
  hostToolCallMessage(state.chatMessages, call, state.turnStart?.after)?.parts.some(
    part =>
      Predicate.isTagged(part, 'ToolCall') &&
      part.call.id === call.id &&
      (Predicate.isTagged(part.state, 'Completed') || Predicate.isTagged(part.state, 'Accepted'))
  ) === true

const started = (state: AgentChatState, next: AgentChatState): AgentChatState =>
  withStatusTree(next, startAgentStatusTree(statusTree(state)))

export const makeAgentChatEventProjectionState = (
  chatMessages: ReadonlyArray<AgentChatMessage> = []
): AgentChatEventProjectionState => ({
  chatMessages,
  seenEventIds: []
})

/**
 * Applies replayable agent events to chat messages while deduping by `eventId`.
 *
 * Use this for durable streams that may reconnect, overlap, or replay events.
 * For ephemeral local streams, `applyAgentEventToChatMessages` is still useful.
 */
export const applyAgentEventToChatProjection = (
  state: AgentChatEventProjectionState,
  event: AgentEvent,
  options: ApplyAgentEventToChatMessagesOptions = {}
): AgentChatEventProjectionState => {
  if (hasSeenEventId(state.seenEventIds, event)) {
    return state
  }

  const seenEventIds = rememberEventId(state.seenEventIds, event)

  return { ...projectionFields(projectExecutionEvent(state, event, options)), seenEventIds }
}

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
  options: ApplyAgentEventToChatMessagesOptions
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

  const startAnchor = Predicate.isTagged(route, 'Start')
    ? turnAnchor(route.superseded, started)
    : undefined

  const turn =
    startAnchor ??
    (owner === undefined ? undefined : executionTurnAnchor(owner.output)) ??
    latest?.after

  const chatMessages = applyExecutionEventToChatMessages(committed, event, options, {
    foreign: owner === undefined ? new Set<string>() : foreignMessages(executions, owner),
    turn
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
          ...chatExecutionOutput(owner, event, committed, chatMessages, turn)
        ]
  )

  const turnStart = nextTurnStart(latest, event, route, startAnchor, chatMessages)

  const projected: ExecutionProjectionFields = { chatMessages }

  if (after !== executions || projection.executions !== undefined) projected.executions = after

  if (turnStart !== undefined) projected.turnStart = turnStart

  return { ...projected, applied: true }
}

/**
 * The latest turn's start after an event: an `LLMStreamStart` records its turn (a tagged one where
 * its execution's turn starts; an untagged retry of the latest turn keeps that turn's start), and
 * `AgentStart` clears it (a run's turns are numbered afresh).
 */
const nextTurnStart = (
  latest: AgentChatTurnStart | undefined,
  event: AgentEvent,
  route: AgentExecutionRoute<AgentChatExecutionOutput>,
  startAnchor: Option.Option<string> | undefined,
  messages: ReadonlyArray<AgentChatMessage>
): AgentChatTurnStart | undefined => {
  if (Predicate.isTagged(event, 'AgentStart')) return undefined

  if (!Predicate.isTagged(event, 'LLMStreamStart') || Predicate.isTagged(route, 'Owned')) {
    return latest
  }

  const streamId = event.streamId ?? ''

  if (startAnchor !== undefined) return { streamId, turn: event.turn, after: startAnchor }

  return latest !== undefined &&
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
 * for reconciling): the owner's events never change them.
 */
const foreignMessages = (
  executions: AgentExecutions<AgentChatExecutionOutput>,
  owner: AgentExecution<AgentChatExecutionOutput>
): ReadonlySet<string> =>
  new Set(
    executions.flatMap(run =>
      run.executions.flatMap(execution =>
        execution.executionId === owner.executionId
          ? []
          : execution.output.flatMap(output =>
              Predicate.isTagged(output, 'Message') ? [output.messageId] : []
            )
      )
    )
  )

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
const chatExecutionOutput = (
  execution: AgentExecution<AgentChatExecutionOutput>,
  event: AgentEvent,
  before: ReadonlyArray<AgentChatMessage>,
  after: ReadonlyArray<AgentChatMessage>,
  turn: ChatTurnAnchor
): ReadonlyArray<AgentChatExecutionOutput> => {
  const messageWithToolCall = (messages: ReadonlyArray<AgentChatMessage>, callId: string) =>
    turnToolCallMessage(messages, callId, turn)

  const known = new Set(before.map(message => message.id))

  const touched = new Set(
    execution.output.flatMap(output =>
      Predicate.isTagged(output, 'ToolPart') ? [output.callId] : []
    )
  )

  const created = after.flatMap(message =>
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

  return [...created, ...replacedMessages(execution, event, before, after), ...parts]
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

/** A new stream starts: its event ids, executions and turns are its own. */
const restarted = (state: AgentChatState) => ({
  ...Struct.omit(state, ['turnStart']),
  seenEventIds: [],
  executions: []
})

const withoutFailure = (state: AgentChatState): AgentChatState =>
  Predicate.isTagged(state.status, 'Failed') ? { ...state, status: idleAgentStatus } : state

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
        ...restarted(state),
        chatMessages: appendProtocolMessage(state.chatMessages, current.message),
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
      started(state, {
        ...restarted(state),
        // User data is not a validated tool result until the server accepts it. Keep the
        // form mounted while submitting and never replay an optimistic invalid payload.
        chatMessages:
          Predicate.isTagged(current.response, 'InputResponse') ||
          Predicate.isTagged(current.response, 'InteractionResponse')
            ? state.chatMessages
            : applyAgentEventToChatMessages(state.chatMessages, hitlResponseEvent(current.response))
      })
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
            ...restarted(state),
            chatMessages: next.messages,
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
            ...restarted(state),
            chatMessages: next.messages,
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
      if (hasSeenEvent(state, current.event)) {
        return state
      }

      const routed = projectExecutionEvent(state, current.event, current)

      const projected: AgentChatState = {
        ...Struct.omit(state, ['executions', 'turnStart']),
        ...projectionFields(routed)
      }

      if (!routed.applied) return rememberEvent(projected, current.event)

      // A replayed start of an already settled call must not reopen the run.
      const fenced =
        Predicate.isTagged(current.event, 'ToolExecutionStarted') &&
        isSettledToolCall(state, current.event.call)

      return rememberEvent(
        fenced
          ? projected
          : withStatusTree(projected, nextAgentStatusTree(statusTree(state), current.event)),
        current.event
      )
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
