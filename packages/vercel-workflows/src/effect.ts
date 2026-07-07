import { Context, Data, Effect, Layer } from 'effect'
import {
  getRun as workflowGetRun,
  resumeHook as workflowResumeHook,
  start as workflowStart,
  type WorkflowReadableStream,
  type WorkflowReadableStreamOptions,
  type WorkflowRun
} from 'workflow/api'

export type VercelWorkflowsOperation =
  | 'start'
  | 'getRun'
  | 'getReadable'
  | 'tailIndex'
  | 'resumeHook'
  | 'cancel'
  | 'status'
  | 'returnValue'

export class VercelWorkflowsError extends Data.TaggedError('VercelWorkflowsError')<{
  readonly operation: VercelWorkflowsOperation
  readonly message: string
  readonly cause: unknown
}> {}

export type VercelWorkflowFunction<TArgs extends unknown[], TResult> = (
  ...args: TArgs
) => Promise<TResult>

export type VercelWorkflowReadableOptions = WorkflowReadableStreamOptions
export type VercelWorkflowReadableStream<Chunk> = WorkflowReadableStream<Chunk>
export type VercelWorkflowRunStatus = WorkflowRun['status']

export type VercelWorkflowsSdkRun<TResult> = {
  readonly runId: string
  readonly getReadable: <Chunk>(
    options?: VercelWorkflowReadableOptions
  ) => VercelWorkflowReadableStream<Chunk>
  readonly cancel: () => Promise<void>
  readonly status: Promise<VercelWorkflowRunStatus>
  readonly returnValue: Promise<TResult>
}

export type VercelWorkflowsSdkClient = {
  readonly start: <TArgs extends unknown[], TResult>(
    workflow: VercelWorkflowFunction<TArgs, TResult>,
    args: TArgs
  ) => Promise<VercelWorkflowsSdkRun<TResult>>
  readonly getRun: <TResult>(runId: string) => VercelWorkflowsSdkRun<TResult>
  readonly resumeHook: (token: string, payload: unknown) => Promise<void>
}

export type VercelWorkflowRun<TResult> = {
  readonly runId: string
  readonly getReadable: <Chunk>(
    options?: VercelWorkflowReadableOptions
  ) => Effect.Effect<VercelWorkflowReadableStream<Chunk>, VercelWorkflowsError>
  readonly cancel: Effect.Effect<void, VercelWorkflowsError>
  readonly status: Effect.Effect<VercelWorkflowRunStatus, VercelWorkflowsError>
  readonly returnValue: Effect.Effect<TResult, VercelWorkflowsError>
}

export type VercelWorkflowsClient = {
  readonly start: <TArgs extends unknown[], TResult>(
    workflow: VercelWorkflowFunction<TArgs, TResult>,
    args: TArgs
  ) => Effect.Effect<VercelWorkflowRun<TResult>, VercelWorkflowsError>
  readonly getRun: <TResult>(
    runId: string
  ) => Effect.Effect<VercelWorkflowRun<TResult>, VercelWorkflowsError>
  readonly getReadable: <Chunk>(
    runId: string,
    options?: VercelWorkflowReadableOptions
  ) => Effect.Effect<VercelWorkflowReadableStream<Chunk>, VercelWorkflowsError>
  readonly tailIndex: (runId: string) => Effect.Effect<number, VercelWorkflowsError>
  readonly resumeHook: (
    token: string,
    payload: unknown
  ) => Effect.Effect<void, VercelWorkflowsError>
  readonly cancel: (runId: string) => Effect.Effect<void, VercelWorkflowsError>
}

export class VercelWorkflowsSdk extends Context.Service<
  VercelWorkflowsSdk,
  VercelWorkflowsSdkClient
>()('@yolk-sdk/vercel-workflows/VercelWorkflowsSdk') {}

const workflowsError = (operation: VercelWorkflowsOperation, cause: unknown) =>
  new VercelWorkflowsError({
    operation,
    message: `Vercel Workflow ${operation} failed`,
    cause
  })

const spanAttributes = (runId: string) => ({ 'workflow.run.id': runId })

const trySdkPromise = <A>(body: () => Promise<A>) =>
  Effect.tryPromise({
    try: body,
    catch: error => error
  })

const mapSdkError = (operation: VercelWorkflowsOperation) =>
  <A>(effect: Effect.Effect<A, unknown>) =>
    effect.pipe(Effect.mapError(cause => workflowsError(operation, cause)))

const makeWorkflowRun = <TResult>(
  run: VercelWorkflowsSdkRun<TResult>
): VercelWorkflowRun<TResult> => ({
  runId: run.runId,
  getReadable: <Chunk>(options?: VercelWorkflowReadableOptions) =>
    Effect.try({
      try: () => run.getReadable<Chunk>(options),
      catch: cause => workflowsError('getReadable', cause)
    }).pipe(
      Effect.withSpan('VercelWorkflows.run.getReadable', {
        attributes: spanAttributes(run.runId)
      })
    ),
  cancel: trySdkPromise(() => run.cancel()).pipe(
    mapSdkError('cancel'),
    Effect.withSpan('VercelWorkflows.run.cancel', {
      attributes: spanAttributes(run.runId)
    })
  ),
  status: trySdkPromise(() => run.status).pipe(
    mapSdkError('status'),
    Effect.withSpan('VercelWorkflows.run.status', {
      attributes: spanAttributes(run.runId)
    })
  ),
  returnValue: trySdkPromise(() => run.returnValue).pipe(
    mapSdkError('returnValue'),
    Effect.withSpan('VercelWorkflows.run.returnValue', {
      attributes: spanAttributes(run.runId)
    })
  )
})

const VercelWorkflowsSdkLive = Layer.succeed(VercelWorkflowsSdk, {
  start: <TArgs extends unknown[], TResult>(
    workflow: VercelWorkflowFunction<TArgs, TResult>,
    args: TArgs
  ) => workflowStart(workflow, args),
  getRun: <TResult>(runId: string) => workflowGetRun<TResult>(runId),
  resumeHook: async (token: string, payload: unknown) => {
    await workflowResumeHook<unknown>(token, payload)
  }
})

export class VercelWorkflows extends Context.Service<VercelWorkflows, VercelWorkflowsClient>()(
  '@yolk-sdk/vercel-workflows/VercelWorkflows',
  {
    make: Effect.gen(function* () {
      const sdk = yield* VercelWorkflowsSdk

      const getRun = <TResult>(
        runId: string
      ): Effect.Effect<VercelWorkflowRun<TResult>, VercelWorkflowsError> =>
        Effect.try({
          try: () => sdk.getRun<TResult>(runId),
          catch: error => error
        }).pipe(
          mapSdkError('getRun'),
          Effect.map(makeWorkflowRun),
          Effect.withSpan('VercelWorkflows.getRun', {
            attributes: spanAttributes(runId)
          })
        )

      return {
        start: <TArgs extends unknown[], TResult>(
          workflow: VercelWorkflowFunction<TArgs, TResult>,
          args: TArgs
        ): Effect.Effect<VercelWorkflowRun<TResult>, VercelWorkflowsError> =>
          trySdkPromise(() => sdk.start(workflow, args)).pipe(
            mapSdkError('start'),
            Effect.map(makeWorkflowRun),
            Effect.withSpan('VercelWorkflows.start')
          ),

        getRun,

        getReadable: <Chunk>(
          runId: string,
          options?: VercelWorkflowReadableOptions
        ): Effect.Effect<VercelWorkflowReadableStream<Chunk>, VercelWorkflowsError> =>
          getRun<unknown>(runId).pipe(
            Effect.flatMap(run => run.getReadable<Chunk>(options)),
            Effect.withSpan('VercelWorkflows.getReadable', {
              attributes: spanAttributes(runId)
            })
          ),

        tailIndex: (runId: string): Effect.Effect<number, VercelWorkflowsError> =>
          getRun<unknown>(runId).pipe(
            Effect.flatMap(run => run.getReadable<unknown>({ startIndex: -1 })),
            Effect.flatMap(readable =>
              Effect.tryPromise({
                try: () => readable.getTailIndex(),
                catch: cause => workflowsError('tailIndex', cause)
              })
            ),
            Effect.withSpan('VercelWorkflows.tailIndex', {
              attributes: spanAttributes(runId)
            })
          ),

        resumeHook: (token: string, payload: unknown): Effect.Effect<void, VercelWorkflowsError> =>
          trySdkPromise(() => sdk.resumeHook(token, payload)).pipe(
            mapSdkError('resumeHook'),
            Effect.withSpan('VercelWorkflows.resumeHook')
          ),

        cancel: (runId: string): Effect.Effect<void, VercelWorkflowsError> =>
          getRun<unknown>(runId).pipe(
            Effect.flatMap(run => run.cancel),
            Effect.withSpan('VercelWorkflows.cancel', {
              attributes: spanAttributes(runId)
            })
          )
      }
    })
  }
) {
  static layer = Layer.effect(this, this.make).pipe(Layer.provide(VercelWorkflowsSdkLive))
  static layerFromSdk = Layer.effect(this, this.make)
}
