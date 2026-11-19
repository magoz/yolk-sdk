import { Data, Match, Predicate } from 'effect'
import { isTerminalAgentEvent, type AgentEvent } from '@yolk-sdk/agent/protocol'

/**
 * One execution of a model step, keyed by the `executionId` its live events carry and grouped by
 * the `streamId` (one durable run) and `turn` of its `LLMStreamStart`. A step can run more than
 * once (retry, redelivery); each run streams its own answer for the same turn.
 *
 * - `Live`: its events apply; what it produced stays provisional (`calls`, `output`).
 * - `Superseded`: a newer execution of the same turn started; its output was removed and its later
 *   events are dropped.
 * - `Settled`: a later turn of its run or another run started, a terminal event, user message or
 *   `AgentStart` arrived, or its start was stale; its output stays and its later events are
 *   dropped.
 *
 * Only a `Live` execution keeps `calls` and `output`.
 */
export type AgentExecution<Output> = {
  readonly executionId: string
  /** The event's `streamId`; `''` when the host sent none. */
  readonly streamId: string
  readonly turn: number
  readonly status: 'Live' | 'Superseded' | 'Settled'
  /** Tool calls it produced that no other event has acted on yet. */
  readonly calls: ReadonlyArray<string>
  /** Reducer output it produced or replaced, for removal. */
  readonly output: ReadonlyArray<Output>
}

export type AgentExecutions<Output> = ReadonlyArray<AgentExecution<Output>>

export type AgentExecutionRoute<Output> = Data.TaggedEnum<{
  /** No `executionId`, or one whose `LLMStreamStart` this client never saw. */
  Plain: Record<never, never>
  /** The event belongs to a superseded or settled execution. */
  Drop: Record<never, never>
  /**
   * A start for a turn its run already moved past or closed (a losing execution that started
   * late): recorded as settled so its later events drop too.
   */
  Stale: { readonly executions: AgentExecutions<Output> }
  /** A new execution started; `superseded` lists the executions whose output to remove. */
  Start: {
    readonly executions: AgentExecutions<Output>
    readonly superseded: AgentExecutions<Output>
  }
  Owned: { readonly execution: AgentExecution<Output> }
}>

interface AgentExecutionRouteDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: AgentExecutionRoute<this['A']>
}

const AgentExecutionRoute = Data.taggedEnum<AgentExecutionRouteDefinition>()

const settled = <Output>(execution: AgentExecution<Output>): AgentExecution<Output> => ({
  ...execution,
  status: 'Settled',
  calls: [],
  output: []
})

const superseded = <Output>(execution: AgentExecution<Output>): AgentExecution<Output> => ({
  ...execution,
  status: 'Superseded',
  calls: [],
  output: []
})

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
      ? AgentExecutionRoute.Owned({ execution: known })
      : AgentExecutionRoute.Drop()
  }

  if (!Predicate.isTagged(event, 'LLMStreamStart')) return AgentExecutionRoute.Plain()

  const streamId = event.streamId ?? ''
  const turn = event.turn
  const run = executions.filter(execution => execution.streamId === streamId)
  const latestTurn = Math.max(0, ...run.map(execution => execution.turn))

  const started: AgentExecution<Output> = {
    executionId,
    streamId,
    turn,
    status: 'Live',
    calls: [],
    output: []
  }

  const closed =
    turn === latestTurn &&
    run.some(execution => execution.turn === turn) &&
    !run.some(execution => execution.turn === turn && execution.status === 'Live')

  if (turn < latestTurn || closed) {
    return AgentExecutionRoute.Stale({ executions: [...executions, settled(started)] })
  }

  return AgentExecutionRoute.Start({
    superseded: run.filter(execution => execution.status === 'Live' && execution.turn === turn),
    executions: [
      ...executions.map(execution =>
        execution.status !== 'Live'
          ? execution
          : execution.streamId === streamId && execution.turn === turn
            ? superseded(execution)
            : settled(execution)
      ),
      started
    ]
  })
}

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
 * is no longer provisional); a terminal event, user message or `AgentStart` settles every live
 * execution.
 */
export const recordAgentExecutionEvent = <Output>(
  executions: AgentExecutions<Output>,
  event: AgentEvent,
  route: AgentExecutionRoute<Output>,
  output: ReadonlyArray<Output>
): AgentExecutions<Output> => {
  const calls = agentEventToolCallIds(event)
  const owned = Predicate.isTagged(route, 'Owned') || Predicate.isTagged(route, 'Start')
  const boundary = isAgentExecutionBoundary(event)

  if (calls.length === 0 && output.length === 0 && !boundary) return executions

  return executions.map(execution => {
    if (execution.status !== 'Live') return execution

    if (boundary) return settled(execution)

    if (!owned) {
      return { ...execution, calls: execution.calls.filter(call => !calls.includes(call)) }
    }

    return execution.executionId === event.executionId
      ? {
          ...execution,
          calls: [...execution.calls, ...calls.filter(call => !execution.calls.includes(call))],
          output: [...execution.output, ...output]
        }
      : execution
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
 * At a terminal event that carries committed messages (`AgentEnd`, `AgentAwaitingInput`): the live
 * execution whose turn ran more than once. Its shown answer may not be the committed one.
 */
export const disputedAgentExecution = <Output>(
  executions: AgentExecutions<Output>
): AgentExecution<Output> | undefined =>
  executions.find(
    execution =>
      execution.status === 'Live' &&
      executions.some(
        other =>
          other.status === 'Superseded' &&
          other.streamId === execution.streamId &&
          other.turn === execution.turn
      )
  )
