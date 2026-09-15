import { act, createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  type VoiceSessionError,
  VoiceSessionOpening,
  VoiceToolCallApprovalRequiredOutcome,
  VoiceToolCallExecutedOutcome,
  VoiceToolCall,
  VoiceToolCallsRequested,
  VoiceUserTranscriptDelta,
  VoiceUserTranscriptFinal,
  voiceApprovalRequestId,
  type VoiceClientCodec,
  type StoredVoiceEvent,
  type VoiceEvent,
  type VoiceToolCallOutcome
} from '../../src/voice/index.ts'
import {
  ToolApprovalPolicy,
  ToolApprovalRequest,
  ToolCall,
  type ToolApprovalResponse
} from '@yolk-sdk/agent/protocol'
import { useYolkVoice, type UseYolkVoiceOptions, type YolkVoiceApi } from '../../src/voice/react.ts'
import { listenerCount, makeFakeWorld, type FakeWorld } from './helpers/fake-webrtc.ts'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const readHook = (value: YolkVoiceApi | undefined) => {
  if (value === undefined) {
    throw new Error('Hook not rendered')
  }

  return value
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return
    }

    await act(async () => {
      await tick()
    })
  }

  throw new Error('Timed out waiting for hook state')
}

const renderUseYolkVoice = (options: UseYolkVoiceOptions) => {
  const container = document.createElement('div')
  const root = createRoot(container)
  let value: YolkVoiceApi | undefined

  function TestComponent({ hookOptions }: { readonly hookOptions: UseYolkVoiceOptions }) {
    const hook = useYolkVoice(hookOptions)

    useEffect(() => {
      value = hook
    })

    return null
  }

  const renderWith = (hookOptions: UseYolkVoiceOptions) => {
    act(() => {
      root.render(createElement(TestComponent, { hookOptions }))
    })
  }

  renderWith(options)

  return {
    get value() {
      return readHook(value)
    },
    rerender: renderWith,
    unmount: () => {
      act(() => {
        root.unmount()
      })
    }
  }
}

const testCodec: VoiceClientCodec = {
  encodeToolOutput: (callId, output) => Effect.succeed([`tool-output:${callId}:${output}`]),
  encodeResponseTurn: () => Effect.succeed(['response-turn']),
  encodeUserText: text => Effect.succeed([`user:${text}`]),
  encodeAssistantText: text => Effect.succeed([`assistant:${text}`])
}

// Test wire format: JSON-encoded VoiceEvent per data channel message.
const decodeMessage = (raw: string): ReadonlyArray<VoiceEvent> => {
  switch (raw) {
    case 'user-delta':
      return [VoiceUserTranscriptDelta.make({ itemId: 'item_1', delta: 'Hi ' })]
    case 'user-final':
      return [VoiceUserTranscriptFinal.make({ itemId: 'item_1', text: 'Hi there' })]
    case 'tool-call':
      return [
        VoiceToolCallsRequested.make({
          calls: [VoiceToolCall.make({ callId: 'call_1', name: 'sandbox', argumentsJson: '{}' })]
        })
      ]
    default:
      return []
  }
}

const approvalRequired = VoiceToolCallApprovalRequiredOutcome.make({
  request: ToolApprovalRequest.make({
    requestId: voiceApprovalRequestId('call_1'),
    toolCallId: 'call_1',
    call: ToolCall.make({ id: 'call_1', name: 'sandbox', params: {} }),
    policy: ToolApprovalPolicy.make({ mode: 'manual' })
  })
})

const makeOptions = (
  world: FakeWorld,
  overrides?: Partial<UseYolkVoiceOptions>
): UseYolkVoiceOptions => ({
  negotiate: () => Effect.succeed('answer-sdp'),
  executeToolCall: () =>
    Effect.succeed<VoiceToolCallOutcome>(
      VoiceToolCallExecutedOutcome.make({ callId: 'call_1', output: '{}' })
    ),
  codec: testCodec,
  decodeMessage,
  dataChannelLabel: 'oai-events',
  runtime: world.runtime,
  ...overrides
})

describe('useYolkVoice', () => {
  it('connects, tracks user drafts, and stops cleanly', async () => {
    const world = makeFakeWorld()
    const events: Array<VoiceEvent> = []
    const hook = renderUseYolkVoice(makeOptions(world, { onEvent: event => events.push(event) }))

    expect(hook.value.status).toBe('idle')

    act(() => {
      hook.value.start()
    })
    await waitFor(() => hook.value.status === 'live')

    act(() => {
      world.fireChannelMessage('user-delta')
    })
    await waitFor(() => hook.value.userDraft === 'Hi ')

    act(() => {
      world.fireChannelMessage('user-final')
    })
    await waitFor(() => hook.value.userDraft === '')

    expect(events.map(event => event._tag)).toContain('UserTranscriptFinal')

    act(() => {
      hook.value.stop()
    })
    await waitFor(() => hook.value.status === 'idle')

    expect(world.state.peerClosed).toBe(true)
    expect(world.state.channelClosed).toBe(true)
    expect(world.state.stoppedTracks).toBeGreaterThan(0)

    hook.unmount()
  })

  it('surfaces pending approvals and resumes execution on approve', async () => {
    const world = makeFakeWorld()
    const approvals: Array<ToolApprovalResponse> = []

    const hook = renderUseYolkVoice(
      makeOptions(world, {
        executeToolCall: (call, approval) => {
          if (approval === undefined) {
            return Effect.succeed<VoiceToolCallOutcome>(approvalRequired)
          }

          approvals.push(approval)

          return Effect.succeed<VoiceToolCallOutcome>(
            VoiceToolCallExecutedOutcome.make({ callId: call.callId, output: '{"ok":true}' })
          )
        }
      })
    )

    act(() => {
      hook.value.start()
    })
    await waitFor(() => hook.value.status === 'live')

    act(() => {
      world.fireChannelMessage('tool-call')
    })
    await waitFor(() => hook.value.pendingApprovals.length === 1)

    const request = hook.value.pendingApprovals[0]

    expect(request).toMatchObject({
      requestId: voiceApprovalRequestId('call_1'),
      toolCallId: 'call_1'
    })

    act(() => {
      hook.value.approveTool(voiceApprovalRequestId('call_1'), 'call_1')
    })
    await waitFor(() => approvals.length === 1)
    await waitFor(() =>
      world.state.sent.some(payload => payload === 'tool-output:call_1:{"ok":true}')
    )

    expect(hook.value.pendingApprovals).toHaveLength(0)
    expect(approvals[0]?.decision).toBe('approved')

    hook.unmount()
  })

  it('reports connection failures with a typed error', async () => {
    const world = makeFakeWorld()
    world.state.getUserMediaError = new Error('mic denied')
    const errors: Array<VoiceSessionError> = []
    const hook = renderUseYolkVoice(makeOptions(world, { onError: error => errors.push(error) }))

    act(() => {
      hook.value.start()
    })
    await waitFor(() => hook.value.status === 'error')

    expect(hook.value.error?.code).toBe('permission_denied')
    expect(errors[0]?.message).toContain('mic denied')

    hook.unmount()
  })

  it('seeds conversation context on connect', async () => {
    const world = makeFakeWorld()

    const hook = renderUseYolkVoice(
      makeOptions(world, {
        seeds: () => [
          { role: 'user', text: 'earlier question' },
          { role: 'assistant', text: 'earlier answer' }
        ]
      })
    )

    act(() => {
      hook.value.start()
    })
    await waitFor(() => hook.value.status === 'live')
    await waitFor(() => world.state.sent.length >= 2)

    expect(world.state.sent).toEqual(['user:earlier question', 'assistant:earlier answer'])

    hook.unmount()
  })

  it('ignores start while a session is already live', async () => {
    const world = makeFakeWorld()
    const hook = renderUseYolkVoice(makeOptions(world))

    act(() => {
      hook.value.start()
    })
    await waitFor(() => hook.value.status === 'live')

    const created = world.state.peerCreateCount
    act(() => {
      hook.value.start()
    })
    await act(async () => {
      await tick()
    })

    expect(hook.value.status).toBe('live')
    expect(world.state.peerCreateCount).toBe(created)
    expect(world.state.peerClosed).toBe(false)

    hook.unmount()
  })

  it('does not close resources twice on a second stop', async () => {
    const world = makeFakeWorld()
    const hook = renderUseYolkVoice(makeOptions(world))

    act(() => {
      hook.value.start()
    })
    await waitFor(() => hook.value.status === 'live')

    act(() => {
      hook.value.stop()
    })
    await waitFor(() => hook.value.status === 'idle')

    const stoppedTracks = world.state.stoppedTracks
    act(() => {
      hook.value.stop()
    })
    await act(async () => {
      await tick()
    })

    expect(hook.value.status).toBe('idle')
    expect(world.state.stoppedTracks).toBe(stoppedTracks)

    hook.unmount()
  })

  it('cancels a connecting session on unmount without going live', async () => {
    const world = makeFakeWorld()
    const hook = renderUseYolkVoice(makeOptions(world, { negotiate: () => Effect.never }))

    act(() => {
      hook.value.start()
    })
    await waitFor(() => hook.value.status === 'connecting')
    await waitFor(() => listenerCount(world.peerListeners) > 0)

    hook.unmount()
    await waitFor(() => world.state.peerClosed)
    expect(world.state.channelClosed).toBe(true)
    expect(world.state.stoppedTracks).toBeGreaterThan(0)
  })

  it('starts a new session after stop instead of reusing the previous graph', async () => {
    const world = makeFakeWorld()
    const hook = renderUseYolkVoice(makeOptions(world))

    act(() => {
      hook.value.start()
    })
    await waitFor(() => hook.value.status === 'live')
    expect(world.state.peerCreateCount).toBe(1)

    const first = world.connections[0]

    if (first === undefined) {
      throw new Error('Expected the first peer connection')
    }

    act(() => {
      hook.value.stop()
    })
    await waitFor(() => hook.value.status === 'idle')
    expect(world.state.peerClosed).toBe(true)
    expect(first.isPeerClosed()).toBe(true)
    expect(first.isChannelClosed()).toBe(true)

    act(() => {
      hook.value.start()
    })
    await waitFor(() => hook.value.status === 'live')

    const second = world.connections[1]

    if (second === undefined) {
      throw new Error('Expected a distinct second peer connection')
    }

    expect(world.state.peerCreateCount).toBe(2)
    expect(world.state.peerClosed).toBe(false)
    expect(first.peer).not.toBe(second.peer)
    expect(first.channel).not.toBe(second.channel)
    expect(first.isPeerClosed()).toBe(true)
    expect(first.isChannelClosed()).toBe(true)
    expect(world.state.remoteDescriptions).toEqual(['answer-sdp', 'answer-sdp'])

    act(() => {
      world.fireChannelMessageOn(first, 'user-delta')
    })
    await act(async () => {
      await tick()
    })
    expect(hook.value.userDraft).toBe('')

    act(() => {
      world.fireChannelMessage('user-delta')
    })
    await waitFor(() => hook.value.userDraft === 'Hi ')

    hook.unmount()
  })

  it('uses the latest onEvent callback after rerender', async () => {
    const world = makeFakeWorld()
    const first: Array<VoiceEvent['_tag']> = []
    const second: Array<VoiceEvent['_tag']> = []
    const base = makeOptions(world, { onEvent: event => first.push(event._tag) })
    const hook = renderUseYolkVoice(base)

    act(() => {
      hook.value.start()
    })
    await waitFor(() => hook.value.status === 'live')

    hook.rerender({ ...base, onEvent: event => second.push(event._tag) })
    await act(async () => {
      await tick()
    })

    act(() => {
      world.fireChannelMessage('user-final')
    })
    await waitFor(() => second.includes('UserTranscriptFinal'))

    expect(first).not.toContain('UserTranscriptFinal')
    expect(second).toContain('UserTranscriptFinal')

    hook.unmount()
  })

  it('flushes the event log when the session stops', async () => {
    const world = makeFakeWorld()
    const batches: Array<ReadonlyArray<StoredVoiceEvent>> = []

    const hook = renderUseYolkVoice(
      makeOptions(world, {
        eventLog: {
          streamId: 'hook-session',
          flushIntervalMs: 60_000,
          flush: batch =>
            Effect.sync(() => {
              batches.push(batch)
            })
        }
      })
    )

    act(() => {
      hook.value.start()
    })
    await waitFor(() => hook.value.status === 'live')

    act(() => {
      world.fireChannelMessage('user-delta')
    })
    await waitFor(() => hook.value.userDraft === 'Hi ')
    expect(batches).toEqual([])

    act(() => {
      hook.value.stop()
    })
    await waitFor(
      () =>
        hook.value.status === 'idle' &&
        world.state.peerClosed &&
        world.state.channelClosed &&
        batches.length > 0
    )

    expect(batches).toHaveLength(1)
    expect(batches.flatMap(batch => batch.map(entry => entry.event))).toEqual([
      VoiceSessionOpening.make({}),
      VoiceUserTranscriptDelta.make({ itemId: 'item_1', delta: 'Hi ' })
    ])
    expect(batches.flatMap(batch => batch.map(entry => entry.eventId))).toEqual([
      'hook-session:0',
      'hook-session:1'
    ])

    hook.unmount()
  })
})
