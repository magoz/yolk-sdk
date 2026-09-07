import { createHook, sleep } from 'workflow'
import { start } from 'workflow/api'
import {
  awaitWorkflowChild,
  orchestrateWorkflowToolBatch,
  runVercelAgentWorkflow,
  type VercelAgentWorkflowToolBatchStepInput,
  type VercelAgentWorkflowToolBatchStepResult
} from '@yolk-sdk/vercel-workflows'
import {
  maxChildWorkflowTurns,
  workflowToolConcurrency
} from '@/lib/services/agent-workflow/policy'
import type { ChildLaunch, ChildRead } from './child-control'
import type * as StepRuntimeModule from './agent-workflow-steps'
import type { AgentWorkflowInput } from './workflow-contract'
import {
  registerWorkflowStep,
  planWorkflowCallStep,
  admitChildWorkflowStep,
  persistChildTerminalStep,
  readChildWorkflowStep,
  attachChildWorkflowStep,
  childToolResultStep,
  uncertainChildLaunchStep,
  childControlFailureStep
} from './workflow-child-steps'
export { agentWorkflowHitlHookToken } from './workflow-contract'
export type { AgentWorkflowInput } from './workflow-contract'

// These wrappers are the durable boundaries; runtime imports belong inside them.
type StepRuntime = typeof StepRuntimeModule
export async function runAgentWorkflowModelStep(
  ...args: Parameters<StepRuntime['runAgentWorkflowModelStep']>
): ReturnType<StepRuntime['runAgentWorkflowModelStep']> {
  'use step'
  const runtime = await import('./agent-workflow-steps')
  return await runtime.runAgentWorkflowModelStep(...args)
}

export async function runAgentWorkflowToolBatchStep(
  ...args: Parameters<StepRuntime['runAgentWorkflowToolBatchStep']>
): ReturnType<StepRuntime['runAgentWorkflowToolBatchStep']> {
  'use step'
  const runtime = await import('./agent-workflow-steps')
  return await runtime.runAgentWorkflowToolBatchStep(...args)
}

export async function closeAgentWorkflowStream(
  ...args: Parameters<StepRuntime['closeAgentWorkflowStream']>
): ReturnType<StepRuntime['closeAgentWorkflowStream']> {
  'use step'
  const runtime = await import('./agent-workflow-steps')
  return await runtime.closeAgentWorkflowStream(...args)
}

export async function writeAgentWorkflowError(
  ...args: Parameters<StepRuntime['writeAgentWorkflowError']>
): ReturnType<StepRuntime['writeAgentWorkflowError']> {
  'use step'
  const runtime = await import('./agent-workflow-steps')
  return await runtime.writeAgentWorkflowError(...args)
}

export async function mergeWorkflowToolResultsStep(
  ...args: Parameters<StepRuntime['mergeWorkflowToolResultsStep']>
): ReturnType<StepRuntime['mergeWorkflowToolResultsStep']> {
  'use step'
  const runtime = await import('./agent-workflow-steps')
  return await runtime.mergeWorkflowToolResultsStep(...args)
}

export async function startWorkflowChildToolStep(
  ...args: Parameters<StepRuntime['startWorkflowChildToolStep']>
): ReturnType<StepRuntime['startWorkflowChildToolStep']> {
  'use step'
  const runtime = await import('./agent-workflow-steps')
  return await runtime.startWorkflowChildToolStep(...args)
}

export async function executableWorkflowCallStep(
  ...args: Parameters<StepRuntime['executableWorkflowCallStep']>
): ReturnType<StepRuntime['executableWorkflowCallStep']> {
  'use step'
  const runtime = await import('./agent-workflow-steps')
  return await runtime.executableWorkflowCallStep(...args)
}

runAgentWorkflowModelStep.maxRetries = 0
runAgentWorkflowToolBatchStep.maxRetries = 0
startWorkflowChildToolStep.maxRetries = 0

const writeWorkflowErrorStep = (error: unknown) =>
  writeAgentWorkflowError(error).catch(() => undefined)

// This is workflow orchestration, NOT a step. Concrete tool/model work remains in steps.
async function orchestrateAgentWorkflowTools(
  input: VercelAgentWorkflowToolBatchStepInput
): Promise<VercelAgentWorkflowToolBatchStepResult> {
  const prepared = await runAgentWorkflowToolBatchStep({ ...input, preflightOnly: true })
  const batch = await orchestrateWorkflowToolBatch<
    unknown,
    VercelAgentWorkflowToolBatchStepResult,
    VercelAgentWorkflowToolBatchStepResult
  >({
    calls: input.calls,
    concurrency: workflowToolConcurrency,
    preflight: async () =>
      prepared.awaitingInput !== undefined || prepared.failure !== undefined
        ? { ready: false as const, value: prepared }
        : { ready: true as const },
    execute: async (call, index) => {
      // Index namespace avoids shared event counters under parallel Workflow steps.
      const single = {
        ...input,
        calls: [call],
        createdMessages: [],
        usage: undefined,
        eventSequence: 0,
        eventNamespace: `${input.turn ?? 0}:${index}`
      }
      const eligible = await executableWorkflowCallStep(call, prepared.executableIds ?? [])
      if (!eligible) return await runAgentWorkflowToolBatchStep(single)
      const plan = await planWorkflowCallStep({
        context: input.context,
        request: input.request,
        call
      })
      if (plan.type === 'normal') return await runAgentWorkflowToolBatchStep(single)
      if (plan.type === 'result')
        return await runAgentWorkflowToolBatchStep({ ...single, result: plan.result })
      const lifecycle = await startWorkflowChildToolStep({
        ...single,
        call,
        childModel: plan.type === 'launch' ? plan.model : null
      })
      const completion = {
        ...single,
        eventSequence: lifecycle.eventSequence,
        executionStartedAtMs: lifecycle.startedAtMs
      }
      let result: unknown
      try {
        let attemptedRunId: string | undefined
        if (plan.type === 'launch' && plan.workflowRunId === null) {
          try {
            const attempt = await start(runChildAgentWorkflow, [plan.child])
            attemptedRunId = attempt.runId
            await attachChildWorkflowStep(plan.child, attempt.runId)
          } catch (error) {
            await uncertainChildLaunchStep(plan.child)
            throw error
          }
        }
        const child = await awaitWorkflowChild<ChildRead>({
          read: async () => {
            const value = await readChildWorkflowStep(plan.child, attemptedRunId)
            const wait = plan.type === 'lookup' ? plan.wait : !plan.background
            return value.done || (!wait && (plan.type === 'lookup' || value.workflowRunId !== null))
              ? { done: true as const, value }
              : { done: false as const }
          },
          sleep: async () => {
            await sleep('1s')
          }
        })
        result = await childToolResultStep({
          callId: eligible,
          child,
          lookup: plan.type === 'lookup',
          background: plan.type === 'launch' && plan.background,
          parentRunId: plan.child.parentRunId
        })
      } catch {
        // Isolate transport/launch failure here, not inside the child execution boundary.
        result = await childControlFailureStep(eligible)
      }
      return await runAgentWorkflowToolBatchStep({ ...completion, result })
    }
  })
  return batch.ready
    ? await mergeWorkflowToolResultsStep(input, batch.results, batch.failures?.[0]?.error)
    : batch.value
}

export async function runChildAgentWorkflow(input: ChildLaunch) {
  'use workflow'

  const admitted = await admitChildWorkflowStep(input)
  if (admitted === null) return { status: 'not-admitted' } as const
  const terminal = await runVercelAgentWorkflow({
    input: admitted,
    maxTurns: maxChildWorkflowTurns,
    runModelStep: runAgentWorkflowModelStep,
    runToolBatchStep: runAgentWorkflowToolBatchStep,
    closeStream: closeAgentWorkflowStream,
    writeError: writeWorkflowErrorStep
  })
  const outcome = await persistChildTerminalStep(input, {
    status: terminal._tag === 'Completed' ? 'completed' : 'error',
    state: terminal.state
  })
  // The isolated child boundary stays visibly failed (including defects), even when the
  // parent observes a sanitized failed ToolResult. Never mask child defects globally.
  if (terminal._tag !== 'Completed') throw new Error('Child workflow failed')
  return outcome
}

export async function runAgentWorkflow(input: AgentWorkflowInput) {
  'use workflow'

  await registerWorkflowStep(input.userId)
  return await runVercelAgentWorkflow({
    input: { request: input.request, context: { userId: input.userId } },
    runModelStep: runAgentWorkflowModelStep,
    runToolBatchStep: orchestrateAgentWorkflowTools,
    closeStream: closeAgentWorkflowStream,
    writeError: writeWorkflowErrorStep,
    awaitInput: async awaitingInput => {
      using hook = createHook<unknown>({ token: awaitingInput.hookToken })
      return await hook
    }
  })
}
