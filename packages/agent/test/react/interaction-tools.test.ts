import { Option, Predicate } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentAwaitingInput,
  AgentEnd,
  AssistantAgentMessage,
  HostToolCallPart,
  InteractionCancelled,
  InteractionRequest,
  InteractionRequested,
  InteractionResponse,
  InteractionSubmitted,
  ToolCall,
  ToolExecutionCompleted,
  ToolResult,
  ToolResultMessage,
  zeroAgentUsage,
  interactionRequestId
} from '@yolk-sdk/agent/protocol'
import { applyAgentEventToChatMessages, toAgentMessages } from '../../src/react/chat-messages.ts'
import {
  reduceAgentChatState,
  initialAgentChatState,
  isActiveChatToolPart
} from '../../src/react/chat-core.ts'
import { buildAgentChatItems } from '../../src/react/chat-items.ts'

const call = ToolCall.make({ id: 'call_doc', name: 'document', params: {} })

const request = InteractionRequest.make({
  requestId: interactionRequestId(call),
  toolCallId: call.id,
  call,
  interaction: {
    kind: 'document-editor',
    title: 'Review document',
    actions: [
      { id: 'publish', label: 'Publish' },
      { id: 'archive', label: 'Archive' }
    ]
  }
})

const submitted = InteractionResponse.make({
  requestId: request.requestId,
  toolCallId: call.id,
  outcome: 'submitted',
  source: 'user',
  actionId: 'publish',
  data: { title: 'Edited title', body: 'Edited body' }
})

const cancelled = InteractionResponse.make({
  requestId: request.requestId,
  toolCallId: call.id,
  outcome: 'cancelled',
  source: 'user'
})

const unknownResult = ToolResult.make({
  toolCallId: call.id,
  content: 'Publish request timed out. Outcome unknown: the action may have taken effect.',
  isError: true,
  structuredContent: {
    type: 'interaction_outcome',
    outcome: 'unknown',
    slot: request.requestId,
    submissionId: 'publish:{"body":"Edited body","title":"Edited title"}',
    actionId: 'publish'
  }
})

const toolCallPart = (messages: ReturnType<typeof applyAgentEventToChatMessages>) =>
  messages.flatMap(message => message.parts).find(part => Predicate.isTagged(part, 'ToolCall'))

describe('interaction chat projection', () => {
  it('projects requested, accepted, and outcome states distinctly', () => {
    const requested = applyAgentEventToChatMessages([], InteractionRequested.make({ request }))

    const requestedPart = toolCallPart(requested)

    expect(requestedPart).toMatchObject({ call })

    expect(Predicate.isTagged(requestedPart, 'ToolCall') && requestedPart.state._tag).toBe(
      'InteractionRequested'
    )

    const accepted = applyAgentEventToChatMessages(
      requested,
      InteractionSubmitted.make({ response: submitted })
    )

    const acceptedPart = toolCallPart(accepted)

    expect(Predicate.isTagged(acceptedPart, 'ToolCall') && acceptedPart.state._tag).toBe(
      'InteractionSubmitted'
    )

    if (acceptedPart !== undefined) expect(isActiveChatToolPart(acceptedPart)).toBe(true)

    const settled = applyAgentEventToChatMessages(
      accepted,
      ToolExecutionCompleted.make({ call, result: unknownResult })
    )

    const settledPart = toolCallPart(settled)

    expect(Predicate.isTagged(settledPart, 'ToolCall') && settledPart.state._tag).toBe('Completed')

    if (
      Predicate.isTagged(settledPart, 'ToolCall') &&
      Predicate.isTagged(settledPart.state, 'Completed')
    ) {
      expect(settledPart.state.result.isError).toBe(true)

      expect(settledPart.state.result.structuredContent).toMatchObject({ outcome: 'unknown' })
    }
  })

  it('does not optimistically accept a raw local submit or cancellation', () => {
    const pending = reduceAgentChatState(initialAgentChatState, {
      _tag: 'Event',
      event: InteractionRequested.make({ request })
    })

    for (const response of [submitted, cancelled]) {
      const local = reduceAgentChatState(pending, { _tag: 'SubmitHitlResponse', response })
      expect(local.chatMessages).toBe(pending.chatMessages)
      expect(toolCallPart(local.chatMessages)).toMatchObject({
        state: { _tag: 'InteractionRequested' }
      })
      expect(
        toAgentMessages(local.chatMessages).some(message =>
          Predicate.isTagged(message, 'ToolResult')
        )
      ).toBe(false)
    }
  })

  it('restores pending interactions from AgentAwaitingInput', () => {
    const messages = applyAgentEventToChatMessages(
      [],
      AgentAwaitingInput.make({
        requests: [request],
        messages: [],
        turns: 1,
        usage: zeroAgentUsage
      })
    )

    const part = toolCallPart(messages)

    expect(Predicate.isTagged(part, 'ToolCall') && part.state._tag).toBe('InteractionRequested')
  })

  it('never synthesizes a tool result from acceptance or cancellation', () => {
    const accepted = applyAgentEventToChatMessages(
      applyAgentEventToChatMessages([], InteractionRequested.make({ request })),
      InteractionSubmitted.make({ response: submitted })
    )

    expect(
      toAgentMessages(accepted).filter(message => Predicate.isTagged(message, 'ToolResult'))
    ).toEqual([])

    const cancelledMessages = applyAgentEventToChatMessages(
      [],
      InteractionCancelled.make({ response: cancelled })
    )

    expect(
      toAgentMessages(cancelledMessages).filter(message =>
        Predicate.isTagged(message, 'ToolResult')
      )
    ).toEqual([])
  })

  it('projects stored interaction results through AgentEnd transcripts', () => {
    const messages = applyAgentEventToChatMessages(
      [],
      AgentEnd.make({
        messages: [
          AssistantAgentMessage.make({ parts: [HostToolCallPart.make({ call })] }),
          ToolResultMessage.make({
            toolCallId: call.id,
            content: unknownResult.content,
            isError: true,
            structuredContent: unknownResult.structuredContent
          })
        ],
        turns: 1,
        usage: zeroAgentUsage
      })
    )

    const part = toolCallPart(messages)

    expect(Predicate.isTagged(part, 'ToolCall') && part.state._tag).toBe('Completed')
  })

  it('hydrates authoritative outcomes into matching calls without orphan results', () => {
    for (const outcome of ['completed', 'failed', 'unknown']) {
      const result = ToolResultMessage.make({
        toolCallId: call.id,
        content: 'Stored observation',
        isError: outcome !== 'completed',
        structuredContent: { type: 'interaction_outcome', outcome }
      })

      const hydrated = reduceAgentChatState(initialAgentChatState, {
        _tag: 'HydrateMessage',
        message: AssistantAgentMessage.make({ parts: [HostToolCallPart.make({ call })] })
      })

      const accepted = reduceAgentChatState(
        reduceAgentChatState(initialAgentChatState, {
          _tag: 'Event',
          event: InteractionRequested.make({ request })
        }),
        { _tag: 'Event', event: InteractionSubmitted.make({ response: submitted }) }
      )

      for (const prior of [hydrated, accepted]) {
        const settled = reduceAgentChatState(prior, { _tag: 'HydrateMessage', message: result })
        const part = toolCallPart(settled.chatMessages)

        expect(part).toMatchObject({
          state: { _tag: 'Completed', result: { structuredContent: { outcome } } }
        })
        expect(part !== undefined && isActiveChatToolPart(part)).toBe(false)
        expect(
          settled.chatMessages
            .flatMap(message => message.parts)
            .filter(current => Predicate.isTagged(current, 'ToolResult'))
        ).toHaveLength(0)
        expect(
          toAgentMessages(settled.chatMessages).filter(current =>
            Predicate.isTagged(current, 'ToolResult')
          )
        ).toHaveLength(1)
      }
    }
  })

  it('maps interaction states to headless tool run items', () => {
    const messages = applyAgentEventToChatMessages([], InteractionRequested.make({ request }))

    const items = buildAgentChatItems({
      messages,
      isRunning: false,
      activeToolLabel: Option.none()
    })

    const toolRun = items.find(item => Predicate.isTagged(item, 'ToolRun'))

    expect(Predicate.isTagged(toolRun, 'ToolRun') && toolRun.state._tag).toBe(
      'InteractionRequested'
    )
  })
})
