import { Data, Effect } from 'effect'

export type DurableAgentEventSequencerState = {
  readonly eventSequence: number
}

export type DurableAgentEvent<Event extends object = object> = Event & {
  readonly eventId: string
  readonly createdAtMs?: number
}

export type DurableAgentEventIdInput = {
  readonly streamId: string
  readonly turn: number
  readonly eventSequence: number
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
  readonly turn: number
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
    error: unknown
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
  `${input.streamId}:${input.turn}:${input.eventSequence}`

export const sequenceDurableAgentEvent = <Event extends object>(
  input: SequenceDurableAgentEventInput<Event>
): SequencedDurableAgentEvent<Event> => {
  const eventSequence = input.state.eventSequence
  const nextEventSequence = eventSequence + 1

  type SequencedDurableAgentEventFields = Event & {
    eventId: string
    createdAtMs?: number
  }

  const event: SequencedDurableAgentEventFields = {
    ...input.event,
    eventId: durableAgentEventId({
      streamId: input.streamId,
      turn: input.turn,
      eventSequence
    })
  }

  if (input.createdAtMs !== undefined) {
    event.createdAtMs = input.createdAtMs
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

export const writeDurableAgentEvent = <Event extends object>(
  input: WriteDurableAgentEventInput<Event>
): Effect.Effect<SequencedDurableAgentEvent<Event>, unknown> =>
  Effect.gen(function* () {
    const sequenced = sequenceDurableAgentEvent(input)
    yield* Effect.tryPromise({
      try: () => input.writer.write(encodeDurableAgentEventNdjson(sequenced.event)),
      catch: cause => cause
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
