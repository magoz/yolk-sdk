import { Data, Match, Predicate } from 'effect'
import { isTerminalAgentEvent, type AgentEvent } from '@yolk-sdk/agent/protocol'

/**
 * One execution of a model step, keyed by the `executionId` its live events carry, at the `turn`
 * of its `LLMStreamStart`. A step can run more than once (retry, redelivery); each execution
 * streams its own answer for the same turn.
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
  readonly turn: number
  readonly status: 'Live' | 'Superseded' | 'Settled'
  /** Tool calls it produced that no other event has acted on yet. */
  readonly calls: ReadonlyArray<string>
  /** Reducer output it produced or replaced, for removal. */
  readonly output: ReadonlyArray<Output>
}

/**
 * One run's executions, keyed by the events' `streamId` (`''` when they carry none). A run is
 * closed only by terminal events: `AgentEnd` or `AgentError` end it (every later start is stale),
 * and `AgentAwaitingInput` closes its turns so far (a resumed run starts a higher turn). An
 * `AgentStart` retires the run: a later start with the same `streamId` opens a fresh one.
 */
export type AgentExecutionRun<Output> = {
  readonly streamId: string
  readonly ended: boolean
  /** Turns up to this one are closed by `AgentAwaitingInput`; `0` when none. */
  readonly closedThroughTurn: number
  readonly retired: boolean
  readonly executions: ReadonlyArray<AgentExecution<Output>>
}

export type AgentExecutions<Output> = ReadonlyArray<AgentExecutionRun<Output>>

export type AgentExecutionRoute<Output> = Data.TaggedEnum<{
  /** No `executionId`, or one whose `LLMStreamStart` this client never saw. */
  Plain: Record<never, never>
  /** The event belongs to a superseded or settled execution. */
  Drop: Record<never, never>
  /**
   * A start in an ended run, or for a turn its run already moved past or closed (a losing
   * execution that started late): recorded as settled so its later events drop too.
   */
  Stale: { readonly executions: AgentExecutions<Output> }
  /** A new execution started; `superseded` lists the executions whose output to remove. */
  Start: {
    readonly executions: AgentExecutions<Output>
    readonly superseded: ReadonlyArray<AgentExecution<Output>>
    readonly started: AgentExecution<Output>
  }
  Owned: { readonly execution: AgentExecution<Output> }
}>

interface AgentExecutionRouteDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: AgentExecutionRoute<this['A']>
}

const AgentExecutionRoute = Data.taggedEnum<AgentExecutionRouteDefinition>()

const withStatus = <Output>(
  execution: AgentExecution<Output>,
  status: 'Superseded' | 'Settled'
): AgentExecution<Output> => ({ ...execution, status, calls: [], output: [] })

const openRun = <Output>(streamId: string): AgentExecutionRun<Output> => ({
  streamId,
  ended: false,
  closedThroughTurn: 0,
  retired: false,
  executions: []
})

const allExecutions = <Output>(runs: AgentExecutions<Output>) => runs.flatMap(run => run.executions)

/** The run's current (not retired) entry, appended when there is none. */
const withCurrentRun = <Output>(
  runs: AgentExecutions<Output>,
  streamId: string,
  update: (run: AgentExecutionRun<Output>) => AgentExecutionRun<Output>
): AgentExecutions<Output> => {
  const index = runs.findIndex(run => run.streamId === streamId && !run.retired)

  return index === -1
    ? [...runs, update(openRun(streamId))]
    : runs.map((run, i) => (i === index ? update(run) : run))
}

const settleRun = <Output>(run: AgentExecutionRun<Output>): AgentExecutionRun<Output> =>
  run.executions.some(execution => execution.status === 'Live')
    ? {
        ...run,
        executions: run.executions.map(execution =>
          execution.status === 'Live' ? withStatus(execution, 'Settled') : execution
        )
      }
    : run

const settleLive = <Output>(runs: AgentExecutions<Output>): AgentExecutions<Output> =>
  runs.map(settleRun)

/** Decides how a reducer treats an event, before applying it. */
export const routeAgentExecutionEvent = <Output>(
  runs: AgentExecutions<Output>,
  event: AgentEvent
): AgentExecutionRoute<Output> => {
  const executionId = event.executionId

  if (executionId === undefined) return AgentExecutionRoute.Plain()

  const known = allExecutions(runs).find(execution => execution.executionId === executionId)

  if (known !== undefined) {
    return known.status === 'Live'
      ? AgentExecutionRoute.Owned({ execution: known })
      : AgentExecutionRoute.Drop()
  }

  if (!Predicate.isTagged(event, 'LLMStreamStart')) return AgentExecutionRoute.Plain()

  const streamId = event.streamId ?? ''
  const turn = event.turn
  const run = runs.find(current => current.streamId === streamId && !current.retired)
  const runExecutions = run?.executions ?? []
  const latestTurn = Math.max(0, ...runExecutions.map(execution => execution.turn))

  const started: AgentExecution<Output> = {
    executionId,
    turn,
    status: 'Live',
    calls: [],
    output: []
  }

  if (run !== undefined && (run.ended || turn <= run.closedThroughTurn || turn < latestTurn)) {
    return AgentExecutionRoute.Stale({
      executions: withCurrentRun(runs, streamId, current => ({
        ...current,
        executions: [...current.executions, withStatus(started, 'Settled')]
      }))
    })
  }

  const superseded = runExecutions.filter(
    execution => execution.status === 'Live' && execution.turn === turn
  )

  // Executions of earlier turns of this run, and every other run's, are settled; never later ones
  // (a stale start never gets here).
  const others = runs.map(current =>
    current.streamId === streamId && !current.retired ? current : settleRun(current)
  )

  return AgentExecutionRoute.Start({
    superseded,
    started,
    executions: withCurrentRun(others, streamId, current => ({
      ...current,
      executions: [
        ...current.executions.map(execution =>
          execution.status !== 'Live'
            ? execution
            : withStatus(execution, execution.turn === turn ? 'Superseded' : 'Settled')
        ),
        started
      ]
    }))
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

/** The runs a terminal event closes: its own run, else (no `streamId`) every run still streaming. */
const terminalRuns = <Output>(runs: AgentExecutions<Output>, event: AgentEvent) =>
  event.streamId !== undefined
    ? [event.streamId]
    : runs.flatMap(run =>
        !run.retired && run.executions.some(execution => execution.status === 'Live')
          ? [run.streamId]
          : []
      )

const latestRunTurn = <Output>(run: AgentExecutionRun<Output>) =>
  Math.max(0, ...run.executions.map(execution => execution.turn))

const closeRuns = <Output>(
  runs: AgentExecutions<Output>,
  event: AgentEvent
): AgentExecutions<Output> =>
  terminalRuns(runs, event).reduce(
    (current, streamId) =>
      withCurrentRun(current, streamId, run =>
        Predicate.isTagged(event, 'AgentAwaitingInput')
          ? {
              ...run,
              closedThroughTurn: Math.max(run.closedThroughTurn, event.turns, latestRunTurn(run))
            }
          : { ...run, ended: true }
      ),
    runs
  )

/** `AgentStart` retires its run (no `streamId`: every run), so a reused `streamId` starts afresh. */
const retireRuns = <Output>(
  runs: AgentExecutions<Output>,
  event: AgentEvent
): AgentExecutions<Output> =>
  runs.map(run =>
    !run.retired && (event.streamId === undefined || event.streamId === run.streamId)
      ? { ...run, retired: true }
      : run
  )

/**
 * Bookkeeping after a reducer applied an event: an owned event adds its calls and output to its
 * execution; any other event that refers to a call acknowledges it (a host step acted on it, so it
 * is no longer provisional). A terminal event, user message or `AgentStart` settles every live
 * execution; a terminal event also closes its run, and `AgentStart` retires it.
 */
export const recordAgentExecutionEvent = <Output>(
  runs: AgentExecutions<Output>,
  event: AgentEvent,
  route: AgentExecutionRoute<Output>,
  output: ReadonlyArray<Output>
): AgentExecutions<Output> => {
  const calls = agentEventToolCallIds(event)
  const owned = Predicate.isTagged(route, 'Owned') || Predicate.isTagged(route, 'Start')
  const terminal = isTerminalAgentEvent(event)
  const restart = Predicate.isTagged(event, 'AgentStart')
  const boundary = terminal || restart || Predicate.isTagged(event, 'UserMessage')

  if (calls.length === 0 && output.length === 0 && !boundary) return runs

  const recorded = runs.map(run => ({
    ...run,
    executions: run.executions.map(execution => {
      if (execution.status !== 'Live') return execution

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
  }))

  if (!boundary) return recorded

  const closed = terminal ? closeRuns(recorded, event) : recorded
  const settled = settleLive(closed)

  return restart ? retireRuns(settled, event) : settled
}

/**
 * At a terminal event that carries committed messages (`AgentEnd`, `AgentAwaitingInput`): the live
 * execution whose turn ran more than once. Its shown answer may not be the committed one.
 */
export const disputedAgentExecution = <Output>(
  runs: AgentExecutions<Output>
): AgentExecution<Output> | undefined =>
  runs.flatMap(run =>
    run.executions.filter(
      execution =>
        execution.status === 'Live' &&
        run.executions.some(other => other.status === 'Superseded' && other.turn === execution.turn)
    )
  )[0]
