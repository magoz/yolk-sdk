export type WorkflowReadableOptions = {
  readonly startIndex?: number
}

export type WorkflowReadableStream = ReadableStream<Uint8Array> & {
  readonly getTailIndex?: () => Promise<number>
}

export type WorkflowReadableRun = {
  readonly runId: string
  readonly getReadable: (options?: WorkflowReadableOptions) => WorkflowReadableStream
}

type WorkflowNdjsonHeaders = {
  'cache-control': string
  'content-type': string
  'x-content-type-options': string
  'x-workflow-run-id': string
  'x-workflow-stream-tail-index'?: string
}

export const workflowNdjsonHeaders = (runId: string, tailIndex?: number) => {
  const headers: WorkflowNdjsonHeaders = {
    'cache-control': 'no-cache, no-transform',
    'content-type': 'application/x-ndjson; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'x-workflow-run-id': runId
  }

  if (tailIndex !== undefined) {
    headers['x-workflow-stream-tail-index'] = String(tailIndex)
  }

  return headers
}

export const workflowReadableResponse = (
  runId: string,
  readable: ReadableStream<Uint8Array>,
  tailIndex?: number
) =>
  new Response(readable, {
    status: 200,
    headers: workflowNdjsonHeaders(runId, tailIndex)
  })

export const workflowStreamResponse = (
  run: WorkflowReadableRun,
  options?: WorkflowReadableOptions & { readonly tailIndex?: number }
) => {
  const readableOptions =
    options?.startIndex === undefined ? undefined : { startIndex: options.startIndex }

  return workflowReadableResponse(run.runId, run.getReadable(readableOptions), options?.tailIndex)
}
