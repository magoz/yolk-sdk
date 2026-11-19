import { Data, Match, Predicate } from 'effect'
import { isTerminalAgentEvent, type AgentEvent } from '@yolk-sdk/agent/protocol'

/**
 * One execution of a model step, keyed by the `executionId` its live events carry. A step can run
 * more than once (retry, redelivery); each run streams its own answer from the same position.
 *
 * - `Live`: its events apply; what it produced stays provisional (`calls`, `output`).
 * - `Superseded`: a newer execution of the same turn started; its output was removed and its later
 *   events are dropped.
 * - `Settled`: a later turn started, or a terminal event, user message or `AgentStart` arrived;
 *   its output stays and its later events (a losing concurrent execution) are dropped.
 */
export type AgentExecution<Output> = {
  readonly executionId: string
  readonly turn: number
  readonly status: 'Live' | 'Superseded' | 'Settled'
  /** Tool calls it produced that no other event has acted on yet. */
  readonly calls: ReadonlyArray<string>
  /** Reducer output it produced (live messages, chat message ids). */
  readonly output: ReadonlyArray<Output>
}

export type AgentExecutions<Output> = ReadonlyArray<AgentExecution<Output>>

export type AgentExecutionRoute<Output> = Data.TaggedEnum<{
  /** No `executionId`, or one whose `LLMStreamStart` this client never saw. */
  Plain: Record<never, never>
  /** The event belongs to a superseded or settled execution. */
  Drop: Record<never, never>
  /** A new execution started; `superseded` lists the executions whose output to remove. */
  Start: {
    readonly executions: AgentExecutions<Output>
    readonly superseded: AgentExecutions<Output>
  }
  Owned: { readonly executionId: string }
}>

interface AgentExecutionRouteDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: AgentExecutionRoute<this['A']>
}

const AgentExecutionRoute = Data.taggedEnum<AgentExecutionRouteDefinition>()

/** Decides how a reducer treats an event, before applying it. */
export const routeAgentExecutionEvent = <Output>(
  executions: AgentExecutions<Output>,
  event: AgentEvent
): AgentExecutionRoute<Output> => {
  const executionId = event.executionId

  if (executionId === undefined) return AgentExecutionRoute.Plain()

  const known = executions.find(execution => execution.executionId === executionId)

  if (known !== undefined) {
    return known.status === 'Live'
      ? AgentExecutionRoute.Owned({ executionId })
      : AgentExecutionRoute.Drop()
  }

  if (!Predicate.isTagged(event, 'LLMStreamStart')) return AgentExecutionRoute.Plain()

  const turn = event.turn

  const superseded = executions.filter(
    execution => execution.status === 'Live' && execution.turn === turn
  )

  const started: AgentExecution<Output> = {
    executionId,
    turn,
    status: 'Live',
    calls: [],
    output: []
  }

  return AgentExecutionRoute.Start({
    superseded,
    executions: [
      ...executions.map(execution =>
        execution.status !== 'Live'
          ? execution
          : execution.turn === turn
            ? withStatus({ ...execution, calls: [], output: [] }, 'Superseded')
            : withStatus(execution, 'Settled')
      ),
      started
    ]
  })
}

const withStatus = <Output>(
  execution: AgentExecution<Output>,
  status: AgentExecution<Output>['status']
): AgentExecution<Output> => ({ ...execution, status })

/** Tool call ids an event refers to. */
export const agentEventToolCallIds = (event: AgentEvent): ReadonlyArray<string> =>
  Match.value(event).pipe(
    Match.tag('ToolInputStart', 'ToolInputDelta', current => [current.id]),
    Match.tag(
      'ToolInputEnd',
      'ToolApprovalRequested',
      'ToolExecutionStarted',
      'ToolExecutionAccepted',
      'ToolExecutionCompleted',
      'ToolExecutionError',
      'ProviderToolResult',
      current => [current.call.id]
    ),
    Match.tag('ToolApprovalGranted', 'ToolApprovalDenied', current => [current.toolCallId]),
    Match.tag('QuestionRequested', 'InputRequested', 'InteractionRequested', current => [
      current.request.toolCallId
    ]),
    Match.tag(
      'QuestionAnswered',
      'QuestionCancelled',
      'InputSubmitted',
      'InputCancelled',
      'InteractionSubmitted',
      'InteractionCancelled',
      current => [current.response.toolCallId]
    ),
    Match.tag('AssistantMessage', current =>
      current.message.parts.flatMap(part =>
        Predicate.isTagged(part, 'HostToolCall') || Predicate.isTagged(part, 'ProviderToolCall')
          ? [part.call.id]
          : []
      )
    ),
    Match.orElse(() => [])
  )

/**
 * Bookkeeping after a reducer applied an event: an owned event adds its calls and output to its
 * execution; any other event that refers to a call acknowledges it (a host step acted on it, so it
 * is no longer provisional); a terminal event settles every live execution.
 */
export const recordAgentExecutionEvent = <Output>(
  executions: AgentExecutions<Output>,
  event: AgentEvent,
  route: AgentExecutionRoute<Output>,
  output: ReadonlyArray<Output>
): AgentExecutions<Output> => {
  const calls = agentEventToolCallIds(event)
  const ownerId = Predicate.isTagged(route, 'Owned') ? route.executionId : event.executionId
  const owned = Predicate.isTagged(route, 'Owned') || Predicate.isTagged(route, 'Start')
  const boundary = isAgentExecutionBoundary(event)

  if (calls.length === 0 && output.length === 0 && !boundary) return executions

  return executions.map(execution => {
    const next: AgentExecution<Output> =
      owned && execution.executionId === ownerId
        ? {
            ...execution,
            calls: [...execution.calls, ...calls.filter(call => !execution.calls.includes(call))],
            output: [...execution.output, ...output]
          }
        : owned
          ? execution
          : { ...execution, calls: execution.calls.filter(call => !calls.includes(call)) }

    return boundary ? withStatus(next, 'Settled') : next
  })
}

/**
 * A terminal event, a user message or a new run ends every execution so far: a later event of
 * one is a losing concurrent execution's, and a later run's executions start a fresh dispute.
 */
const isAgentExecutionBoundary = (event: AgentEvent) =>
  isTerminalAgentEvent(event) ||
  Predicate.isTagged(event, 'UserMessage') ||
  Predicate.isTagged(event, 'AgentStart')

/**
 * At `AgentEnd`, the executions of the final turn when more than one ran: the turn was disputed,
 * so its shown answer may not be the committed one.
 */
export const disputedFinalTurnExecutions = <Output>(
  executions: AgentExecutions<Output>
): AgentExecutions<Output> => {
  const last = executions.at(-1)

  if (last === undefined || last.status !== 'Live') return []

  const turn = executions.filter(
    execution => execution.turn === last.turn && execution.status !== 'Settled'
  )

  return turn.length > 1 ? turn : []
}

/** Superseded executions' provisional calls, for removal. */
export const supersededAgentExecutionCalls = <Output>(superseded: AgentExecutions<Output>) =>
  new Set(superseded.flatMap(execution => execution.calls))
