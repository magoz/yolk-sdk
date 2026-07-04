import { describe, expect, it } from '@effect/vitest'
import * as Schema from 'effect/Schema'
import {
  emptyVoiceSessionLogState,
  foldStoredVoiceEvents,
  initialVoiceEventSequencerState,
  sequenceVoiceEvent,
  StoredVoiceEvent,
  storedToolEventsFromOutcome,
  storedVoiceToolEvents,
  VoiceAssistantTranscriptDelta,
  VoiceAssistantTranscriptFinal,
  VoiceSessionLogState,
  VoiceToolCall,
  VoiceToolCallCompleted,
  VoiceToolCallDeniedOutcome,
  VoiceToolCallExecutedOutcome,
  VoiceToolCallsRequested,
  voiceToolEventId,
  VoiceUserTranscriptFinal
} from '../../src/voice/index.ts'

const sequencedEvents = (
  streamId: string,
  events: ReadonlyArray<Parameters<typeof sequenceVoiceEvent>[2]>
) => {
  let state = initialVoiceEventSequencerState

  return events.map(event => {
    const result = sequenceVoiceEvent(streamId, state, event)
    state = result.state

    return result.stored
  })
}

const call = VoiceToolCall.make({
  callId: 'call-1',
  name: 'web_search',
  argumentsJson: '{"query":"weather"}'
})

describe('foldStoredVoiceEvents', () => {
  it('folds a turn into durable messages and carries state across batches', () => {
    const [userFinal, delta] = sequencedEvents('session-1', [
      VoiceUserTranscriptFinal.make({ itemId: 'item-1', text: 'Hello there' }),
      VoiceAssistantTranscriptDelta.make({ itemId: 'item-2', responseId: 'resp-1', delta: 'Hi ' })
    ])
    const first = foldStoredVoiceEvents(emptyVoiceSessionLogState, [userFinal, delta])

    expect(first.messages).toMatchObject([{ _tag: 'User', content: 'Hello there' }])
    expect(first.state.assistantDrafts).toEqual([{ key: 'item-2', text: 'Hi ' }])

    const second = foldStoredVoiceEvents(first.state, [
      StoredVoiceEvent.make({
        eventId: 'session-1:2',
        event: VoiceAssistantTranscriptFinal.make({
          itemId: 'item-2',
          responseId: 'resp-1',
          text: 'Hi friend.'
        })
      })
    ])

    expect(second.messages).toMatchObject([
      { _tag: 'Assistant', parts: [{ _tag: 'Text', content: 'Hi friend.' }] }
    ])
    expect(second.state.assistantDrafts).toEqual([])
  })

  it('skips already-folded event ids across batches and within a batch', () => {
    const [stored] = sequencedEvents('session-1', [
      VoiceUserTranscriptFinal.make({ itemId: 'item-1', text: 'Only once' })
    ])
    const first = foldStoredVoiceEvents(emptyVoiceSessionLogState, [stored, stored])

    expect(first.messages).toHaveLength(1)

    const replay = foldStoredVoiceEvents(first.state, [stored])

    expect(replay.messages).toHaveLength(0)
    expect(replay.state.seenEventIds).toEqual(first.state.seenEventIds)
  })

  it('dedupes client-replayed and server-witnessed tool events', () => {
    const clientBatch = storedVoiceToolEvents(VoiceToolCallsRequested.make({ calls: [call] }))
    const serverBatch = storedToolEventsFromOutcome({
      call,
      outcome: VoiceToolCallExecutedOutcome.make({ callId: 'call-1', output: '{"ok":true}' })
    })
    const afterServer = foldStoredVoiceEvents(emptyVoiceSessionLogState, serverBatch)
    const afterClient = foldStoredVoiceEvents(afterServer.state, [
      ...clientBatch,
      ...storedVoiceToolEvents(
        VoiceToolCallCompleted.make({ callId: 'call-1', output: '{"ok":true}' })
      )
    ])

    expect(afterClient.messages).toHaveLength(0)
    expect(afterServer.state.turnToolCalls).toHaveLength(1)
    expect(afterClient.state.turnToolCalls).toHaveLength(1)
    expect(afterClient.state.turnToolResults).toHaveLength(1)

    const flushed = foldStoredVoiceEvents(afterClient.state, [
      StoredVoiceEvent.make({
        eventId: 'session-1:9',
        event: VoiceAssistantTranscriptFinal.make({
          itemId: 'item-9',
          responseId: 'resp-9',
          text: 'It is sunny.'
        })
      })
    ])

    expect(flushed.messages).toMatchObject([
      { _tag: 'Assistant', parts: [{ _tag: 'Text' }, { _tag: 'HostToolCall' }] },
      { _tag: 'ToolResult', toolCallId: 'call-1' },
      { _tag: 'Assistant', parts: [{ _tag: 'Text', content: 'It is sunny.' }] }
    ])
  })

  it('round-trips state through its schema between batches', () => {
    const [stored] = sequencedEvents('session-1', [
      VoiceAssistantTranscriptDelta.make({ itemId: 'item-1', responseId: 'resp-1', delta: 'Par' })
    ])
    const folded = foldStoredVoiceEvents(emptyVoiceSessionLogState, [stored])
    const encoded = Schema.encodeUnknownSync(VoiceSessionLogState)(folded.state)
    const decoded = Schema.decodeUnknownSync(VoiceSessionLogState)(
      JSON.parse(JSON.stringify(encoded))
    )
    const resumed = foldStoredVoiceEvents(decoded, [
      StoredVoiceEvent.make({
        eventId: 'session-1:1',
        event: VoiceAssistantTranscriptFinal.make({
          itemId: 'item-1',
          responseId: 'resp-1',
          text: null
        })
      })
    ])

    expect(resumed.messages).toMatchObject([
      { _tag: 'Assistant', parts: [{ _tag: 'Text', content: 'Par' }] }
    ])
  })

  it('rejects persisted state from another version', () => {
    const encoded = Schema.encodeUnknownSync(VoiceSessionLogState)(emptyVoiceSessionLogState)
    const stale = { ...encoded, version: 999 }

    expect(() => Schema.decodeUnknownSync(VoiceSessionLogState)(stale)).toThrow()
  })
})

describe('tool event identity', () => {
  it('splits requested batches into per-call deterministic ids', () => {
    const other = VoiceToolCall.make({ callId: 'call-2', name: 'web_fetch', argumentsJson: '{}' })
    const stored = storedVoiceToolEvents(VoiceToolCallsRequested.make({ calls: [call, other] }))

    expect(stored.map(entry => entry.eventId)).toEqual([
      voiceToolEventId('call-1', 'requested'),
      voiceToolEventId('call-2', 'requested')
    ])
    expect(stored.map(entry => entry.event)).toMatchObject([
      { _tag: 'ToolCallsRequested', calls: [{ callId: 'call-1' }] },
      { _tag: 'ToolCallsRequested', calls: [{ callId: 'call-2' }] }
    ])
  })

  it('maps denied outcomes to failed events with the controller denial message', () => {
    const stored = storedToolEventsFromOutcome({
      call,
      outcome: VoiceToolCallDeniedOutcome.make({
        callId: 'call-1',
        output: '{"error":"denied"}',
        reason: 'not allowed'
      })
    })

    expect(stored.map(entry => entry.eventId)).toEqual([
      voiceToolEventId('call-1', 'requested'),
      voiceToolEventId('call-1', 'failed')
    ])
    expect(stored[1]?.event).toMatchObject({
      _tag: 'ToolCallFailed',
      message: 'Tool was denied: not allowed'
    })
  })
})

describe('projection preserve-heard rule', () => {
  it('keeps streamed draft text when a final arrives with an empty transcript', () => {
    const [delta] = sequencedEvents('session-1', [
      VoiceAssistantTranscriptDelta.make({
        itemId: 'item-1',
        responseId: 'resp-1',
        delta: 'Already heard text'
      })
    ])
    const first = foldStoredVoiceEvents(emptyVoiceSessionLogState, [delta])
    const flushed = foldStoredVoiceEvents(first.state, [
      StoredVoiceEvent.make({
        eventId: 'session-1:1',
        event: VoiceAssistantTranscriptFinal.make({
          itemId: 'item-1',
          responseId: 'resp-1',
          text: ''
        })
      })
    ])

    expect(flushed.messages).toMatchObject([
      { _tag: 'Assistant', parts: [{ _tag: 'Text', content: 'Already heard text' }] }
    ])
  })
})
