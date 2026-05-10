import { describe, expect, it } from '@effect/vitest'
import { initialAgentClientState } from '@yolk/client'
import { LLMReasoningDelta, UserMessage } from '@yolk/protocol'
import {
  getAgentChatLiveActivityCount,
  hasAgentChatReasoningSummary,
  reduceAgentChatState
} from './agent-chat-core'

describe('agent chat core', () => {
  it('submits user messages through the headless reducer', () => {
    const message = UserMessage.make({ content: 'hello' })
    const state = reduceAgentChatState(initialAgentClientState, { _tag: 'Submit', message })

    expect(state.status).toBe('running')
    expect(state.messages).toEqual([message])
    expect(state.error).toBeNull()
  })

  it('detects streaming reasoning summaries', () => {
    const state = reduceAgentChatState(initialAgentClientState, {
      _tag: 'Event',
      event: LLMReasoningDelta.make({ text: 'Need a tool.' })
    })

    expect(hasAgentChatReasoningSummary(state)).toBe(true)
  })

  it('counts active text, tool, and voice work', () => {
    expect(
      getAgentChatLiveActivityCount({
        isTextRunning: true,
        activeToolCallCount: 2,
        isVoiceActive: true
      })
    ).toBe(4)
  })
})
