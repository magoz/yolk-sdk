import { readFileSync } from 'node:fs'
import { describe, expect, it } from '@effect/vitest'

const source = readFileSync(
  'examples/next/lib/agents/workflow-runtime/run-agent-workflow.ts',
  'utf8'
)

const workflowFunctionStart = source.lastIndexOf('export async function runAgentWorkflow')
const workflowFunctionSource = source.slice(workflowFunctionStart)

describe('runAgentWorkflow', () => {
  it('keeps Effect runtime out of workflow orchestration', () => {
    expect(workflowFunctionStart).toBeGreaterThanOrEqual(0)
    expect(workflowFunctionSource).not.toContain('Effect.runPromise')
    expect(workflowFunctionSource).not.toContain('Effect.tryPromise')
    expect(workflowFunctionSource).not.toContain('Effect.suspend')
  })

  it('delegates runtime work to workflow steps', () => {
    expect(workflowFunctionSource).toContain('runAgentWorkflowModelStep')
    expect(workflowFunctionSource).toContain('runAgentWorkflowToolBatchStep')
    expect(workflowFunctionSource).toContain('closeAgentWorkflowStream')
    expect(workflowFunctionSource).toContain('writeWorkflowErrorStep')
  })

  it('uses package workflow orchestration with local step callbacks', () => {
    expect(workflowFunctionSource).toContain('runVercelAgentWorkflow')
    expect(workflowFunctionSource).toContain('runModelStep: runAgentWorkflowModelStep')
    expect(workflowFunctionSource).toContain('runToolBatchStep: runAgentWorkflowToolBatchStep')
    expect(workflowFunctionSource).toContain('awaitInput:')
  })
})
