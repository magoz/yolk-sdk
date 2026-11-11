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

  it('fails an exhausted step with the platform FatalError, as stored and read back', async () => {
    const world = new TestWorkflowWorld()

    class TaggedFailure extends Error {
      readonly _tag = 'TaggedFailure'
    }

    const step = Object.assign(
      async (): Promise<never> => {
        throw new TaggedFailure('permanent')
      },
      { maxRetries: 1 }
    )

    const { runId } = world.start(async () => world.runStep(step, [], 'doomed'), [])
    await world.settled(runId)

    const { runError, stepAttempts, unstorableStepErrors } = world.inspect(runId)

    expect(world.status(runId)).toBe('failed')
    expect(stepAttempts.get('doomed')).toBe(2)
    expect(unstorableStepErrors).toEqual([])
    expect(runError).toMatchObject({
      name: 'FatalError',
      message: 'Step "doomed" failed after 1 retry: permanent'
    })

    // The body's error survives as the cause, without its class or tag.
    const cause = runError instanceof Error ? runError.cause : undefined

    expect(cause).toBeInstanceOf(Error)
    expect(cause).not.toBeInstanceOf(TaggedFailure)
    expect(cause).toMatchObject({ message: 'permanent' })
    expect(cause).not.toHaveProperty('_tag')
  })

  it('never retries a FatalError', async () => {
    const world = new TestWorkflowWorld()
    const fatal = new Error('configuration refused')

    fatal.name = 'FatalError'

    const step = Object.assign(
      async (): Promise<never> => {
        throw fatal
      },
      { maxRetries: 3 }
    )

    const { runId } = world.start(async () => world.runStep(step, [], 'refused'), [])
    await world.settled(runId)

    expect(world.inspect(runId).stepAttempts.get('refused')).toBe(1)
    expect(world.inspect(runId).runError).toMatchObject({
      name: 'FatalError',
      message: 'configuration refused'
    })
  })

  it('redelivers a step whose error the platform cannot store, until it exceeds its retries', async () => {
    const world = new TestWorkflowWorld()

    // A class instance in the cause chain, like a schema issue: the platform cannot store it.
    class Issue {
      readonly path = ['name']
    }

    const unstorable = new Error('Schema validation failed', { cause: new Issue() })

    const step = Object.assign(
      async (): Promise<never> => {
        throw unstorable
      },
      { maxRetries: 2 }
    )

    const { runId } = world.start(async () => world.runStep(step, [], 'model'), [])
    await world.settled(runId)

    const { runError, stepAttempts, unstorableStepErrors } = world.inspect(runId)

    expect(stepAttempts.get('model')).toBe(3)
    expect(unstorableStepErrors).toEqual([
      { stepName: 'model', attempt: 1, error: unstorable },
      { stepName: 'model', attempt: 2, error: unstorable },
      { stepName: 'model', attempt: 3, error: unstorable }
    ])
    expect(runError).toMatchObject({
      name: 'FatalError',
      message: 'Step "model" exceeded max retries (2 retries)'
    })
    expect(runError).not.toHaveProperty('cause')
  })

  it('fails without a cause when only the final attempt cannot be stored', async () => {
    const world = new TestWorkflowWorld()
    let attempts = 0

    const step = Object.assign(
      async (): Promise<never> => {
        attempts += 1

        if (attempts === 1) throw new Error('transient')

        throw new Error('final', { cause: new (class Issue {})() })
      },
      { maxRetries: 1 }
    )

    const { runId } = world.start(async () => world.runStep(step, [], 'model'), [])
    await world.settled(runId)

    const { runError, unstorableStepErrors } = world.inspect(runId)

    // The platform fails the redelivery past the budget before reading any stored attempt.
    expect(unstorableStepErrors.map(entry => entry.attempt)).toEqual([2])
    expect(runError).toMatchObject({
      name: 'FatalError',
      message: 'Step "model" exceeded max retries (1 retry)'
    })
    expect(runError).not.toHaveProperty('cause')
  })

  it.each([
    ['an error named FatalError', Object.assign(new Error('stop'), { name: 'FatalError' })],
    ['an error with fatal: true', Object.assign(new Error('stop'), { fatal: true })],
    ['a plain FatalError-shaped object', { name: 'FatalError', message: 'stop' }]
  ])('never retries %s', async (_, fatal) => {
    const world = new TestWorkflowWorld()

    const step = Object.assign(
      async (): Promise<never> => {
        throw fatal
      },
      { maxRetries: 3 }
    )

    const { runId } = world.start(async () => world.runStep(step, [], 'refused'), [])
    await world.settled(runId)

    expect(world.inspect(runId).stepAttempts.get('refused')).toBe(1)
    expect(world.inspect(runId).runError).toMatchObject({ message: 'stop' })
  })

  it('promotes an aborted step to a FatalError, like the platform', async () => {
    const world = new TestWorkflowWorld()

    const step = Object.assign(
      async (): Promise<never> => {
        throw new DOMException('signal fired', 'AbortError')
      },
      { maxRetries: 3 }
    )

    const { runId } = world.start(async () => world.runStep(step, [], 'aborted'), [])
    await world.settled(runId)

    expect(world.inspect(runId).stepAttempts.get('aborted')).toBe(1)
    expect(world.inspect(runId).runError).toMatchObject({
      name: 'FatalError',
      message: 'Aborted: signal fired'
    })
  })

  it('names a thrown non-error in the exhausted message as the platform does', async () => {
    const world = new TestWorkflowWorld()

    const step = Object.assign(
      async (): Promise<never> => {
        // oxlint-disable-next-line no-throw-literal -- a thrown plain object is the case under test
        throw { reason: 'failed' }
      },
      { maxRetries: 0 }
    )

    const { runId } = world.start(async () => world.runStep(step, [], 'plain'), [])
    await world.settled(runId)

    expect(world.inspect(runId).runError).toMatchObject({
      name: 'FatalError',
      message: 'Step "plain" failed after 0 retries: {"reason":"failed"}',
      cause: { reason: 'failed' }
    })
  })

  it('retries after an unstorable error like the platform redelivery', async () => {
    const world = new TestWorkflowWorld()
    let attempts = 0

    const step = Object.assign(
      async () => {
        attempts += 1

        if (attempts === 1) throw new Error('crash', { cause: new (class Issue {})() })

        return 'ok'
      },
      { maxRetries: 1 }
    )

    const { runId } = world.start(async () => world.runStep(step, [], 'model'), [])
    await world.settled(runId)

    expect(world.status(runId)).toBe('completed')
    expect(world.inspect(runId).unstorableStepErrors).toHaveLength(1)
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
