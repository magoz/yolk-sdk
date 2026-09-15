import { describe, expect, it } from 'vitest'
import { Cause, Effect, Exit } from 'effect'
import {
  commitThenWriteTerminalEvent,
  durableAgentEventId,
  makeDurableAgentEventSequencerState,
  sequenceDurableAgentEvent,
  writeDurableAgentEvent
} from '../src/workflow.ts'
import { CommitThenWriteTerminalEventResult } from '../src/workflow-events.ts'

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

    expect(first.event).toEqual({
      _tag: 'LLMTextDelta',
      text: 'hej',
      eventId: 'workflow:run-1:2:4',
      createdAtMs: 123
    })
    expect(first.nextEventSequence).toBe(5)
    expect(second.event).toEqual({
      _tag: 'LLMTextDelta',
      text: ' då',
      eventId: 'workflow:run-1:2:5'
    })
    expect(Object.hasOwn(second.event, 'createdAtMs')).toBe(false)
    expect(second.nextEventSequence).toBe(6)
  })

  it('omits createdAtMs unless supplied, keeps event createdAtMs when override is absent, and overwrites eventId in place', () => {
    const omitted = sequenceDurableAgentEvent({
      state: makeDurableAgentEventSequencerState(4),
      streamId: 'workflow:run-1',
      turn: 2,
      event: { text: 'hej' }
    })

    expect(Object.keys(omitted.event)).toEqual(['text', 'eventId'])
    expect(Object.hasOwn(omitted.event, 'createdAtMs')).toBe(false)
    expect(JSON.stringify(omitted.event)).toBe('{"text":"hej","eventId":"workflow:run-1:2:4"}')

    const present = sequenceDurableAgentEvent({
      state: makeDurableAgentEventSequencerState(4),
      streamId: 'workflow:run-1',
      turn: 2,
      event: { text: 'hej' },
      createdAtMs: 123
    })

    expect(Object.keys(present.event)).toEqual(['text', 'eventId', 'createdAtMs'])
    expect(JSON.stringify(present.event)).toBe(
      '{"text":"hej","eventId":"workflow:run-1:2:4","createdAtMs":123}'
    )

    const kept = sequenceDurableAgentEvent({
      state: makeDurableAgentEventSequencerState(4),
      streamId: 'workflow:run-1',
      turn: 2,
      event: { text: 'hej', createdAtMs: 5 }
    })

    expect(kept.event.createdAtMs).toBe(5)
    expect(Object.keys(kept.event)).toEqual(['text', 'createdAtMs', 'eventId'])

    const overwritten = sequenceDurableAgentEvent({
      state: makeDurableAgentEventSequencerState(4),
      streamId: 'workflow:run-1',
      turn: 2,
      event: { eventId: 'stale', text: 'hej' }
    })

    expect(overwritten.event.eventId).toBe('workflow:run-1:2:4')
    expect(Object.keys(overwritten.event)).toEqual(['eventId', 'text'])
  })

  it('sequences error events through the same path', () => {
    const result = sequenceDurableAgentEvent({
      state: makeDurableAgentEventSequencerState(),
      streamId: 'workflow:run-1',
      turn: 1,
      event: { _tag: 'AgentError', code: 'unknown', message: 'Nope', retryable: false }
    })

    expect(result.event).toEqual({
      _tag: 'AgentError',
      code: 'unknown',
      message: 'Nope',
      retryable: false,
      eventId: 'workflow:run-1:1:0'
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

    expect(result.event).toEqual({
      _tag: 'LLMTextDelta',
      text: 'hej',
      eventId: 'workflow:run-1:1:0'
    })
    expect(result.nextEventSequence).toBe(1)
    expect(chunks).toHaveLength(1)
    expect(new TextDecoder().decode(firstChunk)).toBe(
      '{"_tag":"LLMTextDelta","text":"hej","eventId":"workflow:run-1:1:0"}\n'
    )
  })

  it('commits before writing terminal events', async () => {
    const operations: Array<string> = []
    const terminal = { text: 'last' }
    let written: typeof terminal | undefined

    const result = await Effect.runPromise(
      commitThenWriteTerminalEvent({
        terminal,
        commit: Effect.sync(() => {
          operations.push('commit')
        }),
        write: event =>
          Effect.sync(() => {
            written = event
            operations.push(`write:${event.text}`)

            return { nextEventSequence: 2 }
          }),
        writeCommitError: () =>
          Effect.sync(() => {
            operations.push('write-error')

            return { nextEventSequence: 2 }
          })
      })
    )

    expect(operations).toEqual(['commit', 'write:last'])
    expect(written).toBe(terminal)
    expect(result._tag).toBe('Committed')
    expect(result).toMatchObject({ writeResult: { nextEventSequence: 2 } })
  })

  it('writes terminal error when commit fails', async () => {
    const operations: Array<string> = []
    const commitError = new Error('commit failed')
    const terminal = { text: 'end' }

    const result = await Effect.runPromise(
      commitThenWriteTerminalEvent({
        terminal,
        commit: Effect.gen(function* () {
          yield* Effect.sync(() => {
            operations.push('commit')
          })
          yield* Effect.fail(commitError)
        }),
        write: event =>
          Effect.sync(() => {
            operations.push(`write:${event.text}`)

            return event
          }),
        writeCommitError: error =>
          Effect.sync(() => {
            operations.push(error === commitError ? 'write-error:commit' : 'write-error:unknown')

            return { written: true }
          })
      })
    )

    expect(operations).toEqual(['commit', 'write-error:commit'])
    expect(result).toMatchObject(
      CommitThenWriteTerminalEventResult.CommitFailed({
        commitError,
        writeResult: { written: true }
      })
    )
  })

  it('reports terminal write failures', async () => {
    const operations: Array<string> = []
    const writeError = new Error('write failed')
    const terminal = { text: 'end' }

    const result = await Effect.runPromise(
      commitThenWriteTerminalEvent({
        terminal,
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

            return { written: true }
          })
      })
    )

    expect(operations).toEqual(['commit', 'write'])
    expect(result).toEqual(
      CommitThenWriteTerminalEventResult.TerminalWriteFailed({ error: writeError })
    )
  })

  it('reports commit error terminal write failures', async () => {
    const operations: Array<string> = []
    const commitError = new Error('commit failed')
    const writeError = new Error('write commit error failed')
    const terminal = { text: 'end' }

    const result = await Effect.runPromise(
      commitThenWriteTerminalEvent({
        terminal,
        commit: Effect.gen(function* () {
          yield* Effect.sync(() => {
            operations.push('commit')
          })

          yield* Effect.fail(commitError)
        }),
        write: event =>
          Effect.sync(() => {
            operations.push(`write:${event.text}`)

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
    expect(result).toEqual(
      CommitThenWriteTerminalEventResult.CommitErrorWriteFailed({
        commitError,
        error: writeError
      })
    )
  })

  it('passes typed non-Error commit failures by identity to writeCommitError', async () => {
    const operations: Array<string> = []
    const commitError = { reason: 'commit-denied' }
    let captured: typeof commitError | undefined
    const terminal = { text: 'commit-denied-terminal' }

    const result = await Effect.runPromise(
      commitThenWriteTerminalEvent({
        terminal,
        commit: Effect.gen(function* () {
          yield* Effect.sync(() => {
            operations.push('commit')
          })
          yield* Effect.fail(commitError)
        }),
        write: event =>
          Effect.sync(() => {
            operations.push(`write:${event.text}`)

            return event
          }),
        writeCommitError: error =>
          Effect.sync(() => {
            captured = error
            operations.push(
              error === commitError && error.reason === 'commit-denied'
                ? 'write-error:commit'
                : 'write-error:unknown'
            )

            return { written: true }
          })
      })
    )

    expect(operations).toEqual(['commit', 'write-error:commit'])
    expect(terminal.text).toBe('commit-denied-terminal')
    expect(captured).toBe(commitError)
    expect(result).toEqual(
      CommitThenWriteTerminalEventResult.CommitFailed({
        commitError,
        writeResult: { written: true }
      })
    )
  })

  it('does not route commit defects through writeCommitError', async () => {
    const operations: Array<string> = []
    const defect = { phase: 'commit' }
    const terminal = { text: 'defect-terminal' }

    const exit = await Effect.runPromiseExit(
      commitThenWriteTerminalEvent({
        terminal,
        commit: Effect.gen(function* () {
          yield* Effect.sync(() => {
            operations.push('commit')
          })
          yield* Effect.die(defect)
        }),
        write: event =>
          Effect.sync(() => {
            operations.push(`write:${event.text}`)

            return event
          }),
        writeCommitError: () =>
          Effect.sync(() => {
            operations.push('write-error')

            return { written: true }
          })
      })
    )

    expect(operations).toEqual(['commit'])
    expect(terminal.text).toBe('defect-terminal')
    expect(Exit.isFailure(exit)).toBe(true)

    if (!Exit.isFailure(exit)) {
      throw new Error('expected commit defect to bypass writeCommitError')
    }

    expect(Cause.hasDies(exit.cause)).toBe(true)
    expect(Cause.hasFails(exit.cause)).toBe(false)
    expect(Cause.squash(exit.cause)).toBe(defect)
  })
})
