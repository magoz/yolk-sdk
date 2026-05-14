import { readFileSync } from 'node:fs'
import { describe, expect, it } from '@effect/vitest'

const source = readFileSync('lib/agents/workflow-runtime/text-response.ts', 'utf8')

const taskToolStart = source.indexOf('const taskToolModule = makeTaskToolModule')
const taskExecuteSource = source.slice(taskToolStart, source.indexOf('const toolModules', taskToolStart))

describe('makeAgentTextRuntime task tool wiring', () => {
  it('adds task tool to top-level text runtime', () => {
    expect(taskToolStart).toBeGreaterThanOrEqual(0)
    expect(source).toContain('const toolModules: ReadonlyArray<ToolModule<AgentToolContext>> = [...baseToolModules, taskToolModule]')
    expect(source).toContain("name: 'general'")
    expect(source).toContain("name: 'explore'")
  })

  it('omits task tool from subagent toolsets', () => {
    expect(taskExecuteSource).toContain('subagent: true')
    expect(taskExecuteSource).toContain('modules: baseToolModules')
    expect(taskExecuteSource).not.toContain('modules: toolModules')
  })
})
