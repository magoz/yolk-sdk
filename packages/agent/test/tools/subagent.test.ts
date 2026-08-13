import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentAwaitingInput,
  AgentEnd,
  AgentError,
  AgentUsage,
  AssistantAgentMessage,
  AssistantTextPart,
  makeSubagentRunId,
  ProviderErrorInfo,
  ToolApprovalRequest,
  ToolCall,
  ToolResult,
  TurnStart,
  UsageUpdate
} from '@yolk-sdk/agent/protocol'
import {
  formatSubagentResult,
  makeNonRecursiveSubagentToolModule,
  makeSubagentToolResult,
  makeSubagentToolModule,
  resolveTools,
  subagentResultFromEvents,
  subagentResultText,
  subagentToolName,
  subagentUsageFromToolResult,
  subagentToolRunId,
  type SubagentReasoningEffortDefinition,
  type SubagentDefinition
} from '../../src/tools'

type TestContext = {
  readonly sessionId: string
  readonly subagent?: boolean
}

const subagents: ReadonlyArray<SubagentDefinition> = [
  { name: 'explore', description: 'Explore code and docs.' },
  { name: 'general', description: 'Handle complex multi-step work.' }
]

const models = [
  { id: 'fast-model', description: 'Fast model for focused exploration.' },
  { id: 'deep-model', description: 'Strong model for difficult synthesis.' }
]

const reasoningEfforts: ReadonlyArray<SubagentReasoningEffortDefinition> = [
  { value: 'low', description: 'Use for straightforward work.' },
  { value: 'high', description: 'Use for difficult reasoning.' }
]

describe('subagent tool', () => {
  it.effect('resolves subagent tool with subagent metadata', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [
          makeSubagentToolModule<TestContext>({
            subagents,
            execute: ({ call }) =>
              Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'unused' }))
          })
        ],
        { sessionId: 'session_1' }
      )

      expect(toolSet.tools.map(tool => tool.name)).toEqual([subagentToolName])
      expect(toolSet.tools[0]?.description).toContain('explore')
      expect(toolSet.tools[0]?.description).toContain('call this subagent tool multiple times')
      expect(toolSet.tools[0]?.description).toContain('runs same-turn subagent calls concurrently')
      expect(toolSet.tools[0]?.description).not.toContain('multi_tool_use')
      expect(toolSet.metadata).toEqual([
        { moduleId: 'subagent', name: subagentToolName, access: 'read' }
      ])
    })
  )

  it.effect('exposes configured model and reasoning choices', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [
          makeSubagentToolModule<TestContext>({
            subagents,
            models,
            reasoningEfforts,
            execute: ({ call }) =>
              Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'unused' }))
          })
        ],
        { sessionId: 'session_1' }
      )
      const tool = toolSet.tools[0]

      expect(tool?.description).toContain('fast-model: Fast model for focused exploration.')
      expect(tool?.description).toContain('low: Use for straightforward work.')
      expect(tool?.parameters).toMatchObject({
        type: 'object',
        properties: {
          model: {
            anyOf: [{ enum: ['fast-model'] }, { enum: ['deep-model'] }]
          },
          reasoning_effort: {
            anyOf: [{ enum: ['low'] }, { enum: ['high'] }]
          }
        }
      })
      expect(tool?.parameters).not.toMatchObject({ required: ['model', 'reasoning_effort'] })
    })
  )

  it.effect('omits unconfigured model and reasoning choices', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [
          makeSubagentToolModule<TestContext>({
            subagents,
            execute: ({ call }) =>
              Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'unused' }))
          })
        ],
        { sessionId: 'session_1' }
      )
      const parameters = toolSet.tools[0]?.parameters

      expect(parameters).not.toMatchObject({
        properties: {
          model: expect.anything()
        }
      })
      expect(parameters).not.toMatchObject({
        properties: {
          reasoning_effort: expect.anything()
        }
      })
    })
  )

  it.effect('supports model-only and reasoning-only configurations', () =>
    Effect.gen(function* () {
      const execute = ({ call }: { readonly call: { readonly id: string } }) =>
        Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'unused' }))
      const modelOnly = yield* resolveTools(
        [makeSubagentToolModule<TestContext>({ subagents, models, execute })],
        { sessionId: 'session_1' }
      )
      const reasoningOnly = yield* resolveTools(
        [makeSubagentToolModule<TestContext>({ subagents, reasoningEfforts, execute })],
        { sessionId: 'session_1' }
      )

      expect(modelOnly.tools[0]?.parameters).toMatchObject({
        type: 'object',
        properties: { model: expect.anything() }
      })
      expect(modelOnly.tools[0]?.parameters).not.toMatchObject({
        properties: { reasoning_effort: expect.anything() }
      })
      expect(reasoningOnly.tools[0]?.parameters).toMatchObject({
        type: 'object',
        properties: { reasoning_effort: expect.anything() }
      })
      expect(reasoningOnly.tools[0]?.parameters).not.toMatchObject({
        properties: { model: expect.anything() }
      })
    })
  )

  it.effect('executes a known subagent with runtime selections', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [
          makeSubagentToolModule<TestContext>({
            subagents,
            models,
            reasoningEfforts,
            execute: ({ call, context, params }) =>
              Effect.succeed(
                ToolResult.make({
                  toolCallId: call.id,
                  content: formatSubagentResult(
                    [
                      context.sessionId,
                      params.subagent_type,
                      params.description,
                      params.prompt,
                      params.model,
                      params.reasoning_effort
                    ].join(':')
                  )
                })
              )
          })
        ],
        { sessionId: 'session_1' }
      )
      const result = yield* toolSet.execute({
        id: 'call_1',
        name: subagentToolName,
        params: {
          description: 'Find auth',
          prompt: 'Explore auth flow',
          subagent_type: 'explore',
          model: 'fast-model',
          reasoning_effort: 'low'
        }
      })

      expect(result.content).toBe(
        '<subagent_result>\nsession_1:explore:Find auth:Explore auth flow:fast-model:low\n</subagent_result>'
      )
    })
  )

  it.effect('preserves configured model IDs as opaque values', () =>
    Effect.gen(function* () {
      const opaqueModelId = '  host/model id  '
      const toolSet = yield* resolveTools(
        [
          makeSubagentToolModule<TestContext>({
            subagents,
            models: [{ id: opaqueModelId, description: 'Host-owned opaque model id.' }],
            execute: ({ call, params }) =>
              Effect.succeed(
                ToolResult.make({ toolCallId: call.id, content: params.model ?? 'inherit' })
              )
          })
        ],
        { sessionId: 'session_1' }
      )
      const result = yield* toolSet.execute({
        id: 'call_1',
        name: subagentToolName,
        params: {
          description: 'Find auth',
          prompt: 'Explore auth flow',
          subagent_type: 'explore',
          model: opaqueModelId
        }
      })

      expect(result.content).toBe(opaqueModelId)
    })
  )

  it.effect('rejects models outside the configured choices', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [
          makeSubagentToolModule<TestContext>({
            subagents,
            models,
            reasoningEfforts,
            execute: ({ call }) =>
              Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'unused' }))
          })
        ],
        { sessionId: 'session_1' }
      )
      const result = yield* toolSet.execute({
        id: 'call_1',
        name: subagentToolName,
        params: {
          description: 'Find auth',
          prompt: 'Explore auth flow',
          subagent_type: 'explore',
          model: 'unknown-model',
          reasoning_effort: 'low'
        }
      })

      expect(result).toMatchObject({
        toolCallId: 'call_1',
        isError: true,
        structuredContent: { type: 'model_visible_tool_error', reason: 'validation' }
      })
    })
  )

  it.effect('rejects reasoning efforts outside the configured choices', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [
          makeSubagentToolModule<TestContext>({
            subagents,
            models,
            reasoningEfforts,
            execute: ({ call }) =>
              Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'unused' }))
          })
        ],
        { sessionId: 'session_1' }
      )
      const result = yield* toolSet.execute({
        id: 'call_1',
        name: subagentToolName,
        params: {
          description: 'Find auth',
          prompt: 'Explore auth flow',
          subagent_type: 'explore',
          model: 'fast-model',
          reasoning_effort: 'medium'
        }
      })

      expect(result).toMatchObject({
        toolCallId: 'call_1',
        isError: true,
        structuredContent: { type: 'model_visible_tool_error', reason: 'validation' }
      })
    })
  )

  it.effect('inherits host runtime settings when selections are omitted', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [
          makeSubagentToolModule<TestContext>({
            subagents,
            models,
            reasoningEfforts,
            execute: ({ call, params }) =>
              Effect.succeed(
                ToolResult.make({
                  toolCallId: call.id,
                  content: `${params.model ?? 'inherit'}:${params.reasoning_effort ?? 'inherit'}`
                })
              )
          })
        ],
        { sessionId: 'session_1' }
      )
      const result = yield* toolSet.execute({
        id: 'call_1',
        name: subagentToolName,
        params: {
          description: 'Find auth',
          prompt: 'Explore auth flow',
          subagent_type: 'explore'
        }
      })

      expect(result.content).toBe('inherit:inherit')
    })
  )

  it.effect('returns model-visible errors for unknown subagent types', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [
          makeSubagentToolModule<TestContext>({
            subagents,
            execute: ({ call }) =>
              Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'unused' }))
          })
        ],
        { sessionId: 'session_1' }
      )
      const result = yield* toolSet.execute({
        id: 'call_1',
        name: subagentToolName,
        params: {
          description: 'Find auth',
          prompt: 'Explore auth flow',
          subagent_type: 'missing'
        }
      })

      expect(result).toMatchObject({
        toolCallId: 'call_1',
        content: 'Unknown subagent type: missing',
        isError: true
      })
    })
  )

  it.effect('returns model-visible errors for empty prompts', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [
          makeSubagentToolModule<TestContext>({
            subagents,
            execute: ({ call }) =>
              Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'unused' }))
          })
        ],
        { sessionId: 'session_1' }
      )
      const result = yield* toolSet.execute({
        id: 'call_1',
        name: subagentToolName,
        params: {
          description: 'Find auth',
          prompt: ' ',
          subagent_type: 'explore'
        }
      })

      expect(result).toMatchObject({
        toolCallId: 'call_1',
        content: 'prompt must not be empty',
        isError: true
      })
    })
  )

  it.effect('can hide the subagent tool from subagents', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools(
        [
          makeNonRecursiveSubagentToolModule<TestContext>({
            subagents,
            execute: ({ call }) =>
              Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'unused' }))
          })
        ],
        { sessionId: 'session_1', subagent: true }
      )

      expect(toolSet.tools).toEqual([])
    })
  )

  it.effect('composes non-recursive gating with host gating', () =>
    Effect.gen(function* () {
      const subagentModule = makeNonRecursiveSubagentToolModule<TestContext>({
        subagents,
        isEnabled: context => Effect.succeed(context.sessionId === 'enabled_session'),
        execute: ({ call }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'unused' }))
      })

      const disabledTopLevelTools = yield* resolveTools([subagentModule], {
        sessionId: 'disabled_session'
      })
      const enabledTopLevelTools = yield* resolveTools([subagentModule], {
        sessionId: 'enabled_session'
      })
      const enabledSubagentTools = yield* resolveTools([subagentModule], {
        sessionId: 'enabled_session',
        subagent: true
      })

      expect(disabledTopLevelTools.tools).toEqual([])
      expect(enabledTopLevelTools.tools.map(tool => tool.name)).toEqual([subagentToolName])
      expect(enabledSubagentTools.tools).toEqual([])
    })
  )

  it('formats structured subagent tool results', () => {
    const result = makeSubagentToolResult({
      callId: 'call_1',
      output: 'Found docs.',
      subagentType: 'explore',
      description: 'Find docs',
      subagentRunId: subagentToolRunId('call_1'),
      startedAtMs: 100,
      endedAtMs: 250,
      model: 'test-model',
      reasoningEffort: 'high',
      usage: AgentUsage.make({ input: { total: 120 }, output: { total: 30 } }),
      turns: 4
    })

    expect(result).toMatchObject({
      toolCallId: 'call_1',
      content: '<subagent_result>\nFound docs.\n</subagent_result>',
      structuredContent: {
        subagent_run_id: 'subagent:call_1',
        subagent_type: 'explore',
        description: 'Find docs',
        duration_ms: 150,
        status: 'completed',
        model: 'test-model',
        reasoning_effort: 'high',
        usage: { input: { total: 120 }, output: { total: 30 } },
        turns: 4
      }
    })
    expect(subagentUsageFromToolResult(result)).toEqual(
      AgentUsage.make({ input: { total: 120 }, output: { total: 30 } })
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
    expect(subagentToolRunId('call_1')).toBe(makeSubagentRunId('call_1'))
  })

  it('extracts final subagent assistant text', () => {
    const text = subagentResultText([
      AgentEnd.make({
        messages: [
          AssistantAgentMessage.make({
            parts: [AssistantTextPart.make({ content: 'Done.' })]
          })
        ],
        turns: 1,
        usage: { input: { total: 0 }, output: { total: 0 } }
      })
    ])

    expect(text).toBe('Done.')
  })

  it('extracts text and usage when a subagent awaits input', () => {
    const summary = subagentResultFromEvents([
      AgentAwaitingInput.make({
        requests: [
          ToolApprovalRequest.make({
            requestId: 'approval_1',
            toolCallId: 'call_approval_1',
            call: ToolCall.make({ id: 'call_approval_1', name: 'write', params: {} })
          })
        ],
        messages: [
          AssistantAgentMessage.make({
            parts: [AssistantTextPart.make({ content: 'I need approval.' })]
          })
        ],
        turns: 2,
        usage: AgentUsage.make({ input: { total: 45 }, output: { total: 12 } })
      })
    ])

    expect(summary).toMatchObject({
      status: 'awaiting_input',
      text: 'I need approval.',
      turns: 2,
      usage: { input: { total: 45 }, output: { total: 12 } },
      requests: [{ _tag: 'ToolApprovalRequest', requestId: 'approval_1' }]
    })

    const result = makeSubagentToolResult({
      callId: 'call_awaiting',
      output: summary.text,
      subagentType: 'general',
      description: 'Ask for approval',
      subagentRunId: subagentToolRunId('call_awaiting'),
      startedAtMs: 100,
      endedAtMs: 200,
      model: 'test-model',
      status: summary.status,
      requests: summary.requests
    })

    expect(result.structuredContent).toMatchObject({
      status: 'awaiting_input',
      hitl_requests: [{ _tag: 'ToolApprovalRequest', requestId: 'approval_1' }]
    })
  })

  it('extracts typed subagent errors and includes them in result metadata', () => {
    const provider = ProviderErrorInfo.make({
      provider: 'openai_codex',
      kind: 'context_overflow',
      providerCode: 'context_window_exceeded'
    })
    const summary = subagentResultFromEvents([
      TurnStart.make({ turn: 1 }),
      UsageUpdate.make({
        usage: AgentUsage.make({ input: { total: 120 }, output: { total: 30 } })
      }),
      TurnStart.make({ turn: 2 }),
      UsageUpdate.make({
        usage: AgentUsage.make({ input: { total: 80 }, output: { total: 20 } })
      }),
      AgentError.make({
        code: 'context_overflow',
        message: 'Input exceeded the context window.',
        retryable: false,
        provider
      })
    ])
    const result = makeSubagentToolResult({
      callId: 'call_2',
      output: summary.text,
      subagentType: 'general',
      description: 'Inspect context',
      subagentRunId: subagentToolRunId('call_2'),
      startedAtMs: 100,
      endedAtMs: 200,
      model: 'test-model',
      usage: summary.usage,
      turns: summary.turns,
      error: summary.error,
      isError: true
    })

    expect(summary).toMatchObject({
      status: 'error',
      usage: { input: { total: 200 }, output: { total: 50 } },
      turns: 2
    })
    expect(summary.text).toContain('Input exceeded the context window.')
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      status: 'error',
      usage: { input: { total: 200 }, output: { total: 50 } },
      turns: 2,
      error: {
        code: 'context_overflow',
        retryable: false,
        provider: {
          provider: 'openai_codex',
          kind: 'context_overflow',
          provider_code: 'context_window_exceeded'
        }
      }
    })
  })
})
