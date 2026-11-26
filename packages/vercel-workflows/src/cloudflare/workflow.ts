import { stepStorage, workflowStorage } from './context.ts'
import { toDurationMs } from './errors.ts'

// The Cloudflare build of the `workflow` package's module-level API (hosts alias `workflow` to this
// module): the same functions, backed by the run executing in its `WorkflowRun` Durable Object
// (`./execution.ts`).

export { FatalError, RetryableError } from './errors.ts'

export const getWorkflowMetadata = () => {
  const step = stepStorage.getStore()

  if (step !== undefined) {
    return {
      workflowRunId: step.runId,
      workflowStartedAt: step.workflowStartedAt,
      url: ''
    }
  }

  const workflow = workflowStorage.getStore()

  if (workflow === undefined) {
    throw new Error('getWorkflowMetadata() can only be called inside a workflow or step')
  }

  return { workflowRunId: workflow.runId, workflowStartedAt: workflow.startedAt, url: '' }
}

export const getStepMetadata = () => {
  const step = stepStorage.getStore()

  if (step === undefined) throw new Error('getStepMetadata() can only be called inside a step')

  return {
    stepId: step.stepId,
    stepStartedAt: step.stepStartedAt,
    attempt: step.attempt
  }
}

/**
 * Not in Vercel's `workflow`: the running step's `AbortSignal`, aborted when its run is cancelled
 * (`run.cancel()`; reason a `WorkflowRunCancelledError`). Pass it to the step's I/O (fetch, model
 * calls) so a cancelled run's step ends instead of running to its end for an outcome that is
 * dropped. Import it from `@yolk-sdk/vercel-workflows/cloudflare/workflow`, since `workflow`'s
 * types do not declare it.
 */
export const getStepSignal = (): AbortSignal => {
  const step = stepStorage.getStore()

  if (step === undefined) throw new Error('getStepSignal() can only be called inside a step')

  return step.signal
}

export const getWritable = (): WritableStream<Uint8Array> => {
  const step = stepStorage.getStore()

  if (step === undefined) throw new Error('getWritable() can only be called inside a step')

  return step.writable()
}

const requireWorkflow = (name: string) => {
  const workflow = workflowStorage.getStore()

  if (workflow === undefined || stepStorage.getStore() !== undefined) {
    throw new Error(`${name}() can only be called inside a workflow function`)
  }

  return workflow
}

export const createHook = (options?: { readonly token?: string }) => {
  const workflow = requireWorkflow('createHook')
  const token = options?.token ?? workflow.hookToken()
  const hook = workflow.hook(token)

  return {
    token,
    then: <A = unknown, B = never>(
      onFulfilled?: ((value: unknown) => A | PromiseLike<A>) | null,
      onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null
    ) => hook.payload.then(onFulfilled, onRejected),
    dispose: hook.dispose,
    [Symbol.dispose]: hook.dispose
  }
}

export const sleep = (duration: number | string | Date): Promise<void> =>
  requireWorkflow('sleep').sleep(toDurationMs(duration))
