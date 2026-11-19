import { Match, Option, Predicate } from 'effect'
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
  type UserMessage
} from '@yolk-sdk/agent/protocol'
import {
  agentEventToolCallIds,
  disputedAgentTurns,
  recordAgentExecutionEvent,
  routeAgentExecutionEvent,
  type AgentExecution,
  type AgentExecutions
} from '../client/executions.ts'
import {
  appendProtocolMessage,
  applyAgentEventToChatMessages,
  applyExecutionEventToChatMessages,
  AgentChatExecutionOutput,
  discardChatExecutionOutput,
  replaceWithCommittedAnswer,
  deleteChatTurn,
  editChatUserMessage,
  markChatError,
  regenerateChatMessagesFrom,
  type AgentChatMessage,
  type AgentChatPart,
  type ApplyAgentEventToChatMessagesOptions
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

const isSettledToolCall = (messages: ReadonlyArray<AgentChatMessage>, toolCallId: string) =>
  messages.some(message =>
    message.parts.some(
      part =>
        Predicate.isTagged(part, 'ToolCall') &&
        part.call.id === toolCallId &&
        (Predicate.isTagged(part.state, 'Completed') || Predicate.isTagged(part.state, 'Accepted'))
    )
  )

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
  const projected = projectExecutionEvent(state, event, options)

  return projected.executions === undefined
    ? { chatMessages: projected.chatMessages, seenEventIds }
    : { chatMessages: projected.chatMessages, seenEventIds, executions: projected.executions }
}

type ExecutionProjection = {
  readonly chatMessages: ReadonlyArray<AgentChatMessage>
  readonly executions?: AgentExecutions<AgentChatExecutionOutput>
}

type ProjectedExecutionEvent = ExecutionProjection & {
  /** False when the event belonged to a superseded, settled or stale execution. */
  readonly applied: boolean
}

/**
 * Applies one event with model-step execution routing (`executionId`): drops a superseded,
 * settled or stale execution's events, removes a superseded execution's provisional output when a
 * newer one of the same turn starts, and at `AgentEnd` / `AgentAwaitingInput` shows the committed
 * answer of every turn of the run that ran more than once and shows another one.
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
      : { chatMessages: projection.chatMessages, executions: recorded, applied: false }
  }

  if (Predicate.isTagged(route, 'Stale')) {
    return { chatMessages: projection.chatMessages, executions: route.executions, applied: false }
  }

  const started = Predicate.isTagged(route, 'Start')
    ? discardChatExecutionOutput(
        projection.chatMessages,
        route.superseded.flatMap(execution => execution.output),
        new Set(route.superseded.flatMap(execution => execution.calls))
      )
    : projection.chatMessages

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

  const chatMessages =
    owner === undefined
      ? applyAgentEventToChatMessages(committed, event, options)
      : applyExecutionEventToChatMessages(
          committed,
          event,
          options,
          foreignMessages(executions, owner)
        )

  const anchor = Predicate.isTagged(route, 'Start') ? [turnAnchor(route.superseded, started)] : []

  const after = recordAgentExecutionEvent(
    Predicate.isTagged(route, 'Start')
      ? endEarlierTurns(route.executions, route.started, event.streamId ?? '', started)
      : executions,
    event,
    route,
    owner === undefined
      ? []
      : [...anchor, ...chatExecutionOutput(owner, event, committed, chatMessages)]
  )

  return after === executions
    ? { ...projection, chatMessages, applied: true }
    : { chatMessages, executions: after, applied: true }
}

/**
 * Where a turn's output starts, recorded when an execution starts: the anchor of the execution it
 * superseded (the turn's first), else the last chat message.
 */
const turnAnchor = (
  superseded: ReadonlyArray<AgentExecution<AgentChatExecutionOutput>>,
  messages: ReadonlyArray<AgentChatMessage>
): AgentChatExecutionOutput =>
  superseded
    .flatMap(execution => execution.output)
    .find(output => Predicate.isTagged(output, 'After')) ??
  AgentChatExecutionOutput.After({ messageId: Option.fromNullishOr(messages.at(-1)?.id) })

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
 * When a later turn of a run starts, the executions of its earlier turns kept for reconciling
 * record where their turn's output ends (`Until`): the last chat message before the new turn.
 */
const endEarlierTurns = (
  runs: AgentExecutions<AgentChatExecutionOutput>,
  started: AgentExecution<AgentChatExecutionOutput>,
  streamId: string,
  messages: ReadonlyArray<AgentChatMessage>
): AgentExecutions<AgentChatExecutionOutput> => {
  const until = AgentChatExecutionOutput.Until({
    messageId: Option.fromNullishOr(messages.at(-1)?.id)
  })

  const ends = (execution: AgentExecution<AgentChatExecutionOutput>) =>
    execution.status === 'Settled' &&
    execution.turn < started.turn &&
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

const messageWithToolCall = (messages: ReadonlyArray<AgentChatMessage>, callId: string) =>
  messages
    .filter(message =>
      message.parts.some(part => Predicate.isTagged(part, 'ToolCall') && part.call.id === callId)
    )
    .at(-1)

/**
 * What an execution's event produced: the chat messages it created, and each tool part it touched
 * first, with the part it replaced (providers reuse call ids across turns) so removal can restore it.
 */
const chatExecutionOutput = (
  execution: AgentExecution<AgentChatExecutionOutput>,
  event: AgentEvent,
  before: ReadonlyArray<AgentChatMessage>,
  after: ReadonlyArray<AgentChatMessage>
): ReadonlyArray<AgentChatExecutionOutput> => {
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
 * Messages an execution's `AssistantMessage` replaced without having created them (an earlier
 * turn's message matched by a reused call id), recorded once with how they were.
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
        ...state,
        seenEventIds: [],
        executions: [],
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
        ...state,
        seenEventIds: [],
        executions: [],
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
            ...state,
            seenEventIds: [],
            executions: [],
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
            ...state,
            seenEventIds: [],
            executions: [],
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

      const projected =
        routed.executions === undefined
          ? { ...state, chatMessages: routed.chatMessages }
          : { ...state, chatMessages: routed.chatMessages, executions: routed.executions }

      if (!routed.applied) return rememberEvent(projected, current.event)

      // A replayed start of an already settled call must not reopen the run.
      const fenced =
        Predicate.isTagged(current.event, 'ToolExecutionStarted') &&
        isSettledToolCall(state.chatMessages, current.event.call.id)

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
