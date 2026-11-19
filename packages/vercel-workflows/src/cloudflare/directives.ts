import { Predicate } from 'effect'
import { stepStorage, workflowStorage } from './context.ts'
import { defaultStepMaxRetries } from './execution.ts'
import { registerWorkflow, type WorkflowFunction } from './registry.ts'

// What the directive transform (`./vite.ts`) compiles `'use step'` and `'use workflow'`
// functions into.

const maxRetriesOf = (step: object) => {
  const configured = Predicate.hasProperty(step, 'maxRetries') ? step.maxRetries : undefined

  return Predicate.isNumber(configured) && Number.isFinite(configured)
    ? Math.max(0, Math.floor(configured))
    : defaultStepMaxRetries
}

/**
 * A `'use step'` function's call. Inside a workflow body it is a durable step; inside another step,
 * or outside any workflow, it runs inline, as on the platform.
 */
export const workflowStep = (
  step: object,
  id: string,
  body: () => Promise<unknown>
): Promise<unknown> => {
  const workflow = workflowStorage.getStore()

  if (workflow === undefined || stepStorage.getStore() !== undefined) return body()

  return workflow.step(id, maxRetriesOf(step), body)
}

export const workflowEntry = (workflow: WorkflowFunction, id: string): void => {
  registerWorkflow(workflow, id)
}
