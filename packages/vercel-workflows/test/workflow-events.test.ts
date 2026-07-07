import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import {
  commitThenWriteTerminalEvent,
  durableAgentEventId,
  makeDurableAgentEventSequencerState,
  sequenceDurableAgentEvent,
  writeDurableAgentEvent
} from '../src/workflow.ts'

describe('durable workflow agent events', () => {
  it('builds stable event ids from stream, turn, and sequence', () => {
    expect(durableAgentEventId({ streamId: 'workflow:run-1', turn: 2, eventSequence: 3 })).toBe(
      'workflow:run-1:2:3'
    )
  })

  it('sequences normal events monotonically', () => {
    const first = sequenceDurableAgentEvent({
      state: makeDurableAgentEventSequencerState(4),
      streamId: 'workflow:run-1',
      turn: 2,
      event: { _tag: 'LLMTextDelta', text: 'hej' },
      createdAtMs: 123
    })
    const second = sequenceDurableAgentEvent({
      state: first.nextState,
      streamId: 'workflow:run-1',
      turn: 2,
      event: { _tag: 'LLMTextDelta', text: ' då' }
    })

    expect(first.event).toMatchObject({
      _tag: 'LLMTextDelta',
      text: 'hej',
      eventId: 'workflow:run-1:2:4',
      createdAtMs: 123
    })
    expect(first.event.createdAtMs).toBe(123)
    expect(first.nextEventSequence).toBe(5)
    expect(second.event).toMatchObject({
      _tag: 'LLMTextDelta',
      text: ' då',
      eventId: 'workflow:run-1:2:5'
    })
    expect(second.nextEventSequence).toBe(6)
  })

  it('sequences error events through the same path', () => {
    const result = sequenceDurableAgentEvent({
      state: makeDurableAgentEventSequencerState(),
      streamId: 'workflow:run-1',
      turn: 1,
      event: { _tag: 'AgentError', code: 'unknown', message: 'Nope', retryable: false }
    })

    expect(result.event).toMatchObject({
      _tag: 'AgentError',
      eventId: 'workflow:run-1:1:0',
      message: 'Nope'
    })
    expect(result.nextState).toEqual({ eventSequence: 1 })
  })

  it('writes sequenced NDJSON', async () => {
    const chunks: Array<Uint8Array> = []
    const writable = new WritableStream<Uint8Array>({
      write: chunk => {
        chunks.push(chunk)
      }
    })
    const writer = writable.getWriter()

    const result = await Effect.runPromise(
      writeDurableAgentEvent({
        writer,
        state: makeDurableAgentEventSequencerState(),
        streamId: 'workflow:run-1',
        turn: 1,
        event: { _tag: 'LLMTextDelta', text: 'hej' }
      })
    )
    writer.releaseLock()

    const firstChunk = chunks[0]
    if (firstChunk === undefined) throw new Error('Missing NDJSON chunk')

    expect(result.event.eventId).toBe('workflow:run-1:1:0')
    expect(new TextDecoder().decode(firstChunk)).toBe(`${JSON.stringify(result.event)}\n`)
  })

  it('commits before writing terminal events', async () => {
    const operations: Array<string> = []
    const result = await Effect.runPromise(
      commitThenWriteTerminalEvent({
        terminal: { _tag: 'AgentEnd' },
        commit: Effect.sync(() => {
          operations.push('commit')
        }),
        write: event =>
          Effect.sync(() => {
            operations.push(`write:${event._tag}`)

            return { nextEventSequence: 2 }
          }),
        writeCommitError: () =>
          Effect.sync(() => {
            operations.push('write-error')

            return { nextEventSequence: 2 }
          })
      })
    )

    expect(operations).toEqual(['commit', 'write:AgentEnd'])
    expect(result).toMatchObject({
      _tag: 'Committed',
      writeResult: { nextEventSequence: 2 }
    })
  })

  it('writes terminal error when commit fails', async () => {
    const operations: Array<string> = []
    const commitError = new Error('commit failed')
    const result = await Effect.runPromise(
      commitThenWriteTerminalEvent({
        terminal: { _tag: 'AgentEnd' },
        commit: Effect.gen(function* () {
          yield* Effect.sync(() => {
            operations.push('commit')
          })
          yield* Effect.fail(commitError)
        }),
        write: event =>
          Effect.sync(() => {
            operations.push(`write:${event._tag}`)

            return event
          }),
        writeCommitError: error =>
          Effect.sync(() => {
            operations.push(error === commitError ? 'write-error:commit' : 'write-error:unknown')

            return { _tag: 'AgentError' }
          })
      })
    )

    expect(operations).toEqual(['commit', 'write-error:commit'])
    expect(result).toMatchObject({
      _tag: 'CommitFailed',
      commitError,
      writeResult: { _tag: 'AgentError' }
    })
  })

  it('reports terminal write failures', async () => {
    const operations: Array<string> = []
    const writeError = new Error('write failed')
    const result = await Effect.runPromise(
      commitThenWriteTerminalEvent({
        terminal: { _tag: 'AgentEnd' },
        commit: Effect.sync(() => {
          operations.push('commit')
        }),
        write: () =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              operations.push('write')
            })

            return yield* Effect.fail(writeError)
          }),
        writeCommitError: () =>
          Effect.sync(() => {
            operations.push('write-error')

            return { _tag: 'AgentError' }
          })
      })
    )

    expect(operations).toEqual(['commit', 'write'])
    expect(result).toEqual({
      _tag: 'TerminalWriteFailed',
      error: writeError
    })
  })

  it('reports commit error terminal write failures', async () => {
    const operations: Array<string> = []
    const commitError = new Error('commit failed')
    const writeError = new Error('write commit error failed')
    const result = await Effect.runPromise(
      commitThenWriteTerminalEvent({
        terminal: { _tag: 'AgentEnd' },
        commit: Effect.gen(function* () {
          yield* Effect.sync(() => {
            operations.push('commit')
          })

          yield* Effect.fail(commitError)
        }),
        write: event =>
          Effect.sync(() => {
            operations.push(`write:${event._tag}`)

            return event
          }),
        writeCommitError: error =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              operations.push(error === commitError ? 'write-error:commit' : 'write-error:unknown')
            })

            return yield* Effect.fail(writeError)
          })
      })
    )

    expect(operations).toEqual(['commit', 'write-error:commit'])
    expect(result).toEqual({
      _tag: 'CommitErrorWriteFailed',
      commitError,
      error: writeError
    })
  })
})
