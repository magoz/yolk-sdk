import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  VercelWorkflows,
  VercelWorkflowsSdk,
  type VercelWorkflowFunction,
  type VercelWorkflowReadableOptions,
  type VercelWorkflowRunStatus,
  type VercelWorkflowsSdkClient,
  type VercelWorkflowsSdkRun
} from '../src/effect.ts'

class FakeWorkflowReadableStream<Chunk> extends ReadableStream<Chunk> {
  constructor(private readonly tailIndex: number) {
    super({
      start(controller) {
        controller.close()
      }
    })
  }

  getTailIndex(): Promise<number> {
    return Promise.resolve(this.tailIndex)
  }
}

type RecordedRead = {
  readonly runId: string
  readonly options: VercelWorkflowReadableOptions | undefined
}

class FakeSdkRun<TResult> implements VercelWorkflowsSdkRun<TResult> {
  readonly status: Promise<VercelWorkflowRunStatus>

  constructor(
    readonly runId: string,
    readonly returnValue: Promise<TResult>,
    status: VercelWorkflowRunStatus,
    private readonly tailIndex: number,
    private readonly recordRead: (read: RecordedRead) => void,
    private readonly recordCancel: (runId: string) => void
  ) {
    this.status = Promise.resolve(status)
  }

  getReadable<Chunk>(options?: VercelWorkflowReadableOptions) {
    this.recordRead({ runId: this.runId, options })

    return new FakeWorkflowReadableStream<Chunk>(this.tailIndex)
  }

  readonly cancel = async () => {
    this.recordCancel(this.runId)
  }
}

class RecordingWorkflowSdk implements VercelWorkflowsSdkClient {
  readonly startedArgs: Array<ReadonlyArray<unknown>> = []
  readonly reads: Array<RecordedRead> = []
  readonly cancelledRunIds: Array<string> = []
  readonly resumedHooks: Array<{ readonly token: string; readonly payload: unknown }> = []

  start<TArgs extends unknown[], TResult>(
    workflow: VercelWorkflowFunction<TArgs, TResult>,
    args: TArgs
  ) {
    this.startedArgs.push(args)
    const runId = `wrun_${this.startedArgs.length}`
    const run = new FakeSdkRun(
      runId,
      workflow(...args),
      'completed',
      3,
      read => this.reads.push(read),
      cancelledRunId => this.cancelledRunIds.push(cancelledRunId)
    )

    return Promise.resolve(run)
  }

  getRun<TResult>(runId: string) {
    return new FakeSdkRun<TResult>(
      runId,
      new Promise<TResult>(() => {}),
      'running',
      3,
      read => this.reads.push(read),
      cancelledRunId => this.cancelledRunIds.push(cancelledRunId)
    )
  }

  async resumeHook(token: string, payload: unknown) {
    this.resumedHooks.push({ token, payload })
  }
}

const runWithSdk = <A, E>(
  effect: Effect.Effect<A, E, VercelWorkflows>,
  sdk: VercelWorkflowsSdkClient
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(VercelWorkflows.layerFromSdk),
      Effect.provide(Layer.succeed(VercelWorkflowsSdk, sdk))
    )
  )

describe('VercelWorkflows', () => {
  it('starts workflows and exposes run status/value as effects', async () => {
    const sdk = new RecordingWorkflowSdk()
    const result = await runWithSdk(
      Effect.gen(function* () {
        const workflows = yield* VercelWorkflows
        const run = yield* workflows.start(
          async (input: { readonly id: string }) => `done:${input.id}`,
          [{ id: 'request-1' }]
        )
        const status = yield* run.status
        const returnValue = yield* run.returnValue

        return { runId: run.runId, status, returnValue }
      }),
      sdk
    )

    expect(result).toEqual({ runId: 'wrun_1', status: 'completed', returnValue: 'done:request-1' })
    expect(sdk.startedArgs).toEqual([[{ id: 'request-1' }]])
  })

  it('reads streams by run id and resolves tail index', async () => {
    const sdk = new RecordingWorkflowSdk()
    const result = await runWithSdk(
      Effect.gen(function* () {
        const workflows = yield* VercelWorkflows
        yield* workflows.getReadable<string>('wrun_existing', { startIndex: 2 })

        return yield* workflows.tailIndex('wrun_existing')
      }),
      sdk
    )

    expect(result).toBe(3)
    expect(sdk.reads).toEqual([
      { runId: 'wrun_existing', options: { startIndex: 2 } },
      { runId: 'wrun_existing', options: { startIndex: -1 } }
    ])
  })

  it('resumes hooks and cancels runs', async () => {
    const sdk = new RecordingWorkflowSdk()
    await runWithSdk(
      Effect.gen(function* () {
        const workflows = yield* VercelWorkflows
        yield* workflows.resumeHook('hook-token', { approved: true })
        yield* workflows.cancel('wrun_cancel')
      }),
      sdk
    )

    expect(sdk.resumedHooks).toEqual([{ token: 'hook-token', payload: { approved: true } }])
    expect(sdk.cancelledRunIds).toEqual(['wrun_cancel'])
  })

  it('maps SDK failures to tagged errors', async () => {
    const failure = new Error('workflow boom')
    const sdk = {
      start: <TArgs extends unknown[], TResult>(
        _workflow: VercelWorkflowFunction<TArgs, TResult>,
        _args: TArgs
      ) => Promise.reject(failure),
      getRun: <TResult>(_runId: string): VercelWorkflowsSdkRun<TResult> => {
        throw failure
      },
      resumeHook: (_token: string, _payload: unknown) => Promise.reject(failure)
    } satisfies VercelWorkflowsSdkClient

    await expect(
      runWithSdk(
        Effect.gen(function* () {
          const workflows = yield* VercelWorkflows

          return yield* workflows.start(async () => 'ok', [])
        }),
        sdk
      )
    ).rejects.toMatchObject({ _tag: 'VercelWorkflowsError', operation: 'start' })

    await expect(
      runWithSdk(
        Effect.gen(function* () {
          const workflows = yield* VercelWorkflows

          return yield* workflows.getReadable<string>('wrun_missing')
        }),
        sdk
      )
    ).rejects.toMatchObject({ _tag: 'VercelWorkflowsError', operation: 'getRun' })

    await expect(
      runWithSdk(
        Effect.gen(function* () {
          const workflows = yield* VercelWorkflows

          return yield* workflows.resumeHook('hook-token', 'payload')
        }),
        sdk
      )
    ).rejects.toMatchObject({ _tag: 'VercelWorkflowsError', operation: 'resumeHook' })
  })
})
