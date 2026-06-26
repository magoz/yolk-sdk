import { describe, expect, it } from 'vitest'
import {
  durableAgentEventId,
  makeDurableAgentEventSequencerState,
  sequenceDurableAgentEvent,
  writeDurableAgentEvent
} from '../src/workflow.ts'

describe('durable workflow agent events', () => {
  it('builds stable event ids from stream, turn, and sequence', () => {
    expect(
      durableAgentEventId({ streamId: 'workflow:run-1', turn: 2, eventSequence: 3 })
    ).toBe('workflow:run-1:2:3')
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

    const result = await writeDurableAgentEvent({
      writer,
      state: makeDurableAgentEventSequencerState(),
      streamId: 'workflow:run-1',
      turn: 1,
      event: { _tag: 'LLMTextDelta', text: 'hej' }
    })
    writer.releaseLock()

    const firstChunk = chunks[0]
    if (firstChunk === undefined) throw new Error('Missing NDJSON chunk')

    expect(result.event.eventId).toBe('workflow:run-1:1:0')
    expect(new TextDecoder().decode(firstChunk)).toBe(
      `${JSON.stringify(result.event)}\n`
    )
  })
})
