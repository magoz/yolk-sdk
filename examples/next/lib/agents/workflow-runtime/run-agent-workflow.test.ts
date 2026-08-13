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

  it('disables platform retries for streamed model and side-effecting tool steps', () => {
    expect(source).toContain('runAgentWorkflowModelStep.maxRetries = 0')
    expect(source).toContain('runAgentWorkflowToolBatchStep.maxRetries = 0')
  })

  it('carries partial progress through durable tool results', () => {
    expect(source).toContain('addWorkflowToolResultUsage')
    expect(source).toContain('const cumulativeUsage = yield* Ref.make(usage)')
    expect(source).toContain('usage: yield* encodeUsage(currentUsage)')
    expect(source).toContain('const failureMessages = await Effect.runPromise(')
    expect(source).toContain(
      'createdMessages: [...input.createdMessages, ...failureMessages]'
    )
  })

  it('scopes durable event ids to the workflow run', () => {
    expect(source).toContain(
      'const workflowEventStreamId = (workflowRunId: string) => `workflow:${workflowRunId}`'
    )
    expect(source).toContain('streamId: workflowEventStreamId(input.workflowRunId)')
    expect(source).not.toContain("const workflowEventStreamId = 'workflow'")
  })
})
