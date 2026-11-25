import { Data, Effect } from 'effect'

export type DurableAgentEventSequencerState = {
  readonly eventSequence: number
}

export type DurableAgentEvent<Event extends object = object> = Event & {
  readonly eventId: string
  readonly createdAtMs?: number
  /** Set from `SequenceDurableAgentEventInput.executionId`; clients route live events by it. */
  readonly executionId?: string
  /**
   * The step's `turn`, set with `executionId` (removed without it): clients that missed the
   * execution's `LLMStreamStart` start its turn from it.
   */
  readonly executionTurn?: number
  /**
   * The `streamId`, set on every event (omitted when blank or padded, which clients reject) so
   * clients group executions per run and a terminal event closes its run.
   */
  readonly streamId?: string
}

export type DurableAgentEventIdInput = {
  readonly streamId: string
  readonly turn: number
  readonly eventSequence: number
  /** See `SequenceDurableAgentEventInput.executionId`. */
  readonly executionId?: string
}

export type SequenceDurableAgentEventInput<Event extends object = object> = {
  readonly state: DurableAgentEventSequencerState
  /**
   * Stable id namespace for one independent durable stream.
   *
   * Include the workflow/session/run id when multiple logical runs can be
   * projected in the same client. Replay-safe clients de-dupe by `eventId`, so
   * reusing a stream id across runs can drop legitimate follow-up events.
   */
  readonly streamId: string
  /**
   * The model step's turn: it must equal the turn its model call streams (`LLMStreamStart.turn`,
   * `runModelTurn`'s `turn`), because tagged events also carry it as `executionTurn`, which
   * clients that missed the execution's `LLMStreamStart` start its turn from (a lower turn drops
   * the execution's events as stale). With `executionId` it must be a non-negative safe integer
   * (sequencing throws a `TypeError` otherwise).
   */
  readonly turn: number
  /**
   * Identifies one execution of a model step. It is appended to the id and set as the event's
   * `executionId` field, with `turn` as its `executionTurn` (both removed without it), which
   * `@yolk-sdk/agent` clients route by, per run (the event's `streamId` field, set on every event)
   * and turn. It and `streamId` must be non-empty without surrounding whitespace (clients reject
   * anything else); otherwise sequencing throws a `TypeError` (a defect in
   * `writeDurableAgentEvent`).
   *
   * Every execution of a step starts from the same `eventSequence`, and a step runs more than
   * once (opt-in loop retries, platform retries, queue redelivery beside a running execution,
   * Workflow 5.8 speculative execution). Make it unique per execution of the step body, not per
   * attempt: a speculative re-execution repeats `getStepMetadata()`'s `stepId` and `attempt`.
   * Generate it once at the start of the body (for example
   * `${stepId}:${attempt}:${crypto.randomUUID()}`; bodies are not replayed) and set it on
   * every event the model call produces, from `LLMStreamStart` through `AssistantMessage` and
   * `UsageUpdate`; `LLMStreamStart` must carry it. Leave it off host events (a promoted user
   * message, the terminal event written after the commit). A receipt replay writes only that
   * terminal event, never the live events again.
   */
  readonly executionId?: string
  readonly event: Event
  readonly createdAtMs?: number
}

export type SequencedDurableAgentEvent<Event extends object = object> = {
  readonly event: DurableAgentEvent<Event>
  readonly eventSequence: number
  readonly nextEventSequence: number
  readonly nextState: DurableAgentEventSequencerState
}

export type WriteDurableAgentEventInput<Event extends object = object> =
  SequenceDurableAgentEventInput<Event> & {
    readonly writer: WritableStreamDefaultWriter<Uint8Array>
  }

export type CommitThenWriteTerminalEventInput<
  TerminalEvent extends object,
  TerminalWriteResult,
  CommitErrorWriteResult,
  CommitError,
  TerminalWriteError,
  CommitErrorWriteError
> = {
  readonly commit: Effect.Effect<void, CommitError>
  readonly terminal: TerminalEvent
  readonly write: (event: TerminalEvent) => Effect.Effect<TerminalWriteResult, TerminalWriteError>
  readonly writeCommitError: (
    error: CommitError
  ) => Effect.Effect<CommitErrorWriteResult, CommitErrorWriteError>
}

export type CommitThenWriteTerminalEventResult<TerminalWriteResult, CommitErrorWriteResult> =
  Data.TaggedEnum<{
    Committed: {
      readonly writeResult: TerminalWriteResult
    }
    CommitFailed: {
      readonly commitError: unknown
      readonly writeResult: CommitErrorWriteResult
    }
    TerminalWriteFailed: {
      readonly error: unknown
    }
    CommitErrorWriteFailed: {
      readonly commitError: unknown
      readonly error: unknown
    }
  }>

interface CommitThenWriteTerminalEventResultDefinition extends Data.TaggedEnum.WithGenerics<2> {
  readonly taggedEnum: CommitThenWriteTerminalEventResult<this['A'], this['B']>
}

export const CommitThenWriteTerminalEventResult =
  Data.taggedEnum<CommitThenWriteTerminalEventResultDefinition>()

const textEncoder = new TextEncoder()

export const makeDurableAgentEventSequencerState = (
  eventSequence = 0
): DurableAgentEventSequencerState => ({ eventSequence })

export const durableAgentEventId = (input: DurableAgentEventIdInput) =>
  input.executionId === undefined
    ? `${input.streamId}:${input.turn}:${input.eventSequence}`
    : `${input.streamId}:${input.turn}:${input.eventSequence}:${input.executionId}`

const isNonBlankTrimmed = (value: string) => value.length > 0 && value.trim() === value

export const sequenceDurableAgentEvent = <Event extends object>(
  input: SequenceDurableAgentEventInput<Event>
): SequencedDurableAgentEvent<Event> => {
  const eventSequence = input.state.eventSequence
  const nextEventSequence = eventSequence + 1

  type SequencedDurableAgentEventFields = Event & {
    eventId: string
    createdAtMs?: number
    executionId?: string
    executionTurn?: number
    streamId?: string
  }

  // A host bug: clients reject a blank or padded id, so fail loudly (a defect in an Effect).
  if (input.executionId !== undefined && !isNonBlankTrimmed(input.executionId)) {
    throw new TypeError('executionId must be non-empty, without surrounding whitespace')
  }

  if (input.executionId !== undefined && !isNonBlankTrimmed(input.streamId)) {
    throw new TypeError('streamId must be non-empty, without surrounding whitespace')
  }

  if (input.executionId !== undefined && !(Number.isSafeInteger(input.turn) && input.turn >= 0)) {
    throw new TypeError('turn must be a non-negative safe integer for a tagged event')
  }

  const event: SequencedDurableAgentEventFields = {
    ...input.event,
    eventId: durableAgentEventId({
      streamId: input.streamId,
      turn: input.turn,
      eventSequence,
      executionId: input.executionId
    })
  }

  if (input.createdAtMs !== undefined) {
    event.createdAtMs = input.createdAtMs
  }

  // The fields always agree with the id: set from the input, or removed when it has none. Every
  // event carries its `streamId` (when clients can decode it), so a terminal event closes its run.
  if (input.executionId === undefined) {
    delete event.executionId
    delete event.executionTurn
  } else {
    event.executionId = input.executionId
    event.executionTurn = input.turn
  }

  if (isNonBlankTrimmed(input.streamId)) {
    event.streamId = input.streamId
  } else {
    delete event.streamId
  }

  return {
    event,
    eventSequence,
    nextEventSequence,
    nextState: makeDurableAgentEventSequencerState(nextEventSequence)
  }
}

const encodeDurableAgentEventNdjson = <Event extends object>(event: DurableAgentEvent<Event>) =>
  textEncoder.encode(`${JSON.stringify(event)}\n`)

/**
 * The stream writer rejected a durable event write. `message` repeats the writer's own error
 * message (`String(cause)` for a non-`Error` rejection); `cause` is the original rejection.
 */
export class DurableAgentEventWriteError extends Data.TaggedError('DurableAgentEventWriteError')<{
  readonly message: string
  readonly cause: unknown
}> {}

export const writeDurableAgentEvent = <Event extends object>(
  input: WriteDurableAgentEventInput<Event>
): Effect.Effect<SequencedDurableAgentEvent<Event>, DurableAgentEventWriteError> =>
  Effect.gen(function* () {
    const sequenced = sequenceDurableAgentEvent(input)
    yield* Effect.tryPromise({
      try: () => input.writer.write(encodeDurableAgentEventNdjson(sequenced.event)),
      catch: cause =>
        new DurableAgentEventWriteError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause
        })
    })

    return sequenced
  })

export const commitThenWriteTerminalEvent = <
  TerminalEvent extends object,
  TerminalWriteResult,
  CommitErrorWriteResult,
  CommitError,
  TerminalWriteError,
  CommitErrorWriteError
>(
  input: CommitThenWriteTerminalEventInput<
    TerminalEvent,
    TerminalWriteResult,
    CommitErrorWriteResult,
    CommitError,
    TerminalWriteError,
    CommitErrorWriteError
  >
): Effect.Effect<
  CommitThenWriteTerminalEventResult<TerminalWriteResult, CommitErrorWriteResult>,
  never
> =>
  input.commit.pipe(
    Effect.matchEffect({
      onFailure: commitError =>
        input.writeCommitError(commitError).pipe(
          Effect.match({
            onFailure: error =>
              CommitThenWriteTerminalEventResult.CommitErrorWriteFailed<
                TerminalWriteResult,
                CommitErrorWriteResult
              >({
                commitError,
                error
              }),
            onSuccess: writeResult =>
              CommitThenWriteTerminalEventResult.CommitFailed<
                TerminalWriteResult,
                CommitErrorWriteResult
              >({
                commitError,
                writeResult
              })
          })
        ),
      onSuccess: () =>
        input.write(input.terminal).pipe(
          Effect.match({
            onFailure: error =>
              CommitThenWriteTerminalEventResult.TerminalWriteFailed<
                TerminalWriteResult,
                CommitErrorWriteResult
              >({ error }),
            onSuccess: writeResult =>
              CommitThenWriteTerminalEventResult.Committed<
                TerminalWriteResult,
                CommitErrorWriteResult
              >({ writeResult })
          })
        )
    })
  )
