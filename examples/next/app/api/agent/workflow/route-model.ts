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

export const workflowNdjsonHeaders = (runId: string, tailIndex?: number) => ({
  'cache-control': 'no-cache, no-transform',
  'content-type': 'application/x-ndjson; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'x-workflow-run-id': runId,
  ...(tailIndex === undefined ? {} : { 'x-workflow-stream-tail-index': String(tailIndex) })
})

export const workflowReadableTailIndex = (readable: WorkflowReadableStream) =>
  typeof readable.getTailIndex === 'function'
    ? readable.getTailIndex()
    : Promise.resolve<number | undefined>(undefined)

export const workflowStreamResponse = (
  run: WorkflowReadableRun,
  options?: WorkflowReadableOptions & { readonly tailIndex?: number }
) => {
  const readableOptions = options?.startIndex === undefined ? undefined : { startIndex: options.startIndex }

  return new Response(run.getReadable(readableOptions), {
    status: 200,
    headers: workflowNdjsonHeaders(run.runId, options?.tailIndex)
  })
}
