import { workflowStreamResponse, type WorkflowReadableOptions, type WorkflowReadableRun } from '../route-model'

export type WorkflowCancelableRun = WorkflowReadableRun & {
  readonly cancel: () => Promise<void>
}

export type WorkflowRunResolver = (runId: string) => WorkflowCancelableRun

export const workflowResumeResponse = (
  runId: string,
  getRun: WorkflowRunResolver,
  options?: WorkflowReadableOptions & { readonly tailIndex?: number }
) => workflowStreamResponse(getRun(runId), options)

export const workflowCancelResponse = async (runId: string, getRun: WorkflowRunResolver) => {
  await getRun(runId).cancel()

  return Response.json({ ok: true })
}
