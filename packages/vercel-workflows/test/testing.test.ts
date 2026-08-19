import { describe, expect, it } from 'vitest'
import {
  defaultTestWorkflowStepMaxRetries,
  TestWorkflowHookConflictError,
  TestWorkflowHookNotFoundError,
  TestWorkflowRunConflictError,
  TestWorkflowStreamConflictError,
  TestWorkflowWorld,
  testWorkflowModule
} from '../src/testing/index.ts'

const collect = async <T>(stream: ReadableStream<T>, count: number): Promise<Array<T>> => {
  const reader = stream.getReader()
  const chunks: Array<T> = []

  try {
    while (chunks.length < count) {
      const result = await reader.read()
      if (result.done) break
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }

  return chunks
}

const drain = async <T>(stream: ReadableStream<T>): Promise<Array<T>> => {
  const reader = stream.getReader()
  const chunks: Array<T> = []

  for (;;) {
    const result = await reader.read()
    if (result.done) return chunks
    chunks.push(result.value)
  }
}

describe('TestWorkflowWorld run lifecycle', () => {
  it('runs pending -> running -> completed and records the return value', async () => {
    const world = new TestWorkflowWorld()
    const { runId } = world.start(async (value: number) => value * 2, [21])

    expect(world.status(runId)).toBe('pending')
    await world.settled(runId)
    expect(world.status(runId)).toBe('completed')

    const run = world.sdk.getRun<number>(runId)
    await expect(run.returnValue).resolves.toBe(42)
  })

  it('marks a rejecting workflow as failed and keeps the error', async () => {
    const world = new TestWorkflowWorld()
    const boom = new Error('boom')
    const { runId } = world.start(async () => {
      throw boom
    }, [])

    await world.settled(runId)
    expect(world.status(runId)).toBe('failed')
    expect(world.inspect(runId).runError).toBe(boom)
  })

  it('cancel rejects hooks, ends streams, and refuses terminal runs', async () => {
    const world = new TestWorkflowWorld()
    let hookError: unknown
    const { runId } = world.start(async () => {
      using hook = TestWorkflowWorld.createHook({ token: 'hook-1' })

      try {
        await hook
      } catch (error) {
        hookError = error
        throw error
      }
    }, [])

    await new Promise(resolve => setTimeout(resolve, 0))
    await world.cancel(runId)
    await world.settled(runId)

    expect(world.status(runId)).toBe('cancelled')
    expect(hookError).toBeInstanceOf(Error)
    await expect(world.cancel(runId)).rejects.toBeInstanceOf(TestWorkflowRunConflictError)
    // A cancelled run's streams end for readers.
    await expect(drain(world.getReadable(runId))).resolves.toEqual([])
  })
})

describe('TestWorkflowWorld durable streams', () => {
  const startStreamingRun = (world: TestWorkflowWorld) =>
    world.start(async () => {
      const writer = TestWorkflowWorld.getWritable<string>().getWriter()
      await writer.write('a')
      await writer.write('b')
      writer.releaseLock()
    }, [])

  it('replays chunks from startIndex and follows live writes until close', async () => {
    const world = new TestWorkflowWorld()
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const { runId } = world.start(async () => {
      const writer = TestWorkflowWorld.getWritable<string>().getWriter()
      await writer.write('a')
      await writer.write('b')
      await gate
      await writer.write('c')
      await writer.close()
    }, [])

    const early = world.getReadable<string>(runId, { startIndex: 1 })
    const earlyFirst = await collect(early, 1)
    expect(earlyFirst).toEqual(['b'])

    release()
    await world.settled(runId)

    expect(await drain(world.getReadable(runId))).toEqual(['a', 'b', 'c'])
    expect(await drain(world.getReadable(runId, { startIndex: 2 }))).toEqual(['c'])
    expect(await drain(world.getReadable(runId, { startIndex: -1 }))).toEqual(['c'])
    expect(await world.getReadable(runId).getTailIndex()).toBe(2)
  })

  it('reports tail index -1 for an empty stream', async () => {
    const world = new TestWorkflowWorld()
    const { runId } = startStreamingRun(world)

    expect(await world.getReadable(runId).getTailIndex()).toBe(-1)
    await world.settled(runId)
    expect(await world.getReadable(runId).getTailIndex()).toBe(1)
  })

  // The permanent write-after-close guard: this single behavior is what would
  // have caught the #252 production bug (a step failure handler closed the
  // durable stream, so every platform retry hit HTTP 409 "already completed").
  it('rejects writes after close with the platform 409 conflict shape', async () => {
    const world = new TestWorkflowWorld()
    let writeError: unknown
    const { runId } = world.start(async () => {
      const writable = TestWorkflowWorld.getWritable<string>()
      const writer = writable.getWriter()
      await writer.write('before-close')
      await writer.close()

      const late = TestWorkflowWorld.getWritable<string>().getWriter()
      try {
        await late.write('after-close')
      } catch (error) {
        writeError = error
        throw error
      }
    }, [])

    await world.settled(runId)

    expect(writeError).toBeInstanceOf(TestWorkflowStreamConflictError)
    expect(writeError).toMatchObject({ name: 'EntityConflictError', status: 409 })
    expect(String(writeError)).toContain('already completed')
    expect(world.inspect(runId).writeAfterCloseAttempts).toBe(1)
    expect(world.inspect(runId).streamCloseCount).toBe(1)
  })

  it('rejects a second close with the same conflict shape', async () => {
    const world = new TestWorkflowWorld()
    let closeError: unknown
    const { runId } = world.start(async () => {
      const first = TestWorkflowWorld.getWritable<string>().getWriter()
      await first.close()

      const second = TestWorkflowWorld.getWritable<string>().getWriter()
      try {
        await second.close()
      } catch (error) {
        closeError = error
      }
    }, [])

    await world.settled(runId)

    expect(closeError).toBeInstanceOf(TestWorkflowStreamConflictError)
    expect(world.inspect(runId).streamCloseCount).toBe(2)
  })
})

describe('TestWorkflowWorld step executor', () => {
  it('honors fn.maxRetries and exposes 1-based attempt metadata', async () => {
    const world = new TestWorkflowWorld()
    const attempts: Array<number> = []
    const step = Object.assign(
      async () => {
        attempts.push(TestWorkflowWorld.getStepMetadata().attempt)
        if (attempts.length < 3) throw new Error('transient')

        return 'ok'
      },
      { maxRetries: 2 }
    )

    const { runId } = world.start(async () => world.runStep(step, [], 'flaky'), [])
    await world.settled(runId)

    expect(world.status(runId)).toBe('completed')
    expect(attempts).toEqual([1, 2, 3])
    expect(world.inspect(runId).stepAttempts.get('flaky')).toBe(3)
  })

  it('exhausts the retry budget and rethrows the final error', async () => {
    const world = new TestWorkflowWorld()
    const failure = new Error('permanent')
    const step = Object.assign(
      async (): Promise<never> => {
        throw failure
      },
      { maxRetries: 1 }
    )

    const { runId } = world.start(async () => world.runStep(step, [], 'doomed'), [])
    await world.settled(runId)

    expect(world.status(runId)).toBe('failed')
    expect(world.inspect(runId).runError).toBe(failure)
    expect(world.inspect(runId).stepAttempts.get('doomed')).toBe(2)
  })

  it('defaults to the platform retry budget when maxRetries is unset', async () => {
    const world = new TestWorkflowWorld()
    const step = async (): Promise<never> => {
      throw new Error('always')
    }

    const { runId } = world.start(async () => world.runStep(step, [], 'default'), [])
    await world.settled(runId)

    expect(world.inspect(runId).stepAttempts.get('default')).toBe(
      defaultTestWorkflowStepMaxRetries + 1
    )
  })

  it('getStepMetadata outside a step context throws', async () => {
    const world = new TestWorkflowWorld()
    let metadataError: unknown
    const { runId } = world.start(async () => {
      try {
        TestWorkflowWorld.getStepMetadata()
      } catch (error) {
        metadataError = error
      }
    }, [])

    await world.settled(runId)
    expect(metadataError).toBeInstanceOf(Error)
  })
})

describe('TestWorkflowWorld hooks', () => {
  it('resumes a registered hook exactly once', async () => {
    const world = new TestWorkflowWorld()
    let received: unknown
    const { runId } = world.start(async () => {
      using hook = TestWorkflowWorld.createHook<{ readonly answer: number }>({ token: 'hook-a' })

      received = await hook
    }, [])

    await new Promise(resolve => setTimeout(resolve, 0))
    await world.resumeHook('hook-a', { answer: 42 })
    await world.settled(runId)

    expect(received).toEqual({ answer: 42 })
    expect(world.hasResumedHook('hook-a')).toBe(true)
    await expect(world.resumeHook('hook-a', {})).rejects.toBeInstanceOf(
      TestWorkflowHookConflictError
    )
  })

  it('fails resuming an unknown hook token', async () => {
    const world = new TestWorkflowWorld()

    await expect(world.resumeHook('missing', {})).rejects.toBeInstanceOf(
      TestWorkflowHookNotFoundError
    )
  })
})

describe('testWorkflowModule ambient surface', () => {
  it('exposes workflow metadata inside a run', async () => {
    const world = new TestWorkflowWorld()
    let observedRunId: string | undefined
    const { runId } = world.start(async () => {
      observedRunId = testWorkflowModule.getWorkflowMetadata().workflowRunId
    }, [])

    await world.settled(runId)
    expect(observedRunId).toBe(runId)
  })

  it('throws outside any run context', () => {
    expect(() => testWorkflowModule.getWorkflowMetadata()).toThrow(
      'outside a TestWorkflowWorld run context'
    )
  })
})
