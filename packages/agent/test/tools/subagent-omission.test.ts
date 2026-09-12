import { Effect, Predicate } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentAwaitingInput,
  AgentEnd,
  AgentError,
  AgentUsage,
  AssistantAgentMessage,
  AssistantTextPart,
  ProviderErrorInfo,
  ToolApprovalRequest,
  ToolCall,
  ToolResult,
  TurnStart,
  UsageUpdate
} from '@yolk-sdk/agent/protocol'
import {
  makeSubagentAcceptedToolResult,
  makeSubagentToolModule,
  makeSubagentToolResult,
  resolveTools,
  subagentResultFromEvents,
  subagentToolName,
  subagentToolRunId,
  subagentUsageFromToolResult,
  type SubagentDefinition,
  type SubagentReasoningEffortDefinition,
  type SubagentToolParams
} from '../../src/tools'

type TestContext = {
  readonly sessionId: string
}

const subagents: ReadonlyArray<SubagentDefinition> = [
  { name: 'explore', description: 'Explore code and docs.' }
]

const models = [{ id: 'fast-model', description: 'Fast model for focused exploration.' }]

const reasoningEfforts: ReadonlyArray<SubagentReasoningEffortDefinition> = [
  { value: 'low', description: 'Use for straightforward work.' }
]

const assistantMessage = (content: string) =>
  AssistantAgentMessage.make({
    parts: [AssistantTextPart.make({ content })]
  })

const structuredContentObject = (result: ToolResult) => {
  if (!Predicate.isObject(result.structuredContent)) {
    throw new Error('expected object structuredContent')
  }

  return result.structuredContent
}

describe('subagent omission contract', () => {
  it.effect('omits absent trimmed runtime selections and preserves present key order', () =>
    Effect.gen(function* () {
      const captured: Array<SubagentToolParams> = []

      const toolSet = yield* resolveTools(
        [
          makeSubagentToolModule<TestContext>({
            subagents,
            models,
            reasoningEfforts,
            background: true,
            execute: ({ call, params }) => {
              captured.push(params)

              return Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
            }
          })
        ],
        { sessionId: 'session_1' }
      )

      const omittedParams = Object.freeze({
        description: ' Find auth ',
        prompt: ' Explore auth flow ',
        subagent_type: ' explore '
      })

      yield* toolSet.execute({
        id: 'call_omitted',
        name: subagentToolName,
        params: omittedParams
      })

      const presentParams = Object.freeze({
        description: 'Find auth',
        prompt: 'Explore auth flow',
        subagent_type: 'explore',
        background: false,
        model: 'fast-model',
        reasoning_effort: 'low'
      } satisfies SubagentToolParams)

      yield* toolSet.execute({
        id: 'call_present',
        name: subagentToolName,
        params: presentParams
      })

      expect(captured).toHaveLength(2)

      const omitted = captured[0]
      const present = captured[1]

      if (omitted === undefined || present === undefined) {
        throw new Error('expected captured subagent params')
      }

      expect(omitted).toEqual({
        description: 'Find auth',
        prompt: 'Explore auth flow',
        subagent_type: 'explore'
      })
      expect(Object.keys(omitted)).toEqual(['description', 'prompt', 'subagent_type'])
      expect(Object.hasOwn(omitted, 'background')).toBe(false)
      expect(Object.hasOwn(omitted, 'model')).toBe(false)
      expect(Object.hasOwn(omitted, 'reasoning_effort')).toBe(false)
      expect(JSON.stringify(omitted)).toBe(
        '{"description":"Find auth","prompt":"Explore auth flow","subagent_type":"explore"}'
      )

      expect(present).toEqual(presentParams)
      expect(Object.keys(present)).toEqual([
        'description',
        'prompt',
        'subagent_type',
        'background',
        'model',
        'reasoning_effort'
      ])
      expect(JSON.stringify(present)).toBe(
        '{"description":"Find auth","prompt":"Explore auth flow","subagent_type":"explore","background":false,"model":"fast-model","reasoning_effort":"low"}'
      )
    })
  )

  it('omits completed result metadata optionals and preserves wire JSON', () => {
    const input = Object.freeze({
      callId: 'call_1',
      output: 'Found docs.',
      subagentType: 'explore',
      description: 'Find docs',
      subagentRunId: subagentToolRunId('call_1'),
      startedAtMs: 100,
      endedAtMs: 250,
      model: 'test-model'
    } satisfies Parameters<typeof makeSubagentToolResult>[0])

    const result = makeSubagentToolResult(input)
    const content = structuredContentObject(result)

    expect(result.content).toBe('<subagent_result>\nFound docs.\n</subagent_result>')
    expect(Object.hasOwn(result, 'isError') ? result.isError : undefined).toBeUndefined()
    expect(content).toEqual({
      subagent_run_id: 'subagent:call_1',
      subagent_type: 'explore',
      description: 'Find docs',
      started_at_ms: 100,
      ended_at_ms: 250,
      duration_ms: 150,
      status: 'completed',
      model: 'test-model'
    })
    expect(Object.keys(content)).toEqual([
      'subagent_run_id',
      'subagent_type',
      'description',
      'started_at_ms',
      'ended_at_ms',
      'duration_ms',
      'status',
      'model'
    ])
    expect(Object.hasOwn(content, 'reasoning_effort')).toBe(false)
    expect(Object.hasOwn(content, 'usage')).toBe(false)
    expect(Object.hasOwn(content, 'turns')).toBe(false)
    expect(Object.hasOwn(content, 'hitl_requests')).toBe(false)
    expect(Object.hasOwn(content, 'error')).toBe(false)
    expect(JSON.stringify(content)).toBe(
      '{"subagent_run_id":"subagent:call_1","subagent_type":"explore","description":"Find docs","started_at_ms":100,"ended_at_ms":250,"duration_ms":150,"status":"completed","model":"test-model"}'
    )
    expect(subagentUsageFromToolResult(result)).toBeUndefined()
  })

  it('inserts all completed metadata optionals in original order from frozen constructors', () => {
    const usage = Object.freeze(
      AgentUsage.make({
        input: { total: 120, uncached: 10, cacheRead: 20, cacheWrite: 30 },
        output: { total: 40, text: 25, reasoning: 15 }
      })
    )

    const requests = Object.freeze([
      ToolApprovalRequest.make({
        requestId: 'approval_1',
        toolCallId: 'call_approval_1',
        call: ToolCall.make({ id: 'call_approval_1', name: 'write', params: {} })
      })
    ])

    const error = Object.freeze({
      code: 'context_overflow',
      message: 'Input exceeded the context window.',
      retryable: false,
      provider: Object.freeze(
        ProviderErrorInfo.make({
          provider: 'openai_codex',
          kind: 'context_overflow',
          status: 400,
          providerCode: 'context_window_exceeded',
          retryAfterMs: 1500
        })
      )
    } satisfies NonNullable<Parameters<typeof makeSubagentToolResult>[0]['error']>)

    const input = Object.freeze({
      callId: 'call_2',
      output: 'Inspected context.',
      subagentType: 'general',
      description: 'Inspect context',
      subagentRunId: subagentToolRunId('call_2'),
      startedAtMs: 100,
      endedAtMs: 200,
      model: 'test-model',
      reasoningEffort: 'high',
      usage,
      turns: 2,
      status: 'error',
      requests,
      error,
      isError: true
    } satisfies Parameters<typeof makeSubagentToolResult>[0])

    const result = makeSubagentToolResult(input)
    const content = structuredContentObject(result)

    expect(result.isError).toBe(true)
    expect(Object.keys(content)).toEqual([
      'subagent_run_id',
      'subagent_type',
      'description',
      'started_at_ms',
      'ended_at_ms',
      'duration_ms',
      'status',
      'model',
      'reasoning_effort',
      'usage',
      'turns',
      'hitl_requests',
      'error'
    ])
    expect(content).toEqual({
      subagent_run_id: 'subagent:call_2',
      subagent_type: 'general',
      description: 'Inspect context',
      started_at_ms: 100,
      ended_at_ms: 200,
      duration_ms: 100,
      status: 'error',
      model: 'test-model',
      reasoning_effort: 'high',
      usage: {
        input: { total: 120, uncached: 10, cache_read: 20, cache_write: 30 },
        output: { total: 40, text: 25, reasoning: 15 }
      },
      turns: 2,
      hitl_requests: requests,
      error: {
        code: 'context_overflow',
        message: 'Input exceeded the context window.',
        retryable: false,
        provider: {
          provider: 'openai_codex',
          kind: 'context_overflow',
          status: 400,
          provider_code: 'context_window_exceeded',
          retry_after_ms: 1500
        }
      }
    })
    expect(JSON.stringify(content)).toContain('"cache_read":20')
    expect(JSON.stringify(content)).toContain('"provider_code":"context_window_exceeded"')
    expect(subagentUsageFromToolResult(result)).toEqual(
      AgentUsage.make({
        input: { total: 120, uncached: 10, cacheRead: 20, cacheWrite: 30 },
        output: { total: 40, text: 25, reasoning: 15 }
      })
    )
  })

  it('rereads optional getters in condition-then-assign order for tool result metadata', () => {
    const usageReads: Array<string> = []
    const inputReads: Array<string> = []

    const usage = AgentUsage.make({
      input: { total: 8, uncached: 1, cacheRead: 2, cacheWrite: 3 },
      output: { total: 9, text: 4, reasoning: 5 }
    })

    const provider = ProviderErrorInfo.make({
      provider: 'openai_codex',
      kind: 'rate_limit',
      status: 429,
      providerCode: 'rate_limited',
      retryAfterMs: 250
    })

    const error = {
      code: 'rate_limit',
      message: 'Slow down.',
      retryable: true,
      provider
    } satisfies NonNullable<Parameters<typeof makeSubagentToolResult>[0]['error']>

    const requests = [
      ToolApprovalRequest.make({
        requestId: 'approval_2',
        toolCallId: 'call_approval_2',
        call: ToolCall.make({ id: 'call_approval_2', name: 'write', params: {} })
      })
    ]

    Object.defineProperty(usage, 'input', {
      configurable: true,
      enumerable: true,
      get: () => {
        usageReads.push('input')

        return {
          get total() {
            usageReads.push('input.total')

            return 8
          },
          get uncached() {
            usageReads.push('input.uncached')

            return 1
          },
          get cacheRead() {
            usageReads.push('input.cacheRead')

            return 2
          },
          get cacheWrite() {
            usageReads.push('input.cacheWrite')

            return 3
          }
        }
      }
    })
    Object.defineProperty(usage, 'output', {
      configurable: true,
      enumerable: true,
      get: () => {
        usageReads.push('output')

        return {
          get total() {
            usageReads.push('output.total')

            return 9
          },
          get text() {
            usageReads.push('output.text')

            return 4
          },
          get reasoning() {
            usageReads.push('output.reasoning')

            return 5
          }
        }
      }
    })
    Object.defineProperty(provider, 'status', {
      configurable: true,
      enumerable: true,
      get: () => {
        inputReads.push('provider.status')

        return 429
      }
    })
    Object.defineProperty(provider, 'providerCode', {
      configurable: true,
      enumerable: true,
      get: () => {
        inputReads.push('provider.providerCode')

        return 'rate_limited'
      }
    })
    Object.defineProperty(provider, 'retryAfterMs', {
      configurable: true,
      enumerable: true,
      get: () => {
        inputReads.push('provider.retryAfterMs')

        return 250
      }
    })

    const result = makeSubagentToolResult({
      callId: 'call_getters',
      output: 'Logged.',
      subagentType: 'explore',
      description: 'Log getters',
      subagentRunId: subagentToolRunId('call_getters'),
      startedAtMs: 1,
      endedAtMs: 2,
      model: 'test-model',
      get reasoningEffort(): 'high' {
        inputReads.push('reasoningEffort')

        return 'high'
      },
      get usage() {
        inputReads.push('usage')

        return usage
      },
      get turns() {
        inputReads.push('turns')

        return 3
      },
      get requests() {
        inputReads.push('requests')

        return requests
      },
      get error() {
        inputReads.push('error')

        return error
      }
    })

    const content = structuredContentObject(result)

    expect(Object.keys(content)).toEqual([
      'subagent_run_id',
      'subagent_type',
      'description',
      'started_at_ms',
      'ended_at_ms',
      'duration_ms',
      'status',
      'model',
      'reasoning_effort',
      'usage',
      'turns',
      'hitl_requests',
      'error'
    ])
    expect(inputReads).toEqual([
      'error',
      'reasoningEffort',
      'reasoningEffort',
      'usage',
      'usage',
      'turns',
      'turns',
      'requests',
      'requests',
      'error',
      'error',
      'provider.status',
      'provider.status',
      'provider.providerCode',
      'provider.providerCode',
      'provider.retryAfterMs',
      'provider.retryAfterMs'
    ])
    expect(usageReads).toEqual([
      'input',
      'input.total',
      'input',
      'input.uncached',
      'input',
      'input.uncached',
      'input',
      'input.cacheRead',
      'input',
      'input.cacheRead',
      'input',
      'input.cacheWrite',
      'input',
      'input.cacheWrite',
      'output',
      'output.total',
      'output',
      'output.text',
      'output',
      'output.text',
      'output',
      'output.reasoning',
      'output',
      'output.reasoning'
    ])
  })

  it('skips absent nested usage and provider getters after the condition read', () => {
    const usageReads: Array<string> = []
    const providerReads: Array<string> = []

    const usage = AgentUsage.make({
      input: { total: 8 },
      output: { total: 9 }
    })

    const provider = ProviderErrorInfo.make({
      provider: 'openai_codex',
      kind: 'unknown'
    })

    Object.defineProperty(usage, 'input', {
      configurable: true,
      enumerable: true,
      get: () => {
        usageReads.push('input')

        return {
          get total() {
            usageReads.push('input.total')

            return 8
          },
          get uncached() {
            usageReads.push('input.uncached')

            return undefined
          },
          get cacheRead() {
            usageReads.push('input.cacheRead')

            return undefined
          },
          get cacheWrite() {
            usageReads.push('input.cacheWrite')

            return undefined
          }
        }
      }
    })
    Object.defineProperty(usage, 'output', {
      configurable: true,
      enumerable: true,
      get: () => {
        usageReads.push('output')

        return {
          get total() {
            usageReads.push('output.total')

            return 9
          },
          get text() {
            usageReads.push('output.text')

            return undefined
          },
          get reasoning() {
            usageReads.push('output.reasoning')

            return undefined
          }
        }
      }
    })
    Object.defineProperty(provider, 'status', {
      configurable: true,
      enumerable: true,
      get: () => {
        providerReads.push('status')

        return undefined
      }
    })
    Object.defineProperty(provider, 'providerCode', {
      configurable: true,
      enumerable: true,
      get: () => {
        providerReads.push('providerCode')

        return undefined
      }
    })
    Object.defineProperty(provider, 'retryAfterMs', {
      configurable: true,
      enumerable: true,
      get: () => {
        providerReads.push('retryAfterMs')

        return undefined
      }
    })

    const result = makeSubagentToolResult({
      callId: 'call_absent',
      output: 'Absent optionals.',
      subagentType: 'explore',
      description: 'Absent optionals',
      subagentRunId: subagentToolRunId('call_absent'),
      startedAtMs: 1,
      endedAtMs: 2,
      model: 'test-model',
      usage,
      error: {
        code: 'unknown',
        message: 'Unknown failure.',
        retryable: false,
        provider
      }
    })

    const content = structuredContentObject(result)

    expect(JSON.stringify(content)).toContain('"usage":{"input":{"total":8},"output":{"total":9}}')
    expect(JSON.stringify(content)).toContain(
      '"error":{"code":"unknown","message":"Unknown failure.","retryable":false,"provider":{"provider":"openai_codex","kind":"unknown"}}'
    )
    expect(usageReads).toEqual([
      'input',
      'input.total',
      'input',
      'input.uncached',
      'input',
      'input.cacheRead',
      'input',
      'input.cacheWrite',
      'output',
      'output.total',
      'output',
      'output.text',
      'output',
      'output.reasoning'
    ])
    expect(providerReads).toEqual(['status', 'providerCode', 'retryAfterMs'])
  })

  it('reconstructs omitted and present AgentUsage fields from public tool results', () => {
    const omitted = makeSubagentToolResult({
      callId: 'call_usage_omitted',
      output: 'Usage omitted.',
      subagentType: 'explore',
      description: 'Usage omitted',
      subagentRunId: subagentToolRunId('call_usage_omitted'),
      startedAtMs: 1,
      endedAtMs: 2,
      model: 'test-model',
      usage: AgentUsage.make({ input: { total: 5 }, output: { total: 6 } })
    })

    const present = makeSubagentToolResult({
      callId: 'call_usage_present',
      output: 'Usage present.',
      subagentType: 'explore',
      description: 'Usage present',
      subagentRunId: subagentToolRunId('call_usage_present'),
      startedAtMs: 1,
      endedAtMs: 2,
      model: 'test-model',
      usage: AgentUsage.make({
        input: { total: 5, uncached: 1, cacheRead: 2, cacheWrite: 3 },
        output: { total: 6, text: 4, reasoning: 5 }
      })
    })

    expect(subagentUsageFromToolResult(omitted)).toEqual(
      AgentUsage.make({ input: { total: 5 }, output: { total: 6 } })
    )
    expect(subagentUsageFromToolResult(present)).toEqual(
      AgentUsage.make({
        input: { total: 5, uncached: 1, cacheRead: 2, cacheWrite: 3 },
        output: { total: 6, text: 4, reasoning: 5 }
      })
    )
    expect(
      subagentUsageFromToolResult(
        ToolResult.make({
          toolCallId: 'call_other',
          content: 'Other tool.',
          structuredContent: {
            subagent_run_id: 'unrelated-run',
            subagent_type: 'general',
            usage: { input: { total: 500 }, output: { total: 100 } }
          }
        })
      )
    ).toBeUndefined()
  })

  it('omits usage and turns on a missing-terminal failure and keeps error last', () => {
    const summary = subagentResultFromEvents([])

    expect(summary).toEqual({
      status: 'error',
      text: 'Subagent failed: Subagent stream ended without a terminal event.',
      error: {
        code: 'invalid_response',
        message: 'Subagent stream ended without a terminal event.',
        retryable: false
      }
    })
    expect(Object.keys(summary)).toEqual(['status', 'text', 'error'])
    expect(Object.hasOwn(summary, 'usage')).toBe(false)
    expect(Object.hasOwn(summary, 'turns')).toBe(false)
    expect(JSON.stringify(summary)).toBe(
      '{"status":"error","text":"Subagent failed: Subagent stream ended without a terminal event.","error":{"code":"invalid_response","message":"Subagent stream ended without a terminal event.","retryable":false}}'
    )
  })

  it('keeps missing-terminal usage/turns identities and key order from frozen events', () => {
    const usage = Object.freeze(AgentUsage.make({ input: { total: 12 }, output: { total: 3 } }))

    const summary = subagentResultFromEvents(
      Object.freeze([
        TurnStart.make({ turn: 1 }),
        UsageUpdate.make({ usage }),
        UsageUpdate.make({
          usage: AgentUsage.make({ input: { total: 8 }, output: { total: 2 } })
        })
      ])
    )

    expect(Object.keys(summary)).toEqual(['status', 'text', 'usage', 'turns', 'error'])
    expect(summary.usage).toEqual(AgentUsage.make({ input: { total: 20 }, output: { total: 5 } }))
    expect(summary.turns).toBe(1)
    expect(summary.error).toEqual({
      code: 'invalid_response',
      message: 'Subagent stream ended without a terminal event.',
      retryable: false
    })
  })

  it('preserves AgentError provider identity and rereads optional provider getters', () => {
    const provider = ProviderErrorInfo.make({
      provider: 'openai_codex',
      kind: 'context_overflow',
      providerCode: 'context_window_exceeded'
    })

    const reads: Array<string> = []

    const terminal = AgentError.make({
      code: 'context_overflow',
      message: 'Input exceeded the context window.',
      retryable: false,
      provider
    })

    Object.defineProperty(terminal, 'provider', {
      configurable: true,
      enumerable: true,
      get: () => {
        reads.push('provider')

        return provider
      }
    })
    Object.defineProperty(terminal, 'message', {
      configurable: true,
      enumerable: true,
      get: () => {
        reads.push('message')

        return 'Input exceeded the context window.'
      }
    })

    const summary = subagentResultFromEvents([
      TurnStart.make({ turn: 2 }),
      UsageUpdate.make({
        usage: AgentUsage.make({ input: { total: 80 }, output: { total: 20 } })
      }),
      terminal
    ])

    expect(summary.status).toBe('error')
    expect(Object.keys(summary)).toEqual(['status', 'text', 'usage', 'turns', 'error'])
    expect(summary.error?.provider).toBe(provider)
    expect(Object.keys(summary.error ?? {})).toEqual(['code', 'message', 'retryable', 'provider'])
    expect(reads).toEqual(['message', 'message', 'provider', 'provider'])
  })

  it('omits AgentError provider after a single condition read', () => {
    const reads: Array<string> = []

    const terminal = AgentError.make({
      code: 'invalid_response',
      message: 'Bad response.',
      retryable: false
    })

    Object.defineProperty(terminal, 'provider', {
      configurable: true,
      enumerable: true,
      get: () => {
        reads.push('provider')

        return undefined
      }
    })

    const summary = subagentResultFromEvents([terminal])

    expect(Object.keys(summary)).toEqual(['status', 'text', 'error'])
    expect(Object.hasOwn(summary.error ?? {}, 'provider')).toBe(false)
    expect(JSON.stringify(summary.error)).toBe(
      '{"code":"invalid_response","message":"Bad response.","retryable":false}'
    )
    expect(reads).toEqual(['provider'])
  })

  it('keeps completed usage/turns identities and omits requests', () => {
    const usage = Object.freeze(AgentUsage.make({ input: { total: 4 }, output: { total: 1 } }))

    const terminal = AgentEnd.make({
      messages: [assistantMessage('Done.')],
      turns: 1,
      usage
    })

    const summary = subagentResultFromEvents([terminal])

    expect(summary).toEqual({
      status: 'completed',
      text: 'Done.',
      usage,
      turns: 1
    })
    expect(summary.usage).toBe(terminal.usage)
    expect(Object.keys(summary)).toEqual(['status', 'text', 'usage', 'turns'])
    expect(Object.hasOwn(summary, 'requests')).toBe(false)
  })

  it('keeps awaiting-input request identity and rereads the tagged request getter once', () => {
    const request = ToolApprovalRequest.make({
      requestId: 'approval_1',
      toolCallId: 'call_approval_1',
      call: ToolCall.make({ id: 'call_approval_1', name: 'write', params: {} })
    })

    const usage = AgentUsage.make({ input: { total: 45 }, output: { total: 12 } })
    const reads: Array<string> = []

    const terminal = AgentAwaitingInput.make({
      requests: [request],
      messages: [assistantMessage('I need approval.')],
      turns: 2,
      usage
    })

    const requests = terminal.requests

    Object.defineProperty(terminal, 'requests', {
      configurable: true,
      enumerable: true,
      get: () => {
        reads.push('requests')

        return requests
      }
    })

    const summary = subagentResultFromEvents([terminal])

    expect(summary.status).toBe('awaiting_input')
    expect(summary.requests).toBe(requests)
    expect(summary.usage).toBe(terminal.usage)
    expect(Object.keys(summary)).toEqual(['status', 'text', 'usage', 'turns', 'requests'])
    expect(reads).toEqual(['requests'])
  })

  it('omits parent_run_id from accepted results until the getter supplies a value', () => {
    const omittedInput = Object.freeze({
      callId: 'call_accept',
      workflowRunId: 'workflow_1'
    } satisfies Parameters<typeof makeSubagentAcceptedToolResult>[0])

    const omitted = makeSubagentAcceptedToolResult(omittedInput)
    const omittedContent = structuredContentObject(omitted)

    expect(omitted.content).toBe(
      'Subagent accepted. Use subagent_status or subagent_wait with tool_call_id=call_accept.'
    )
    expect(Object.keys(omittedContent)).toEqual([
      'type',
      'status',
      'subagent_run_id',
      'workflow_run_id'
    ])
    expect(Object.hasOwn(omittedContent, 'parent_run_id')).toBe(false)
    expect(JSON.stringify(omittedContent)).toBe(
      '{"type":"subagent_accepted","status":"accepted","subagent_run_id":"subagent:call_accept","workflow_run_id":"workflow_1"}'
    )
    expect(subagentUsageFromToolResult(omitted)).toBeUndefined()

    const reads: Array<string> = []

    const present = makeSubagentAcceptedToolResult({
      callId: 'call_accept_parent',
      workflowRunId: 'workflow_2',
      get parentRunId() {
        reads.push('parentRunId')

        return 'parent_1'
      }
    })

    const presentContent = structuredContentObject(present)

    expect(present.content).toBe(
      'Subagent accepted. Use subagent_status or subagent_wait with tool_call_id=call_accept_parent and parent_run_id=parent_1.'
    )
    expect(Object.keys(presentContent)).toEqual([
      'type',
      'status',
      'subagent_run_id',
      'workflow_run_id',
      'parent_run_id'
    ])
    expect(JSON.stringify(presentContent)).toBe(
      '{"type":"subagent_accepted","status":"accepted","subagent_run_id":"subagent:call_accept_parent","workflow_run_id":"workflow_2","parent_run_id":"parent_1"}'
    )
    expect(reads).toEqual(['parentRunId', 'parentRunId', 'parentRunId', 'parentRunId'])
  })
})
