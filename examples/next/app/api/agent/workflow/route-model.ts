export type WorkflowReadableRun = {
  readonly runId: string
  readonly getReadable: () => ReadableStream<Uint8Array>
}

export const workflowNdjsonHeaders = (runId: string) => ({
  'cache-control': 'no-cache, no-transform',
  'content-type': 'application/x-ndjson; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'x-workflow-run-id': runId
})

export const workflowStreamResponse = (run: WorkflowReadableRun) =>
  new Response(run.getReadable(), {
    status: 200,
    headers: workflowNdjsonHeaders(run.runId)
  })
