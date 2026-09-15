import { readFileSync } from 'node:fs'
import { describe, expect, it } from '@effect/vitest'

const source = readFileSync(
  'examples/next/lib/agents/workflow-runtime/run-agent-workflow.ts',
  'utf8'
)

const runtimeSource = readFileSync(
  'examples/next/lib/agents/workflow-runtime/agent-workflow-steps.ts',
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
    expect(workflowFunctionSource).toContain('orchestrateAgentWorkflowTools')
    expect(workflowFunctionSource).toContain('closeAgentWorkflowStream')
    expect(workflowFunctionSource).toContain('writeWorkflowErrorStep')
  })

  it('uses package workflow orchestration with local step callbacks', () => {
    expect(workflowFunctionSource).toContain('runVercelAgentWorkflow')
    expect(workflowFunctionSource).toContain('runModelStep: runAgentWorkflowModelStep')
    expect(workflowFunctionSource).toContain('runToolBatchStep: orchestrateAgentWorkflowTools')
    expect(workflowFunctionSource).toContain('awaitInput:')
  })

  it('keeps Node-only dependencies behind dynamic step imports', () => {
    expect(source).toContain("await import('./agent-workflow-steps')")
    expect(source).not.toContain("from 'effect'")
    expect(runtimeSource).not.toContain("'use step'")

    const childSteps = readFileSync(
      'examples/next/lib/agents/workflow-runtime/workflow-child-steps.ts',
      'utf8'
    )

    expect(childSteps).toContain("await import('./child-control')")
    expect(childSteps).toContain('planWorkflowCallStep.maxRetries = 0')
  })

  it('disables platform retries for streamed model and side-effecting tool steps', () => {
    expect(source).toContain('runAgentWorkflowModelStep.maxRetries = 0')
    expect(source).toContain('runAgentWorkflowToolBatchStep.maxRetries = 0')
  })

  it('carries partial progress through durable tool results', () => {
    expect(runtimeSource).toContain('addWorkflowToolResultUsage')
    expect(runtimeSource).toContain('const cumulativeUsage = yield* Ref.make(usage)')
    expect(runtimeSource).toContain('usage: yield* encodeUsage(currentUsage)')
    expect(runtimeSource).toContain('const failureMessages = await Effect.runPromise(')
    expect(runtimeSource).toContain(
      'createdMessages: [...input.createdMessages, ...failureMessages]'
    )
  })

  it('scopes durable event ids to the workflow run', () => {
    expect(runtimeSource).toContain(
      'const workflowEventStreamId = (workflowRunId: string) => `workflow:${workflowRunId}`'
    )
    expect(runtimeSource).toContain('streamId: workflowEventStreamId(input.workflowRunId)')
    expect(runtimeSource).not.toContain("const workflowEventStreamId = 'workflow'")
  })
})

describe('independent child workflow source boundaries', () => {
  it('starts a distinct workflow, not a nested step or inline child runtime', () => {
    expect(source).toContain('await start(runChildAgentWorkflow, [plan.child])')
    expect(source).toContain('await admitChildWorkflowStep(input)')
    expect(source).toContain('await persistChildTerminalStep(input,')
    expect(source).toContain("throw new Error('Child workflow failed')")
    expect(source).not.toContain('runRuntime(')
  })
  it('never cascades Stop from workflow completion/failure handlers', () => {
    expect(source).not.toContain('stopAgentWorkflow')
    expect(source).not.toContain('.cancel(')
  })
})
