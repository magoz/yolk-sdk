import { readFileSync } from 'node:fs'
import { Effect, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { LLMError, ToolError } from '@yolk-sdk/agent/loop'
import {
  TurnStart,
  UsageUpdate,
  AgentUsage,
  ProviderErrorInfo
} from '@yolk-sdk/agent/protocol'
import { resolveAgentToolSet, nodeTextToolModules } from '@/lib/agents/tools/registry'
import {
  collectSubagentEvents,
  makeCompletedSubagentToolResult,
  recoverSubagentToolFailure
} from './text-response'

const source = readFileSync('examples/next/lib/agents/workflow-runtime/text-response.ts', 'utf8')

const subagentToolStart = source.indexOf(
  'const subagentToolModule = makeNonRecursiveSubagentToolModule'
)
const subagentExecuteSource = source.slice(
  subagentToolStart,
  source.indexOf('const toolModules', subagentToolStart)
)

describe('makeAgentTextRuntime subagent tool wiring', () => {
  it('adds subagent tool to top-level text runtime', () => {
    expect(subagentToolStart).toBeGreaterThanOrEqual(0)
    expect(source).toContain('const knowledgeToolModule = makeAppKnowledgeToolModule()')
    expect(source).toContain('const storageToolModule = makeAppStorageKnowledgeSearchToolModule()')
    expect(source).toContain(
      'const subagentToolModules: ReadonlyArray<ToolModule<AgentToolContext>> = ['
    )
    expect(source).toContain('const toolModules: ReadonlyArray<ToolModule<AgentToolContext>> = [')
    expect(source).toContain('storageToolModule')
    expect(source).toContain('knowledgeToolModule')
    expect(source).toContain('...subagentToolModules,')
    expect(source).toContain('subagentToolModule')
    expect(source).toContain("name: 'general'")
    expect(source).toContain("name: 'explore'")
  })

  it.effect('omits recursive delegation and question HITL from child toolsets', () =>
    Effect.gen(function* () {
      const childTools = yield* resolveAgentToolSet({
        modules: nodeTextToolModules,
        context: {
          surface: 'text',
          route: '/agent/workflow',
          userId: 'user_1',
          subagent: true
        }
      })

      expect(subagentExecuteSource).toContain('subagent: true')
      expect(subagentExecuteSource).toContain('modules: subagentToolModules')
      expect(subagentExecuteSource).not.toContain('modules: toolModules')
      expect(subagentExecuteSource).toContain(':subagent:${call.id}')
      expect(subagentExecuteSource).not.toContain(':task:${call.id}')
      expect(childTools.tools.map(tool => tool.name)).not.toContain('question')
    })
  )

  it.effect('retains partial child events and appends a typed terminal error', () =>
    Effect.gen(function* () {
      const events = yield* collectSubagentEvents(
        Stream.fromIterable([
          TurnStart.make({ turn: 1 }),
          UsageUpdate.make({
            usage: AgentUsage.make({ input: { total: 10 }, output: { total: 2 } })
          })
        ]).pipe(
          Stream.concat(
            Stream.fail(
              new LLMError({
                message: 'Child failed.',
                cause: 'provider_error',
                retryable: false
              })
            )
          )
        )
      )

      expect(events.map(event => event._tag)).toEqual([
        'TurnStart',
        'UsageUpdate',
        'AgentError'
      ])
      expect(events.at(-1)).toMatchObject({
        _tag: 'AgentError',
        code: 'provider_error',
        message: 'Child failed.'
      })
    })
  )

  it.effect('returns typed metadata for child setup failures and defects', () =>
    Effect.gen(function* () {
      const common = {
        callId: 'call_1',
        subagentType: 'general',
        description: 'Inspect code',
        subagentRunId: 'subagent:call_1',
        startedAtMs: 100,
        model: 'test-model',
        reasoningEffort: 'high' as const
      }
      const toolFailure = yield* recoverSubagentToolFailure(
        Effect.fail(
          new ToolError({
            tool: 'subagent',
            message: 'Child tool setup failed.',
            cause: 'execution'
          })
        ),
        common
      )
      const unknownFailure = yield* recoverSubagentToolFailure(
        Effect.die(new Error('Unexpected child failure.')),
        common
      )

      expect(toolFailure).toMatchObject({
        isError: true,
        structuredContent: {
          status: 'error',
          error: {
            code: 'tool_error',
            message: 'Child tool setup failed.',
            retryable: false
          }
        }
      })
      expect(unknownFailure).toMatchObject({
        isError: true,
        structuredContent: {
          status: 'error',
          error: {
            code: 'unknown',
            message: 'Unexpected child failure.',
            retryable: false
          }
        }
      })
    })
  )

  it('adds complete runtime metadata to subagent results', () => {
    const provider = ProviderErrorInfo.make({
      provider: 'openai_codex',
      kind: 'context_overflow'
    })
    const result = makeCompletedSubagentToolResult({
      callId: 'call_2',
      subagentType: 'general',
      description: 'Inspect code',
      subagentRunId: 'subagent:call_2',
      startedAtMs: 100,
      endedAtMs: 250,
      model: 'test-model',
      reasoningEffort: 'high',
      result: {
        status: 'error',
        text: 'Subagent failed: context overflow',
        usage: AgentUsage.make({ input: { total: 40 }, output: { total: 5 } }),
        turns: 2,
        error: {
          code: 'context_overflow',
          message: 'context overflow',
          retryable: false,
          provider
        }
      }
    })

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        subagent_run_id: 'subagent:call_2',
        started_at_ms: 100,
        ended_at_ms: 250,
        reasoning_effort: 'high',
        status: 'error',
        usage: { input: { total: 40 }, output: { total: 5 } },
        turns: 2,
        error: {
          code: 'context_overflow',
          provider: { provider: 'openai_codex', kind: 'context_overflow' }
        }
      }
    })
  })
})
