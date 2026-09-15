import { describe, expect, it } from '@effect/vitest'
import { Option, Predicate } from 'effect'
import {
  AgentRetry,
  AssistantAgentMessage,
  AssistantReasoningPart,
  AssistantTextPart,
  HostToolCallPart,
  ProviderErrorInfo,
  ToolCall,
  ToolExecutionError,
  ToolExecutionStarted,
  ToolInputEnd,
  ToolResult,
  ToolResultMessage,
  UserMessage
} from '@yolk-sdk/agent/protocol'
import { AgentToolRun } from '../../src/client/state.ts'
import {
  AgentChatItem,
  buildAgentChatItems,
  dedupeAgentChatToolRunItems,
  type ToolDuration,
  ToolDurationKnown,
  ToolDurationUnknown,
  ToolRunState
} from '../../src/react/chat-items.ts'
import {
  AgentChatPart,
  applyAgentEventToChatMessages,
  buildAgentChatMessages,
  toAgentMessages
} from '../../src/react/chat-messages.ts'

const assistantMessage = (input: {
  readonly content: string
  readonly reasoning?: string
  readonly toolCalls?: ReadonlyArray<ToolCall>
}) =>
  AssistantAgentMessage.make({
    parts: [
      ...(input.reasoning === undefined
        ? []
        : [AssistantReasoningPart.make({ text: input.reasoning })]),
      AssistantTextPart.make({ content: input.content }),
      ...(input.toolCalls ?? []).map(call => HostToolCallPart.make({ call }))
    ]
  })

describe('buildAgentChatMessages', () => {
  it('projects protocol transcript into ordered message parts', () => {
    const call = ToolCall.make({
      id: 'call_1',
      name: 'web_fetch',
      params: { url: 'https://example.com' }
    })

    const result = ToolResult.make({ toolCallId: call.id, content: 'Example Domain' })

    const messages = buildAgentChatMessages({
      messages: [
        UserMessage.make({ content: 'summarize https://example.com' }),
        assistantMessage({
          content: 'Fetching.',
          reasoning: 'Need source.',
          toolCalls: [call]
        }),
        ToolResultMessage.make({ toolCallId: call.id, content: result.content })
      ],
      userDraft: '',
      assistantDraft: 'Done.',
      reasoningDraft: '',
      toolRuns: [AgentToolRun.Completed({ call, result, startedAtMs: 1000, endedAtMs: 1250 })],
      error: null
    })

    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(messages[1]?.parts.map(part => part._tag)).toEqual(['Reasoning', 'Text', 'ToolCall'])
    expect(messages[2]?.parts).toEqual([
      AgentChatPart.Text({ id: 'draft-assistant-text', content: 'Done.', state: 'streaming' })
    ])
  })

  it('converts chat parts back to protocol transcript', () => {
    const call = ToolCall.make({
      id: 'call_1',
      name: 'web_fetch',
      params: { url: 'https://example.com' }
    })

    const result = ToolResult.make({ toolCallId: call.id, content: 'Example Domain' })

    const messages = buildAgentChatMessages({
      messages: [
        UserMessage.make({ content: 'summarize https://example.com' }),
        assistantMessage({
          content: 'Fetching.',
          reasoning: 'Need source.',
          toolCalls: [call]
        }),
        ToolResultMessage.make({ toolCallId: call.id, content: result.content })
      ],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [AgentToolRun.Completed({ call, result, startedAtMs: 1000, endedAtMs: 1250 })],
      error: null
    })

    expect(toAgentMessages(messages)).toEqual([
      UserMessage.make({ content: 'summarize https://example.com' }),
      assistantMessage({
        content: 'Fetching.',
        reasoning: 'Need source.',
        toolCalls: [call]
      }),
      ToolResultMessage.make({ toolCallId: call.id, content: result.content })
    ])
  })
})

describe('buildAgentChatItems', () => {
  it('normalizes protocol messages, tools, drafts, and errors', () => {
    const call = ToolCall.make({
      id: 'call_1',
      name: 'web_fetch',
      params: { url: 'https://example.com' }
    })

    const messages = buildAgentChatMessages({
      messages: [
        UserMessage.make({ content: 'summarize https://example.com' }),
        assistantMessage({
          content: 'I will fetch it.',
          reasoning: 'Need page content.',
          toolCalls: [call]
        }),
        ToolResultMessage.make({ toolCallId: call.id, content: 'URL: https://example.com' })
      ],
      userDraft: 'voice draft',
      assistantDraft: 'assistant draft',
      reasoningDraft: 'reasoning draft',
      toolRuns: [
        AgentToolRun.Completed({
          call,
          result: ToolResult.make({ toolCallId: call.id, content: 'URL: https://example.com' }),
          startedAtMs: 1000,
          endedAtMs: 1250
        })
      ],
      error: 'boom'
    })

    const items = buildAgentChatItems({
      messages,
      isRunning: false,
      activeToolLabel: Option.none()
    })

    expect(items.map(item => item._tag)).toEqual([
      'UserMessage',
      'Reasoning',
      'AssistantMessage',
      'ToolRun',
      'UserDraft',
      'Reasoning',
      'AssistantDraft',
      'Error'
    ])
    expect(items).toContainEqual(
      AgentChatItem.ToolRun({
        id: 'message-1-tool-call-call_1',
        messageId: 'message-1-assistant',
        call,
        state: ToolRunState.Completed({
          duration: ToolDurationKnown.make({ milliseconds: 250 }),
          startedAtMs: 1000,
          endedAtMs: 1250,
          result: ToolResult.make({ toolCallId: call.id, content: 'URL: https://example.com' })
        })
      })
    )
  })

  it('falls back to tool call id when result has no matching call', () => {
    const messages = buildAgentChatMessages({
      messages: [ToolResultMessage.make({ toolCallId: 'missing_call', content: 'ok' })],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [],
      error: null
    })

    const items = buildAgentChatItems({
      messages,
      isRunning: false,
      activeToolLabel: Option.none()
    })

    expect(items).toEqual([
      AgentChatItem.ToolResult({
        id: 'message-0-tool-result-missing_call',
        messageId: 'message-0-tool-result-message',
        toolCallId: 'missing_call',
        name: 'missing_call',
        content: 'ok'
      })
    ])
  })

  it('adds active assistant status while waiting for more events', () => {
    const call = ToolCall.make({
      id: 'call_1',
      name: 'web_search',
      params: { query: 'latest news' }
    })

    const thinkingMessages = buildAgentChatMessages({
      messages: [UserMessage.make({ content: 'hello' })],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [],
      error: null
    })

    const thinkingItems = buildAgentChatItems({
      messages: thinkingMessages,
      isRunning: true,
      activeToolLabel: Option.none()
    })

    const toolMessages = buildAgentChatMessages({
      messages: [
        UserMessage.make({ content: 'latest news?' }),
        assistantMessage({ content: '', toolCalls: [call] })
      ],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [AgentToolRun.Executing({ call, startedAtMs: 1000 })],
      error: null
    })

    const toolItems = buildAgentChatItems({
      messages: toolMessages,
      isRunning: true,
      activeToolLabel: Option.some('Running web_search')
    })

    expect(thinkingItems.at(-1)).toEqual(
      AgentChatItem.AssistantStatus({
        id: 'assistant-status',
        label: 'Thinking'
      })
    )
    expect(toolItems.at(-2)).toEqual(
      AgentChatItem.ToolRun({
        id: 'message-1-tool-call-call_1',
        messageId: 'message-1-assistant',
        call,
        state: ToolRunState.Running({
          duration: ToolDurationUnknown.make({}),
          startedAtMs: 1000
        })
      })
    )
    expect(toolItems.at(-1)).toEqual(
      AgentChatItem.AssistantStatus({
        id: 'assistant-status',
        label: 'Running web_search'
      })
    )
  })

  it('projects retry info instead of generic assistant status', () => {
    const retry = AgentRetry.make({
      attempt: 1,
      reason: 'overloaded',
      delayMs: 2000,
      message: 'Provider is overloaded',
      provider: ProviderErrorInfo.make({ provider: 'anthropic', kind: 'overloaded', status: 529 })
    })

    const messages = buildAgentChatMessages({
      messages: [UserMessage.make({ content: 'hello' })],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [],
      error: null
    })

    expect(
      buildAgentChatItems({
        messages,
        isRunning: true,
        activeToolLabel: Option.none(),
        retryInfo: retry
      }).at(-1)
    ).toEqual(AgentChatItem.Retry({ id: 'agent-retry', retry }))
  })

  it('keeps the latest tool run item for duplicate tool call ids', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'web_fetch', params: {} })

    const items = [
      AgentChatItem.ToolRun({
        id: 'live-call',
        messageId: 'message-0-assistant',
        call,
        state: ToolRunState.Called({ duration: ToolDurationUnknown.make({}) })
      }),
      AgentChatItem.AssistantMessage({ id: 'message-text', messageId: 'message-0', content: 'ok' }),
      AgentChatItem.ToolRun({
        id: 'persisted-call',
        messageId: 'message-0-assistant',
        call,
        state: ToolRunState.Called({ duration: ToolDurationUnknown.make({}) })
      })
    ] satisfies ReadonlyArray<AgentChatItem>

    expect(dedupeAgentChatToolRunItems(items).map(item => item.id)).toEqual([
      'message-text',
      'persisted-call'
    ])
  })

  it('dedupes duplicate tool runs even when item ids match', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'web_fetch', params: {} })

    const items = [
      AgentChatItem.ToolRun({
        id: 'tool-call-call_1',
        messageId: 'message-0-assistant',
        call,
        state: ToolRunState.Called({ duration: ToolDurationUnknown.make({}) })
      }),
      AgentChatItem.ToolRun({
        id: 'tool-call-call_1',
        messageId: 'message-0-assistant',
        call,
        state: ToolRunState.Running({
          duration: ToolDurationUnknown.make({}),
          startedAtMs: 10
        })
      })
    ] satisfies ReadonlyArray<AgentChatItem>

    expect(dedupeAgentChatToolRunItems(items)).toEqual([items[1]])
  })

  it('keeps live tool results visible while the run continues', () => {
    const call = ToolCall.make({
      id: 'call_1',
      name: 'web_fetch',
      params: { url: 'https://example.com' }
    })

    const result = ToolResult.make({ toolCallId: call.id, content: 'Example Domain' })

    const messages = buildAgentChatMessages({
      messages: [
        UserMessage.make({ content: 'summarize https://example.com' }),
        assistantMessage({ content: '', toolCalls: [call] }),
        ToolResultMessage.make({ toolCallId: call.id, content: result.content })
      ],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [AgentToolRun.Completed({ call, result, startedAtMs: 1000, endedAtMs: 1800 })],
      error: null
    })

    const items = buildAgentChatItems({ messages, isRunning: true, activeToolLabel: Option.none() })

    expect(items.at(-2)).toEqual(
      AgentChatItem.ToolRun({
        id: 'message-1-tool-call-call_1',
        messageId: 'message-1-assistant',
        call,
        state: ToolRunState.Completed({
          duration: ToolDurationKnown.make({ milliseconds: 800 }),
          startedAtMs: 1000,
          endedAtMs: 1800,
          result
        })
      })
    )
    expect(items.at(-1)).toEqual(
      AgentChatItem.AssistantStatus({
        id: 'assistant-status',
        label: 'Thinking'
      })
    )
  })

  it('preserves errored tool run timing', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'web_fetch', params: {} })

    const running = applyAgentEventToChatMessages(
      [],
      ToolExecutionStarted.make({ call, createdAtMs: 1000 })
    )

    const errored = applyAgentEventToChatMessages(
      running,
      ToolExecutionError.make({
        call,
        message: 'Request failed',
        code: 'tool_error',
        createdAtMs: 1750
      })
    )

    const items = buildAgentChatItems({
      messages: errored,
      isRunning: false,
      activeToolLabel: Option.none()
    })

    expect(items).toEqual([
      AgentChatItem.ToolRun({
        id: 'tool-call-call_1',
        messageId: 'message-0-assistant',
        call,
        state: ToolRunState.Errored({
          duration: ToolDurationKnown.make({ milliseconds: 750 }),
          startedAtMs: 1000,
          endedAtMs: 1750,
          message: 'Request failed'
        })
      })
    ])
  })

  it('anchors tool rows before the next assistant draft', () => {
    const call = ToolCall.make({
      id: 'call_1',
      name: 'web_search',
      params: { query: 'latest news' }
    })

    const result = ToolResult.make({ toolCallId: call.id, content: 'Search result' })

    const messages = buildAgentChatMessages({
      messages: [
        UserMessage.make({ content: 'latest news?' }),
        assistantMessage({ content: '', toolCalls: [call] }),
        ToolResultMessage.make({ toolCallId: call.id, content: result.content })
      ],
      userDraft: '',
      assistantDraft: 'Here is what I found.',
      reasoningDraft: '',
      toolRuns: [AgentToolRun.Completed({ call, result, startedAtMs: 1000, endedAtMs: 1300 })],
      error: null
    })

    const items = buildAgentChatItems({ messages, isRunning: true, activeToolLabel: Option.none() })

    expect(items.map(item => item._tag)).toEqual([
      'UserMessage',
      'AssistantMessage',
      'ToolRun',
      'AssistantDraft',
      'AssistantStatus'
    ])
  })
})

const ownDescriptors = (value: ToolDuration) => {
  const descriptors: Record<string, PropertyDescriptor | undefined> = {}

  for (const key of Object.keys(value)) {
    descriptors[key] = Object.getOwnPropertyDescriptor(value, key)
  }

  return descriptors
}

const toolRunItem = (items: ReadonlyArray<AgentChatItem>) => {
  for (const item of items) {
    if (Predicate.isTagged(item, 'ToolRun')) {
      return item
    }
  }

  throw new Error('expected ToolRun')
}

describe('ToolDuration private owners via buildAgentChatItems', () => {
  it('Unknown Called duration is plain JSON with data descriptors and fresh identity', () => {
    const firstCall = ToolCall.make({ id: 'call_1', name: 'web_fetch', params: {} })
    const secondCall = ToolCall.make({ id: 'call_2', name: 'web_fetch', params: {} })

    const messages = applyAgentEventToChatMessages(
      applyAgentEventToChatMessages([], ToolInputEnd.make({ call: firstCall })),
      ToolInputEnd.make({ call: secondCall })
    )

    const items = buildAgentChatItems({
      messages,
      isRunning: false,
      activeToolLabel: Option.none()
    })

    const runs = items.filter(item => Predicate.isTagged(item, 'ToolRun'))

    expect(runs).toHaveLength(2)

    const firstDuration = toolRunItem(runs.slice(0, 1)).state.duration
    const secondDuration = toolRunItem(runs.slice(1)).state.duration

    expect(JSON.stringify(firstDuration)).toBe('{"_tag":"Unknown"}')
    expect(Object.keys(firstDuration)).toEqual(['_tag'])
    expect(Object.getPrototypeOf(firstDuration)).toBe(Object.prototype)
    expect(ownDescriptors(firstDuration)).toEqual({
      _tag: {
        value: 'Unknown',
        writable: true,
        enumerable: true,
        configurable: true
      }
    })
    expect(firstDuration).not.toBe(secondDuration)
    expect(JSON.stringify(secondDuration)).toBe('{"_tag":"Unknown"}')
  })

  it('Unknown Running duration keeps startedAtMs outside the duration object', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'web_fetch', params: {} })

    const messages = applyAgentEventToChatMessages(
      [],
      ToolExecutionStarted.make({ call, createdAtMs: 1000 })
    )

    const items = buildAgentChatItems({
      messages,
      isRunning: false,
      activeToolLabel: Option.none()
    })

    const run = toolRunItem(items)

    expect(run.state._tag).toBe('Running')

    if (Predicate.isTagged(run.state, 'Running')) {
      expect(run.state.startedAtMs).toBe(1000)
    }

    expect(Object.keys(run.state.duration)).toEqual(['_tag'])
    expect(Object.getPrototypeOf(run.state.duration)).toBe(Object.prototype)
    expect(JSON.stringify(run.state.duration)).toBe('{"_tag":"Unknown"}')
  })

  it('Known duration is _tag-first plain JSON with data descriptors', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'web_fetch', params: {} })

    const running = applyAgentEventToChatMessages(
      [],
      ToolExecutionStarted.make({ call, createdAtMs: 1000 })
    )

    const errored = applyAgentEventToChatMessages(
      running,
      ToolExecutionError.make({
        call,
        message: 'Request failed',
        code: 'tool_error',
        createdAtMs: 1750
      })
    )

    const items = buildAgentChatItems({
      messages: errored,
      isRunning: false,
      activeToolLabel: Option.none()
    })

    const duration = toolRunItem(items).state.duration

    expect(JSON.stringify(duration)).toBe('{"_tag":"Known","milliseconds":750}')
    expect(Object.keys(duration)).toEqual(['_tag', 'milliseconds'])
    expect(Object.getPrototypeOf(duration)).toBe(Object.prototype)
    expect(ownDescriptors(duration)).toEqual({
      _tag: {
        value: 'Known',
        writable: true,
        enumerable: true,
        configurable: true
      },
      milliseconds: {
        value: 750,
        writable: true,
        enumerable: true,
        configurable: true
      }
    })
  })

  it('Known duration preserves NaN Infinity and Math.max clamp from started/ended getters', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'web_fetch', params: {} })

    const base = applyAgentEventToChatMessages(
      applyAgentEventToChatMessages([], ToolExecutionStarted.make({ call, createdAtMs: 1 })),
      ToolExecutionError.make({
        call,
        message: 'Request failed',
        code: 'tool_error',
        createdAtMs: 2
      })
    )

    const project = (startedAtMs: number, endedAtMs: number) => {
      const reads: Array<string> = []

      const messages = base.map(message => ({
        ...message,
        parts: message.parts.map(part => {
          if (Predicate.isTagged(part, 'ToolCall')) {
            const next = {
              ...part,
              state: {
                ...part.state,
                get startedAtMs() {
                  reads.push('startedAtMs')

                  return startedAtMs
                },
                get endedAtMs() {
                  reads.push('endedAtMs')

                  return endedAtMs
                }
              }
            }

            return next
          }

          return part
        })
      }))

      const items = buildAgentChatItems({
        messages,
        isRunning: false,
        activeToolLabel: Option.none()
      })

      const duration = toolRunItem(items).state.duration

      return { duration, reads, state: toolRunItem(items).state }
    }

    const nanCase = project(Number.NaN, 1000)

    expect(nanCase.reads).toEqual(['startedAtMs', 'endedAtMs', 'startedAtMs', 'endedAtMs'])
    expect(nanCase.duration._tag).toBe('Known')

    if (Predicate.isTagged(nanCase.duration, 'Known')) {
      expect(Object.is(nanCase.duration.milliseconds, Number.NaN)).toBe(true)
      expect(Object.is(nanCase.duration.milliseconds, Math.max(0, 1000 - Number.NaN))).toBe(true)
    }

    expect(JSON.stringify(nanCase.duration)).toBe('{"_tag":"Known","milliseconds":null}')

    const infCase = project(0, Number.POSITIVE_INFINITY)

    expect(infCase.duration._tag).toBe('Known')

    if (Predicate.isTagged(infCase.duration, 'Known')) {
      expect(Object.is(infCase.duration.milliseconds, Number.POSITIVE_INFINITY)).toBe(true)
    }

    const clampCase = project(5000, 1000)

    expect(clampCase.duration._tag).toBe('Known')

    if (Predicate.isTagged(clampCase.duration, 'Known')) {
      expect(Object.is(clampCase.duration.milliseconds, 0)).toBe(true)
      expect(Object.is(clampCase.duration.milliseconds, Math.max(0, 1000 - 5000))).toBe(true)
    }

    const zeroCase = project(-0, -0)

    expect(zeroCase.duration._tag).toBe('Known')

    if (Predicate.isTagged(zeroCase.duration, 'Known')) {
      expect(Object.is(zeroCase.duration.milliseconds, Math.max(0, -0 - -0))).toBe(true)
      expect(Object.is(zeroCase.duration.milliseconds, 0)).toBe(true)
      expect(Object.is(zeroCase.duration.milliseconds, -0)).toBe(false)
    }

    expect(zeroCase.reads).toEqual(['startedAtMs', 'endedAtMs', 'startedAtMs', 'endedAtMs'])
  })
})
