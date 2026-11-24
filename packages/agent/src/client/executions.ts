import { Data, Equal, Match, Predicate } from 'effect'
import {
  isTerminalAgentEvent,
  LLMStreamStart,
  type AgentAwaitingInput,
  type AgentEnd,
  type AgentEvent,
  type AssistantAgentMessage
} from '@yolk-sdk/agent/protocol'

/**
 * One execution of a model step, keyed by the `executionId` its live events carry, at the `turn`
 * of its `LLMStreamStart`. A step can run more than once (retry, redelivery); each execution
 * streams its own answer for the same turn.
 *
 * - `Live`: its events apply; what it produced stays provisional (`calls`, `output`, `answer`).
 * - `Superseded`: a newer execution of the same turn started; its output was removed and its later
 *   events are dropped. It keeps its `answer`: the step may have committed it.
 * - `Settled`: a later turn of its run or another run started, a terminal event, user message or
 *   `AgentStart` arrived, or its start was stale; its output stays and its later events are
 *   dropped.
 *
 * A turn with a superseded execution ran more than once, and its shown execution (the one that
 * superseded the last) may not be the one the step committed. That execution keeps `calls`,
 * `output` and `answer` once settled, until its run's terminal event shows the committed answer
 * (`disputedAgentTurns`); a superseded one keeps its `answer` until then. Any other settled
 * execution keeps only its identity.
 */
export type AgentExecution<Output> = {
  readonly executionId: string
  readonly turn: number
  readonly status: 'Live' | 'Superseded' | 'Settled'
  /** Tool calls it produced that no other event has acted on yet. */
  readonly calls: ReadonlyArray<string>
  /** Reducer output it produced or replaced, for removal. */
  readonly output: ReadonlyArray<Output>
  /** Its `AssistantMessage`, while its turn may still be reconciled with the committed answer. */
  readonly answer?: AssistantAgentMessage
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
): AgentExecution<Output> => ({
  executionId: execution.executionId,
  turn: execution.turn,
  status,
  calls: [],
  output: []
})

const supersede = <Output>(execution: AgentExecution<Output>): AgentExecution<Output> =>
  execution.answer === undefined
    ? withStatus(execution, 'Superseded')
    : { ...withStatus(execution, 'Superseded'), answer: execution.answer }

/**
 * The execution a turn shows when it ran more than once: the one that superseded the last
 * superseded execution of the turn (a later one of the turn started stale).
 */
const shownExecution = <Output>(run: AgentExecutionRun<Output>, turn: number) => {
  const executions = run.executions.filter(execution => execution.turn === turn)

  const last = executions.reduce(
    (found, execution, index) => (execution.status === 'Superseded' ? index : found),
    -1
  )

  return last === -1 ? undefined : executions[last + 1]
}

/** A live execution settles; the shown one of a turn that ran more than once keeps its output. */
const settle = <Output>(
  run: AgentExecutionRun<Output>,
  execution: AgentExecution<Output>
): AgentExecution<Output> =>
  shownExecution(run, execution.turn) === execution
    ? { ...execution, status: 'Settled' }
    : withStatus(execution, 'Settled')

const holdsReconcileData = <Output>(execution: AgentExecution<Output>) =>
  execution.status !== 'Live' &&
  (execution.calls.length > 0 || execution.output.length > 0 || execution.answer !== undefined)

/** After its terminal event (or `AgentStart`), a run's executions keep only their identity. */
const releaseRun = <Output>(run: AgentExecutionRun<Output>): AgentExecutionRun<Output> =>
  run.executions.some(holdsReconcileData)
    ? {
        ...run,
        executions: run.executions.map(execution =>
          execution.status === 'Live' || !holdsReconcileData(execution)
            ? execution
            : withStatus(execution, execution.status)
        )
      }
    : run

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
          execution.status === 'Live' ? settle(run, execution) : execution
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
            : execution.turn === turn
              ? supersede(execution)
              : settle(current, execution)
        ),
        started
      ]
    }))
  })
}

type MissedStartFields = {
  turn: number
  executionId: string
  streamId?: string
  createdAtMs?: number
}

/**
 * The `LLMStreamStart` this client missed for the execution of `event`, for a reducer to apply
 * before it: the event names its execution's turn (`executionTurn`), and the ledger has never
 * seen that `executionId` (a client rebuilt from a snapshot resumes mid-turn, past the start). It
 * carries no `eventId` (never deduped or remembered) and starts the turn as the real start would:
 * stale in an ended run or for a turn its run closed or moved past, superseding a live execution of
 * the same turn, else a new turn. `undefined` for a known execution (its start's `turn` decides),
 * an event without `executionId` or `executionTurn`, an `LLMStreamStart` (its own `turn`), and a
 * `TurnStart` (which comes before its execution's start).
 */
export const missedAgentExecutionStart = <Output>(
  runs: AgentExecutions<Output>,
  event: AgentEvent
): LLMStreamStart | undefined => {
  const { executionId, executionTurn } = event

  if (
    executionId === undefined ||
    executionTurn === undefined ||
    Predicate.isTagged(event, 'LLMStreamStart') ||
    Predicate.isTagged(event, 'TurnStart') ||
    allExecutions(runs).some(execution => execution.executionId === executionId)
  ) {
    return undefined
  }

  const fields: MissedStartFields = { turn: executionTurn, executionId }

  if (event.streamId !== undefined) fields.streamId = event.streamId

  if (event.createdAtMs !== undefined) fields.createdAtMs = event.createdAtMs

  return LLMStreamStart.make(fields)
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
 * The runs a terminal event closes: its own run, else (no `streamId`) every run still streaming or
 * holding a turn to reconcile.
 */
const terminalRuns = <Output>(runs: AgentExecutions<Output>, event: AgentEvent) =>
  event.streamId !== undefined
    ? [event.streamId]
    : runs.flatMap(run =>
        !run.retired &&
        run.executions.some(
          execution => execution.status === 'Live' || holdsReconcileData(execution)
        )
          ? [run.streamId]
          : []
      )

const latestRunTurn = <Output>(run: AgentExecutionRun<Output>) =>
  Math.max(0, ...run.executions.map(execution => execution.turn))

const closeRuns = <Output>(
  runs: AgentExecutions<Output>,
  event: AgentEvent,
  closing: ReadonlyArray<string>
): AgentExecutions<Output> =>
  closing.reduce(
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

const releaseRuns = <Output>(
  runs: AgentExecutions<Output>,
  closing: ReadonlyArray<string>
): AgentExecutions<Output> =>
  runs.map(run => (!run.retired && closing.includes(run.streamId) ? releaseRun(run) : run))

/** `AgentStart` retires its run (no `streamId`: every run), so a reused `streamId` starts afresh. */
const retireRuns = <Output>(
  runs: AgentExecutions<Output>,
  event: AgentEvent
): AgentExecutions<Output> =>
  runs.map(run =>
    !run.retired && (event.streamId === undefined || event.streamId === run.streamId)
      ? releaseRun({ ...run, retired: true })
      : run
  )

/**
 * A host event acts on the calls of a live execution, or of one kept for reconciling when it is of
 * its run's latest turn (that turn's tool batch). A kept earlier turn's call is never acknowledged
 * by a later turn's event about a call that reuses its id.
 */
const acknowledges = <Output>(
  run: AgentExecutionRun<Output>,
  execution: AgentExecution<Output>,
  event: AgentEvent
) =>
  execution.status === 'Live' ||
  ((event.streamId === undefined || event.streamId === run.streamId) &&
    execution.turn === latestRunTurn(run))

/**
 * A dropped `AssistantMessage` of a superseded execution, or of the shown execution of a turn that
 * ran more than once, is still a candidate for the committed answer (a losing execution keeps
 * streaming after the newer one started).
 */
const recordDroppedAnswer = <Output>(
  runs: AgentExecutions<Output>,
  event: AgentEvent
): AgentExecutions<Output> => {
  if (!Predicate.isTagged(event, 'AssistantMessage')) return runs

  const candidate = (run: AgentExecutionRun<Output>, execution: AgentExecution<Output>) =>
    execution.executionId === event.executionId &&
    !run.retired &&
    !run.ended &&
    execution.turn > run.closedThroughTurn &&
    (execution.status === 'Superseded' || shownExecution(run, execution.turn) === execution)

  return runs.some(run => run.executions.some(execution => candidate(run, execution)))
    ? runs.map(run => ({
        ...run,
        executions: run.executions.map(execution =>
          candidate(run, execution) ? { ...execution, answer: event.message } : execution
        )
      }))
    : runs
}

/**
 * Bookkeeping after a reducer applied an event: an owned event adds its calls, output and answer
 * to its execution; any other event that refers to a call acknowledges it (a host step acted on
 * it, so it is no longer provisional). A terminal event, user message or `AgentStart` settles
 * every live execution; a terminal event also closes its run, and `AgentStart` retires it. Both
 * release what a run kept for reconciling its turns (`disputedAgentTurns` reads it first). A
 * dropped event records only a candidate answer.
 */
export const recordAgentExecutionEvent = <Output>(
  runs: AgentExecutions<Output>,
  event: AgentEvent,
  route: AgentExecutionRoute<Output>,
  output: ReadonlyArray<Output>
): AgentExecutions<Output> => {
  if (Predicate.isTagged(route, 'Drop')) return recordDroppedAnswer(runs, event)

  const calls = agentEventToolCallIds(event)
  const owned = Predicate.isTagged(route, 'Owned') || Predicate.isTagged(route, 'Start')
  const answer = owned && Predicate.isTagged(event, 'AssistantMessage') ? event.message : undefined
  const terminal = isTerminalAgentEvent(event)
  const restart = Predicate.isTagged(event, 'AgentStart')
  const boundary = terminal || restart || Predicate.isTagged(event, 'UserMessage')

  if (calls.length === 0 && output.length === 0 && answer === undefined && !boundary) return runs

  const recorded = runs.map(run => ({
    ...run,
    executions: run.executions.map(execution => {
      if (!owned) {
        return acknowledges(run, execution, event) &&
          execution.calls.some(call => calls.includes(call))
          ? { ...execution, calls: execution.calls.filter(call => !calls.includes(call)) }
          : execution
      }

      if (execution.status !== 'Live' || execution.executionId !== event.executionId) {
        return execution
      }

      const produced = {
        ...execution,
        calls: [...execution.calls, ...calls.filter(call => !execution.calls.includes(call))],
        output: [...execution.output, ...output]
      }

      return answer === undefined ? produced : { ...produced, answer }
    })
  }))

  if (!boundary) return recorded

  const closing = terminal ? terminalRuns(recorded, event) : []
  const settled = settleLive(terminal ? closeRuns(recorded, event, closing) : recorded)
  const released = terminal ? releaseRuns(settled, closing) : settled

  return restart ? retireRuns(released, event) : released
}

/** A turn of a run closed by a terminal event that shows an answer the step did not commit. */
export type AgentDisputedTurn<Output> = {
  /** The execution whose output the turn shows. */
  readonly shown: AgentExecution<Output>
  /** The committed answer to show instead. */
  readonly committed: AssistantAgentMessage
}

/**
 * At a terminal event that carries the run's committed messages (`AgentEnd`,
 * `AgentAwaitingInput`), every turn of its run that ran more than once and shows an answer other
 * than the committed one, latest turn first. The committed answer is the turn's execution answer
 * found among the messages; for the run's live (final) turn, else the messages' last assistant
 * message. A turn whose shown answer was committed, or whose committed answer is unknown, keeps
 * what it shows.
 */
export const disputedAgentTurns = <Output>(
  runs: AgentExecutions<Output>,
  event: AgentEnd | AgentAwaitingInput
): ReadonlyArray<AgentDisputedTurn<Output>> => {
  const closing = terminalRuns(runs, event)

  const isCommitted = (answer: AssistantAgentMessage | undefined) =>
    answer !== undefined && event.messages.some(message => Equal.equals(message, answer))

  const lastAnswer = event.messages
    .flatMap(message => (Predicate.isTagged(message, 'Assistant') ? [message] : []))
    .at(-1)

  return runs.flatMap(run => {
    if (run.retired || !closing.includes(run.streamId)) return []

    const turns = [
      ...new Set(
        run.executions.flatMap(execution =>
          execution.status === 'Superseded' && execution.turn > run.closedThroughTurn
            ? [execution.turn]
            : []
        )
      )
    ].sort((left, right) => right - left)

    return turns.flatMap(turn => {
      const shown = shownExecution(run, turn)

      if (shown === undefined || isCommitted(shown.answer)) return []

      const committed =
        run.executions.find(
          execution =>
            execution.turn === turn &&
            execution.status === 'Superseded' &&
            isCommitted(execution.answer)
        )?.answer ?? (shown.status === 'Live' ? lastAnswer : undefined)

      return committed === undefined ? [] : [{ shown, committed }]
    })
  })
}
