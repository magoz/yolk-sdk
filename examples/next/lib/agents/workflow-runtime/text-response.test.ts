import { readFileSync } from 'node:fs'
import { Effect, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { LLMError } from '@yolk-sdk/agent/loop'
import { TurnStart, UsageUpdate, AgentUsage } from '@yolk-sdk/agent/protocol'
import { resolveAgentToolSet, nodeTextToolModules } from '@/lib/agents/tools/registry'
import { collectSubagentEvents } from './text-response'

const source = readFileSync('examples/next/lib/agents/workflow-runtime/text-response.ts', 'utf8')
const registrySource = readFileSync('examples/next/lib/agents/tools/registry.ts', 'utf8')

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
      expect(registrySource).toContain('context.subagent !== true')
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
      expect(subagentExecuteSource).toContain("Effect.catchTag('ToolError'")
      expect(subagentExecuteSource).toContain('isError: true')
    })
  )

  it('adds subagent runtime metadata to structured results', () => {
    expect(source).toContain('subagentResultFromEvents')
    expect(source).toContain('makeSubagentToolResult')
    expect(source).toContain('subagentToolRunId')
    expect(source).toContain('startedAtMs')
    expect(source).toContain('endedAtMs')
    expect(source).toContain('reasoningEffort,')
    expect(source).toContain('status: summary.status')
    expect(source).toContain('usage: summary.usage')
    expect(source).toContain('turns: summary.turns')
    expect(source).toContain('requests: summary.requests')
    expect(source).toContain('error: summary.error')
  })
})
