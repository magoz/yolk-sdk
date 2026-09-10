import { Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentEvent,
  BackgroundToolAccepted,
  ToolCall,
  ToolExecutionAccepted,
  ToolExecutionStarted,
  makeBackgroundToolAcceptedResult
} from '@yolk-sdk/agent/protocol'
import {
  applyAgentEvent,
  completedToolRuns,
  initialAgentClientState,
  isActiveToolRun
} from '../../src/client/state.ts'
import {
  applyAgentEventToChatMessages,
  buildAgentChatMessages,
  toAgentMessages
} from '../../src/react/chat-messages.ts'
import { buildAgentChatItems } from '../../src/react/chat-items.ts'
import { getActiveChatToolParts, getCompletedChatToolParts } from '../../src/react/chat-core.ts'

const call = ToolCall.make({
  id: 'work',
  name: 'work',
  params: { execution: 'background', arguments: {} }
})
const result = makeBackgroundToolAcceptedResult({
  toolCallId: call.id,
  acceptance: BackgroundToolAccepted.make({ version: 1, executionId: 'owner:work' })
})
const accepted = ToolExecutionAccepted.make({
  call,
  result,
  eventId: 'accepted:work',
  createdAtMs: 20
})
const started = ToolExecutionStarted.make({ call, createdAtMs: 10 })

describe('background acceptance projection', () => {
  it.effect('round trips the receipt in the distinct wire event', () =>
    Effect.gen(function* () {
      const wire = yield* Schema.encodeEffect(AgentEvent)(accepted)
      const decoded = yield* Schema.decodeUnknownEffect(AgentEvent)(
        JSON.parse(JSON.stringify(wire))
      )
      expect(decoded).toEqual(accepted)
    })
  )

  it('settles client pending input without claiming execution completion and deduplicates receipt replay', () => {
    const state = applyAgentEvent(applyAgentEvent(initialAgentClientState, started), accepted)
    expect(state.toolRuns[0]).toMatchObject({ _tag: 'Accepted', result })
    expect(state.toolRuns.some(isActiveToolRun)).toBe(false)
    expect(completedToolRuns(state.toolRuns)).toEqual([])
    expect(applyAgentEvent(state, accepted)).toEqual(state)
  })

  it('preserves one acknowledgement through live cards, transcript serialization and cold replay', () => {
    const chat = applyAgentEventToChatMessages(applyAgentEventToChatMessages([], started), accepted)
    const items = buildAgentChatItems({
      messages: chat,
      isRunning: false,
      activeToolLabel: Option.none()
    })
    expect(items.filter(item => item._tag === 'ToolRun')).toMatchObject([
      { state: { _tag: 'Accepted', result } }
    ])
    // Acceptance settles the card: it is neither an active spinner nor a completed execution.
    expect(getActiveChatToolParts(chat)).toEqual([])
    expect(getCompletedChatToolParts(chat)).toEqual([])
    const transcript = toAgentMessages(chat)
    expect(transcript.filter(message => message._tag === 'ToolResult')).toMatchObject([
      { toolCallId: call.id, acceptance: result.acceptance }
    ])
    const replay = buildAgentChatMessages({
      messages: transcript,
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [],
      error: null
    })
    const replayItems = buildAgentChatItems({
      messages: replay,
      isRunning: false,
      activeToolLabel: Option.none()
    })
    expect(replayItems.filter(item => item._tag === 'ToolRun')).toMatchObject([
      { state: { _tag: 'Accepted', result } }
    ])
    expect(toAgentMessages(replay).filter(message => message._tag === 'ToolResult')).toHaveLength(1)
    // A late replayed Started event must not turn the settled card back into a spinner.
    expect(applyAgentEventToChatMessages(chat, started)).toEqual(chat)
  })
})
