import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  AssistantTextPart,
  HostToolCallPart,
  ToolCall,
  UserMessage,
  validateNoDanglingHostToolCalls,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'
import {
  dedupeStoredVoiceEvents,
  emptyVoiceProjectionState,
  initialVoiceEventSequencerState,
  projectVoiceEvent,
  sequenceVoiceEvent,
  VoiceAssistantTranscriptDelta,
  VoiceAssistantTranscriptFinal,
  VoiceInterrupted,
  VoiceSessionClosed,
  VoiceToolCall,
  VoiceToolCallCompleted,
  VoiceToolCallFailed,
  VoiceToolCallsRequested,
  VoiceUserTranscriptFinal,
  voiceSeedTextsFromMessages,
  type VoiceEvent,
  type VoiceProjectionState
} from '../../src/voice/index.ts'

const project = (events: ReadonlyArray<VoiceEvent>) => {
  let state: VoiceProjectionState = emptyVoiceProjectionState
  const messages: Array<AgentMessage> = []

  for (const event of events) {
    const result = projectVoiceEvent(state, event)
    state = result.state
    messages.push(...result.messages)
  }

  return { state, messages }
}

describe('projectVoiceEvent', () => {
  it('projects final user transcripts to user messages', () => {
    const { messages } = project([
      VoiceUserTranscriptFinal.make({ itemId: 'item_1', text: 'What is the weather?' })
    ])

    expect(messages).toEqual([UserMessage.make({ content: 'What is the weather?' })])
  })

  it('flushes assistant turns with final transcript over accumulated draft', () => {
    const { messages, state } = project([
      VoiceAssistantTranscriptDelta.make({ itemId: 'i', responseId: 'r', delta: 'Hel' }),
      VoiceAssistantTranscriptDelta.make({ itemId: 'i', responseId: 'r', delta: 'lo' }),
      VoiceAssistantTranscriptFinal.make({ itemId: 'i', responseId: 'r', text: 'Hello there.' })
    ])

    expect(messages).toEqual([
      AssistantAgentMessage.make({
        parts: [AssistantTextPart.make({ content: 'Hello there.' })]
      })
    ])
    expect(state).toEqual(emptyVoiceProjectionState)
  })

  it('flushes settled tool pairs before the assistant text without dangling calls', () => {
    const calls = VoiceToolCallsRequested.make({
      calls: [
        VoiceToolCall.make({ callId: 'call_1', name: 'web_search', argumentsJson: '{"q":"x"}' }),
        VoiceToolCall.make({ callId: 'call_2', name: 'web_fetch', argumentsJson: '{broken' })
      ]
    })
    const { messages } = project([
      calls,
      VoiceToolCallCompleted.make({ callId: 'call_1', output: '{"result":1}' }),
      VoiceToolCallFailed.make({ callId: 'call_2', message: 'fetch failed' }),
      VoiceAssistantTranscriptFinal.make({ itemId: 'i', responseId: 'r', text: 'Done.' })
    ])

    expect(messages).toHaveLength(4)
    expect(messages[0]).toEqual(
      AssistantAgentMessage.make({
        parts: [
          AssistantTextPart.make({ content: '' }),
          HostToolCallPart.make({
            call: ToolCall.make({ id: 'call_1', name: 'web_search', params: { q: 'x' } })
          }),
          HostToolCallPart.make({
            call: ToolCall.make({ id: 'call_2', name: 'web_fetch', params: '{broken' })
          })
        ]
      })
    )
    expect(messages[1]).toMatchObject({ toolCallId: 'call_1', content: '{"result":1}' })
    expect(messages[2]).toMatchObject({ toolCallId: 'call_2', isError: true })
    expect(messages[3]).toMatchObject({ parts: [{ content: 'Done.' }] })
    expect(validateNoDanglingHostToolCalls(messages)).toEqual({ _tag: 'Valid' })
  })

  it('drops unsettled tool calls so interrupted sessions never persist dangling calls', () => {
    const { messages } = project([
      VoiceToolCallsRequested.make({
        calls: [VoiceToolCall.make({ callId: 'call_1', name: 'sandbox', argumentsJson: '{}' })]
      }),
      VoiceAssistantTranscriptDelta.make({ itemId: 'i', responseId: 'r', delta: 'Working on ' }),
      VoiceSessionClosed.make({ reason: 'data_channel_closed' })
    ])

    expect(messages).toEqual([
      AssistantAgentMessage.make({
        parts: [AssistantTextPart.make({ content: 'Working on ' })]
      })
    ])
    expect(validateNoDanglingHostToolCalls(messages)).toEqual({ _tag: 'Valid' })
  })

  it('flushes partial drafts on interruption', () => {
    const { messages } = project([
      VoiceAssistantTranscriptDelta.make({ itemId: 'i', responseId: 'r', delta: 'Let me ch' }),
      VoiceInterrupted.make({ responseId: 'r' })
    ])

    expect(messages).toEqual([
      AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'Let me ch' })] })
    ])
  })

  it('emits nothing for empty turns', () => {
    const { messages } = project([
      VoiceAssistantTranscriptFinal.make({ itemId: 'i', responseId: 'r', text: '  ' }),
      VoiceInterrupted.make({ responseId: 'r' }),
      VoiceSessionClosed.make({ reason: null })
    ])

    expect(messages).toEqual([])
  })
})

describe('voiceSeedTextsFromMessages', () => {
  it('maps user/assistant text and skips tool results', () => {
    const { messages } = project([
      VoiceUserTranscriptFinal.make({ itemId: 'i', text: 'Hi' }),
      VoiceToolCallsRequested.make({
        calls: [VoiceToolCall.make({ callId: 'call_1', name: 'web_search', argumentsJson: '{}' })]
      }),
      VoiceToolCallCompleted.make({ callId: 'call_1', output: '{"ok":1}' }),
      VoiceAssistantTranscriptFinal.make({ itemId: 'i', responseId: 'r', text: 'Hello!' })
    ])

    expect(voiceSeedTextsFromMessages(messages)).toEqual([
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hello!' }
    ])
  })
})

describe('voice durable event ids', () => {
  it('sequences deterministic ids and de-dupes replays', () => {
    const event = VoiceUserTranscriptFinal.make({ itemId: 'i', text: 'Hi' })
    const first = sequenceVoiceEvent('voice:session_1', initialVoiceEventSequencerState, event)
    const second = sequenceVoiceEvent('voice:session_1', first.state, event)

    expect(first.stored.eventId).toBe('voice:session_1:0')
    expect(second.stored.eventId).toBe('voice:session_1:1')

    const deduped = dedupeStoredVoiceEvents([first.stored, first.stored, second.stored])

    expect(deduped.map(stored => stored.eventId)).toEqual([
      'voice:session_1:0',
      'voice:session_1:1'
    ])
  })
})
