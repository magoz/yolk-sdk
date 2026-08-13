import { readFileSync } from 'node:fs'
import { describe, expect, it } from '@effect/vitest'

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

  it('omits subagent tool from subagent toolsets', () => {
    expect(subagentExecuteSource).toContain('subagent: true')
    expect(subagentExecuteSource).toContain('modules: subagentToolModules')
    expect(subagentExecuteSource).not.toContain('modules: toolModules')
    expect(subagentExecuteSource).toContain(':subagent:${call.id}')
    expect(subagentExecuteSource).not.toContain(':task:${call.id}')
  })

  it('returns subagent failures as subagent results', () => {
    expect(subagentExecuteSource).toContain("Effect.catchTag('ToolError'")
    expect(subagentExecuteSource).toContain('Subagent failed:')
    expect(subagentExecuteSource).toContain('isError: true')
  })

  it('adds subagent runtime metadata to structured results', () => {
    expect(source).toContain('subagentResultFromEvents')
    expect(source).toContain('makeSubagentToolResult')
    expect(source).toContain('subagentToolRunId')
    expect(source).toContain('startedAtMs')
    expect(source).toContain('endedAtMs')
    expect(source).toContain('status: summary.status')
    expect(source).toContain('usage: summary.usage')
    expect(source).toContain('turns: summary.turns')
    expect(source).toContain('requests: summary.requests')
    expect(source).toContain('error: summary.error')
  })
})
