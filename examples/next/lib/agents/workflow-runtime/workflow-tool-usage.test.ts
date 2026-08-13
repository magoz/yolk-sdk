import { describe, expect, it } from '@effect/vitest'
import { AgentUsage } from '@yolk-sdk/agent/protocol'
import { makeSubagentToolResult } from '@yolk-sdk/agent/tools'
import { addWorkflowToolResultUsage } from './workflow-tool-usage'

describe('addWorkflowToolResultUsage', () => {
  it('adds nested subagent usage to cumulative workflow usage', () => {
    const usage = addWorkflowToolResultUsage(
      AgentUsage.make({ input: { total: 100 }, output: { total: 20 } }),
      makeSubagentToolResult({
        callId: 'call_1',
        output: 'Done.',
        subagentType: 'general',
        description: 'Do work',
        subagentRunId: 'subagent:call_1',
        startedAtMs: 100,
        endedAtMs: 200,
        model: 'test-model',
        usage: AgentUsage.make({ input: { total: 40 }, output: { total: 8 } }),
        turns: 2
      })
    )

    expect(usage).toEqual(
      AgentUsage.make({ input: { total: 140 }, output: { total: 28 } })
    )
  })
})
