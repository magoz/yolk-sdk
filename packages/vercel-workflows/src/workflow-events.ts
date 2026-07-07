import { Effect } from 'effect'

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

export type TerminalEventCloseResult =
  | { readonly _tag: 'Closed' }
  | { readonly _tag: 'CloseFailed'; readonly error: unknown }

export type CommitThenWriteTerminalEventInput<
  TerminalEvent extends object,
  TerminalWriteResult,
  CommitErrorWriteResult
> = {
  readonly commit: () => Promise<void>
  readonly terminal: TerminalEvent
  readonly write: (event: TerminalEvent) => Promise<TerminalWriteResult>
  readonly writeCommitError: (error: unknown) => Promise<CommitErrorWriteResult>
  readonly close: () => Promise<void>
}

export type CommitThenWriteTerminalEventEffectInput<
  TerminalEvent extends object,
  TerminalWriteResult,
  CommitErrorWriteResult,
  CommitError,
  TerminalWriteError,
  CommitErrorWriteError,
  CloseError
> = {
  readonly commit: Effect.Effect<void, CommitError>
  readonly terminal: TerminalEvent
  readonly write: (event: TerminalEvent) => Effect.Effect<TerminalWriteResult, TerminalWriteError>
  readonly writeCommitError: (
    error: unknown
  ) => Effect.Effect<CommitErrorWriteResult, CommitErrorWriteError>
  readonly close: Effect.Effect<void, CloseError>
}

export type CommitThenWriteTerminalEventResult<TerminalWriteResult, CommitErrorWriteResult> =
  | {
      readonly _tag: 'Committed'
      readonly writeResult: TerminalWriteResult
      readonly closeResult: TerminalEventCloseResult
    }
  | {
      readonly _tag: 'CommitFailed'
      readonly commitError: unknown
      readonly writeResult: CommitErrorWriteResult
      readonly closeResult: TerminalEventCloseResult
    }
  | {
      readonly _tag: 'TerminalWriteFailed'
      readonly error: unknown
      readonly closeResult: TerminalEventCloseResult
    }
  | {
      readonly _tag: 'CommitErrorWriteFailed'
      readonly commitError: unknown
      readonly error: unknown
      readonly closeResult: TerminalEventCloseResult
    }

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
  const event = {
    ...input.event,
    eventId: durableAgentEventId({
      streamId: input.streamId,
      turn: input.turn,
      eventSequence
    }),
    ...(input.createdAtMs === undefined ? {} : { createdAtMs: input.createdAtMs })
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

export const writeDurableAgentEventEffect = <Event extends object>(
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

export const writeDurableAgentEvent = async <Event extends object>(
  input: WriteDurableAgentEventInput<Event>
): Promise<SequencedDurableAgentEvent<Event>> =>
  Effect.runPromise(writeDurableAgentEventEffect(input))

const closedTerminalEventWriterResult = (): TerminalEventCloseResult => ({ _tag: 'Closed' })

const closeFailedTerminalEventWriterResult = (error: unknown): TerminalEventCloseResult => ({
  _tag: 'CloseFailed',
  error
})

const committedTerminalResult = <TerminalWriteResult, CommitErrorWriteResult>(
  writeResult: TerminalWriteResult,
  closeResult: TerminalEventCloseResult
): CommitThenWriteTerminalEventResult<TerminalWriteResult, CommitErrorWriteResult> => ({
  _tag: 'Committed',
  writeResult,
  closeResult
})

const commitFailedTerminalResult = <TerminalWriteResult, CommitErrorWriteResult>(
  commitError: unknown,
  writeResult: CommitErrorWriteResult,
  closeResult: TerminalEventCloseResult
): CommitThenWriteTerminalEventResult<TerminalWriteResult, CommitErrorWriteResult> => ({
  _tag: 'CommitFailed',
  commitError,
  writeResult,
  closeResult
})

const terminalWriteFailedResult = <TerminalWriteResult, CommitErrorWriteResult>(
  error: unknown,
  closeResult: TerminalEventCloseResult
): CommitThenWriteTerminalEventResult<TerminalWriteResult, CommitErrorWriteResult> => ({
  _tag: 'TerminalWriteFailed',
  error,
  closeResult
})

const commitErrorWriteFailedResult = <TerminalWriteResult, CommitErrorWriteResult>(
  commitError: unknown,
  error: unknown,
  closeResult: TerminalEventCloseResult
): CommitThenWriteTerminalEventResult<TerminalWriteResult, CommitErrorWriteResult> => ({
  _tag: 'CommitErrorWriteFailed',
  commitError,
  error,
  closeResult
})

const closeTerminalEventWriterEffect = <CloseError>(
  close: Effect.Effect<void, CloseError>
): Effect.Effect<TerminalEventCloseResult, never> =>
  close.pipe(
    Effect.match({
      onFailure: closeFailedTerminalEventWriterResult,
      onSuccess: () => closedTerminalEventWriterResult()
    })
  )

export const commitThenWriteTerminalEventEffect = <
  TerminalEvent extends object,
  TerminalWriteResult,
  CommitErrorWriteResult,
  CommitError,
  TerminalWriteError,
  CommitErrorWriteError,
  CloseError
>(
  input: CommitThenWriteTerminalEventEffectInput<
    TerminalEvent,
    TerminalWriteResult,
    CommitErrorWriteResult,
    CommitError,
    TerminalWriteError,
    CommitErrorWriteError,
    CloseError
  >
): Effect.Effect<
  CommitThenWriteTerminalEventResult<TerminalWriteResult, CommitErrorWriteResult>,
  never
> =>
  input.commit.pipe(
    Effect.matchEffect({
      onFailure: commitError =>
        input.writeCommitError(commitError).pipe(
          Effect.matchEffect({
            onFailure: error =>
              closeTerminalEventWriterEffect(input.close).pipe(
                Effect.map(closeResult =>
                  commitErrorWriteFailedResult<TerminalWriteResult, CommitErrorWriteResult>(
                    commitError,
                    error,
                    closeResult
                  )
                )
              ),
            onSuccess: writeResult =>
              closeTerminalEventWriterEffect(input.close).pipe(
                Effect.map(closeResult =>
                  commitFailedTerminalResult<TerminalWriteResult, CommitErrorWriteResult>(
                    commitError,
                    writeResult,
                    closeResult
                  )
                )
              )
          })
        ),
      onSuccess: () =>
        input.write(input.terminal).pipe(
          Effect.matchEffect({
            onFailure: error =>
              closeTerminalEventWriterEffect(input.close).pipe(
                Effect.map(closeResult =>
                  terminalWriteFailedResult<TerminalWriteResult, CommitErrorWriteResult>(
                    error,
                    closeResult
                  )
                )
              ),
            onSuccess: writeResult =>
              closeTerminalEventWriterEffect(input.close).pipe(
                Effect.map(closeResult =>
                  committedTerminalResult<TerminalWriteResult, CommitErrorWriteResult>(
                    writeResult,
                    closeResult
                  )
                )
              )
          })
        )
    })
  )

export const commitThenWriteTerminalEvent = async <
  TerminalEvent extends object,
  TerminalWriteResult,
  CommitErrorWriteResult
>(
  input: CommitThenWriteTerminalEventInput<
    TerminalEvent,
    TerminalWriteResult,
    CommitErrorWriteResult
  >
): Promise<CommitThenWriteTerminalEventResult<TerminalWriteResult, CommitErrorWriteResult>> =>
  Effect.runPromise(
    commitThenWriteTerminalEventEffect({
      terminal: input.terminal,
      commit: Effect.tryPromise({
        try: input.commit,
        catch: cause => cause
      }),
      write: event =>
        Effect.tryPromise({
          try: () => input.write(event),
          catch: cause => cause
        }),
      writeCommitError: error =>
        Effect.tryPromise({
          try: () => input.writeCommitError(error),
          catch: cause => cause
        }),
      close: Effect.tryPromise({
        try: input.close,
        catch: cause => cause
      })
    })
  )
