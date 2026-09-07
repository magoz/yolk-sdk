// Dynamic step imports keep DB, provider and Node-only tooling out of the workflow bundle.
import type * as ChildRuntimeModule from './child-control'

type ChildRuntime = typeof ChildRuntimeModule

export async function registerWorkflowStep(
  ...args: Parameters<ChildRuntime['registerWorkflowStep']>
): ReturnType<ChildRuntime['registerWorkflowStep']> {
  'use step'
  const runtime = await import('./child-control')
  return await runtime.registerWorkflowStep(...args)
}

export async function planWorkflowCallStep(
  ...args: Parameters<ChildRuntime['planWorkflowCallStep']>
): ReturnType<ChildRuntime['planWorkflowCallStep']> {
  'use step'
  const runtime = await import('./child-control')
  return await runtime.planWorkflowCallStep(...args)
}
planWorkflowCallStep.maxRetries = 0

export async function admitChildWorkflowStep(
  ...args: Parameters<ChildRuntime['admitChildWorkflowStep']>
): ReturnType<ChildRuntime['admitChildWorkflowStep']> {
  'use step'
  const runtime = await import('./child-control')
  return await runtime.admitChildWorkflowStep(...args)
}

export async function persistChildTerminalStep(
  ...args: Parameters<ChildRuntime['persistChildTerminalStep']>
): ReturnType<ChildRuntime['persistChildTerminalStep']> {
  'use step'
  const runtime = await import('./child-control')
  return await runtime.persistChildTerminalStep(...args)
}

export async function readChildWorkflowStep(
  ...args: Parameters<ChildRuntime['readChildWorkflowStep']>
): ReturnType<ChildRuntime['readChildWorkflowStep']> {
  'use step'
  const runtime = await import('./child-control')
  return await runtime.readChildWorkflowStep(...args)
}

export async function attachChildWorkflowStep(
  ...args: Parameters<ChildRuntime['attachChildWorkflowStep']>
): ReturnType<ChildRuntime['attachChildWorkflowStep']> {
  'use step'
  const runtime = await import('./child-control')
  return await runtime.attachChildWorkflowStep(...args)
}

export async function childToolResultStep(
  ...args: Parameters<ChildRuntime['childToolResultStep']>
): ReturnType<ChildRuntime['childToolResultStep']> {
  'use step'
  const runtime = await import('./child-control')
  return await runtime.childToolResultStep(...args)
}

export async function uncertainChildLaunchStep(
  ...args: Parameters<ChildRuntime['uncertainChildLaunchStep']>
): ReturnType<ChildRuntime['uncertainChildLaunchStep']> {
  'use step'
  const runtime = await import('./child-control')
  return await runtime.uncertainChildLaunchStep(...args)
}

export async function childControlFailureStep(
  ...args: Parameters<ChildRuntime['childControlFailureStep']>
): ReturnType<ChildRuntime['childControlFailureStep']> {
  'use step'
  const runtime = await import('./child-control')
  return await runtime.childControlFailureStep(...args)
}
