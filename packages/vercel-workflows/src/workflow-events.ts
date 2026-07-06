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

export const writeDurableAgentEvent = async <Event extends object>(
  input: WriteDurableAgentEventInput<Event>
): Promise<SequencedDurableAgentEvent<Event>> => {
  const sequenced = sequenceDurableAgentEvent(input)
  await input.writer.write(encodeDurableAgentEventNdjson(sequenced.event))

  return sequenced
}

const closeTerminalEventWriter = async (
  close: () => Promise<void>
): Promise<TerminalEventCloseResult> => {
  try {
    await close()

    return { _tag: 'Closed' }
  } catch (error) {
    return { _tag: 'CloseFailed', error }
  }
}

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
): Promise<CommitThenWriteTerminalEventResult<TerminalWriteResult, CommitErrorWriteResult>> => {
  try {
    await input.commit()
  } catch (commitError) {
    try {
      const writeResult = await input.writeCommitError(commitError)
      const closeResult = await closeTerminalEventWriter(input.close)

      return { _tag: 'CommitFailed', commitError, writeResult, closeResult }
    } catch (error) {
      const closeResult = await closeTerminalEventWriter(input.close)

      return { _tag: 'CommitErrorWriteFailed', commitError, error, closeResult }
    }
  }

  try {
    const writeResult = await input.write(input.terminal)
    const closeResult = await closeTerminalEventWriter(input.close)

    return { _tag: 'Committed', writeResult, closeResult }
  } catch (error) {
    const closeResult = await closeTerminalEventWriter(input.close)

    return { _tag: 'TerminalWriteFailed', error, closeResult }
  }
}
