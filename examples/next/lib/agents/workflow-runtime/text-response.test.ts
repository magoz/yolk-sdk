import { readFileSync } from 'node:fs'
import { describe, expect, it } from '@effect/vitest'

const source = readFileSync('examples/next/lib/agents/workflow-runtime/text-response.ts', 'utf8')

const taskToolStart = source.indexOf(
  'const subagentToolModule = makeNonRecursiveSubagentToolModule'
)
const taskExecuteSource = source.slice(
  taskToolStart,
  source.indexOf('const toolModules', taskToolStart)
)

describe('makeAgentTextRuntime subagent tool wiring', () => {
  it('adds subagent tool to top-level text runtime', () => {
    expect(taskToolStart).toBeGreaterThanOrEqual(0)
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
    expect(taskExecuteSource).toContain('subagent: true')
    expect(taskExecuteSource).toContain('modules: subagentToolModules')
    expect(taskExecuteSource).not.toContain('modules: toolModules')
  })

  it('returns subagent failures as task results', () => {
    expect(taskExecuteSource).toContain("Effect.catchTag('ToolError'")
    expect(taskExecuteSource).toContain('Subagent failed:')
    expect(taskExecuteSource).toContain('isError: true')
  })

  it('adds task timing metadata to structured results', () => {
    expect(source).toContain('makeSubagentToolResult')
    expect(source).toContain('subagentToolRunId')
    expect(source).toContain('startedAtMs')
    expect(source).toContain('endedAtMs')
  })
})
