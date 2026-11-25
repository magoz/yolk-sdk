import { describe, expect, it } from 'vitest'
import { Result } from 'effect'
import {
  defaultTestWorkflowStepMaxRetries,
  TestWorkflowHookConflictError,
  TestWorkflowHookNotFoundError,
  TestWorkflowRunCancelledError,
  TestWorkflowRunConflictError,
  TestWorkflowStreamConflictError,
  TestWorkflowWorld,
  testWorkflowModule
} from '../src/testing/index.ts'
import {
  runVercelAgentWorkflow,
  type VercelAgentWorkflowLoopConfig,
  type VercelAgentWorkflowModelStepResult,
  type VercelAgentWorkflowRunResult,
  type VercelAgentWorkflowStepRetryPolicy
} from '../src/workflow.ts'

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

  it('records the attributes a run was started with', async () => {
    const world = new TestWorkflowWorld()
    const plain = world.start(async () => 'done', [])

    const tagged = await world.sdk.start(async () => 'done', [], {
      attributes: { sessionId: 'session-1' }
    })

    expect(world.inspect(plain.runId).attributes).toEqual({})
    expect(world.inspect(tagged.runId).attributes).toEqual({ sessionId: 'session-1' })
  })

  it('refuses a start with attributes the platform rejects, before any run exists', async () => {
    const world = new TestWorkflowWorld()

    const start = (attributes: Record<string, string>) =>
      world.sdk.start(async () => 'done', [], { attributes })

    await expect(start({ $reserved: 'x' })).rejects.toMatchObject({ name: 'FatalError' })
    await expect(start({ value: 'x'.repeat(257) })).rejects.toMatchObject({ name: 'FatalError' })

    const accepted = await start({ value: 'x'.repeat(256) })

    expect(accepted.runId).toBe('twr_1')
  })

  it('stores the attributes it validated, not a later change to the caller object', async () => {
    const world = new TestWorkflowWorld()
    const attributes = { sessionId: 'session-1' }
    const started = world.sdk.start(async () => 'done', [], { attributes })

    // Too long for the platform: it would fail validation had it been the value checked.
    attributes.sessionId = 'x'.repeat(257)

    const run = await started

    expect(world.inspect(run.runId).attributes).toEqual({ sessionId: 'session-1' })
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

  // The Vercel world's close is idempotent (`@workflow/world-vercel` `streamer.js` `close`): only
  // writes after close conflict.
  it('accepts a second close like the platform, and still rejects writes after it', async () => {
    const world = new TestWorkflowWorld()
    let writeError: unknown

    const { runId } = world.start(async () => {
      const first = TestWorkflowWorld.getWritable<string>().getWriter()
      await first.write('before-close')
      await first.close()

      const second = TestWorkflowWorld.getWritable<string>().getWriter()
      await second.close()

      const late = TestWorkflowWorld.getWritable<string>().getWriter()

      try {
        await late.write('after-close')
      } catch (error) {
        writeError = error
      }
    }, [])

    await world.settled(runId)

    expect(world.status(runId)).toBe('completed')
    expect(writeError).toBeInstanceOf(TestWorkflowStreamConflictError)
    expect(world.inspect(runId)).toMatchObject({
      chunks: ['before-close'],
      streamClosed: true,
      streamCloseCount: 2,
      writeAfterCloseAttempts: 1
    })
    expect(await drain(world.getReadable(runId))).toEqual(['before-close'])
  })
})

describe('TestWorkflowWorld with runVercelAgentWorkflow close', () => {
  const runClosingWorkflow = (input: {
    readonly world: TestWorkflowWorld
    readonly closeStreamRetry?: VercelAgentWorkflowStepRetryPolicy
  }) => {
    const { world, closeStreamRetry } = input
    let closeExecutions = 0
    let errorStepRan = 0
    let result: VercelAgentWorkflowRunResult | undefined

    const modelStep = Object.assign(
      async (): Promise<VercelAgentWorkflowModelStepResult> => {
        const writer = TestWorkflowWorld.getWritable<string>().getWriter()
        await writer.write('AgentEnd')
        writer.releaseLock()

        return { done: true, messages: [], createdMessages: [], toolCalls: [], usage: {}, turn: 1 }
      },
      { maxRetries: 0 }
    )

    // The platform applies the first execution's close, then the step fails on its last
    // attempt (the function died, or its completion was lost).
    const closeStep = Object.assign(
      async () => {
        closeExecutions += 1
        await TestWorkflowWorld.getWritable<string>().getWriter().close()

        if (closeExecutions === 1) throw new Error('close step completion lost')
      },
      { maxRetries: 0 }
    )

    // A host commits its failure state here before writing AgentError (README "Terminal barriers").
    const errorStep = Object.assign(
      async () => {
        errorStepRan += 1
        const writer = TestWorkflowWorld.getWritable<string>().getWriter()

        try {
          await writer.write('AgentError')
        } finally {
          await writer.close()
        }
      },
      { maxRetries: 0 }
    )

    const config: VercelAgentWorkflowLoopConfig = {
      input: { request: 'request-1', context: 'ctx-1' },
      runModelStep: world.step(modelStep, 'model'),
      runToolBatchStep: () => Promise.reject(new Error('no tools')),
      closeStream: world.step(closeStep, 'close'),
      writeError: world.step(errorStep, 'writeError')
    }

    const { runId } = world.start(async () => {
      result = await runVercelAgentWorkflow(
        closeStreamRetry === undefined ? config : { ...config, closeStreamRetry }
      )
    }, [])

    return {
      runId,
      observed: () => ({ result: result?._tag, closeExecutions, errorStepRan })
    }
  }

  // #303: a retried close step re-closes the stream; Vercel accepts it, so the run completes.
  it('completes when an opted-in close retry re-closes the stream', async () => {
    const world = new TestWorkflowWorld()
    const run = runClosingWorkflow({ world, closeStreamRetry: { maxAttempts: 2 } })
    await world.settled(run.runId)

    expect(run.observed()).toEqual({ result: 'Completed', closeExecutions: 2, errorStepRan: 0 })
    expect(world.inspect(run.runId)).toMatchObject({
      chunks: ['AgentEnd'],
      streamClosed: true,
      streamCloseCount: 2,
      writeAfterCloseAttempts: 0
    })
  })

  // #302: a clean close whose step then failed is retried by default instead of reported as
  // CloseStreamFailed and written as a failure.
  it('retries the close step by default, so a close applied before its step failed completes', async () => {
    const world = new TestWorkflowWorld()
    const run = runClosingWorkflow({ world })
    await world.settled(run.runId)

    expect(run.observed()).toEqual({ result: 'Completed', closeExecutions: 2, errorStepRan: 0 })
    expect(world.inspect(run.runId)).toMatchObject({
      chunks: ['AgentEnd'],
      streamClosed: true,
      writeAfterCloseAttempts: 0
    })
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

  it('keeps retrying an AbortError-shaped value the platform would not promote', async () => {
    const world = new TestWorkflowWorld()
    let attempts = 0

    const step = Object.assign(
      async () => {
        attempts += 1

        // oxlint-disable-next-line no-throw-literal -- a malformed abort shape is the case under test
        if (attempts === 1) throw { name: 'AbortError', message: 'retry', stack: null }

        return 'ok'
      },
      { maxRetries: 1 }
    )

    const { runId } = world.start(async () => world.runStep(step, [], 'shaped'), [])
    await world.settled(runId)

    expect(world.status(runId)).toBe('completed')
    expect(world.inspect(runId).stepAttempts.get('shaped')).toBe(2)
  })

  it('consumes a thrown rejected promise before retrying, like the platform', async () => {
    const world = new TestWorkflowWorld()
    const unhandled: Array<unknown> = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    let attempts = 0

    process.on('unhandledRejection', onUnhandled)

    try {
      const step = Object.assign(
        async () => {
          attempts += 1

          // oxlint-disable-next-line no-throw-literal -- a thrown thenable is the case under test
          if (attempts === 1) throw Promise.reject(new Error('transient'))

          return 'ok'
        },
        { maxRetries: 1 }
      )

      const { runId } = world.start(async () => world.runStep(step, [], 'thenable'), [])
      await world.settled(runId)
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(world.status(runId)).toBe('completed')
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
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

// Workflow 5.8 starts a `maxRetries > 0` step body before its start is recorded; a refused start
// discards the outcome and the body runs again with the same `getStepMetadata()`.
describe('TestWorkflowWorld speculative step execution (discardStepExecution)', () => {
  it('runs the body again with the same stepId and attempt, discarding the first outcome', async () => {
    const world = new TestWorkflowWorld({ discardStepExecution: () => true })
    const seen: Array<{ readonly stepId: string; readonly attempt: number }> = []

    const step = Object.assign(
      async () => {
        const { stepId, attempt } = TestWorkflowWorld.getStepMetadata()
        seen.push({ stepId, attempt })
        const writer = TestWorkflowWorld.getWritable<string>().getWriter()
        await writer.write(`execution ${seen.length}`)
        writer.releaseLock()

        return `answer ${seen.length}`
      },
      { maxRetries: 1 }
    )

    const { runId } = world.start(async () => world.runStep(step, [], 'model'), [])
    await world.settled(runId)

    const [first, second] = seen

    expect(seen).toHaveLength(2)
    expect(second).toEqual(first)
    await expect(world.sdk.getRun<string>(runId).returnValue).resolves.toBe('answer 2')
    expect(world.inspect(runId)).toMatchObject({
      // The discarded execution's stream writes stay, as on the platform.
      chunks: ['execution 1', 'execution 2'],
      stepAttempts: new Map([['model', 1]]),
      discardedStepExecutions: [
        {
          stepName: 'model',
          stepId: first?.stepId,
          attempt: 1,
          outcome: Result.succeed('answer 1')
        }
      ]
    })
  })

  it('neither stores nor retries a discarded execution that threw', async () => {
    const world = new TestWorkflowWorld({ discardStepExecution: () => true })
    const fatal = Object.assign(new Error('stop'), { name: 'FatalError' })
    let executions = 0

    const step = Object.assign(
      async () => {
        executions += 1

        if (executions === 1) throw fatal

        return 'ok'
      },
      { maxRetries: 1 }
    )

    const { runId } = world.start(async () => world.runStep(step, [], 'model'), [])
    await world.settled(runId)

    expect(world.status(runId)).toBe('completed')
    expect(world.inspect(runId)).toMatchObject({
      stepAttempts: new Map([['model', 1]]),
      unstorableStepErrors: [],
      discardedStepExecutions: [{ attempt: 1, outcome: Result.fail(fatal) }]
    })
  })

  it('never re-executes a step with maxRetries: 0', async () => {
    const asked: Array<string> = []

    const world = new TestWorkflowWorld({
      discardStepExecution: ({ stepName }) => {
        asked.push(stepName)

        return true
      }
    })

    let executions = 0

    const step = Object.assign(
      async () => {
        executions += 1

        return 'ok'
      },
      { maxRetries: 0 }
    )

    const { runId } = world.start(async () => world.runStep(step, [], 'once'), [])
    await world.settled(runId)

    expect(executions).toBe(1)
    expect(asked).toEqual([])
    expect(world.inspect(runId).discardedStepExecutions).toEqual([])
  })

  it('leaves the attempt numbering of real retries unchanged', async () => {
    const world = new TestWorkflowWorld({ discardStepExecution: () => true })
    const attempts: Array<number> = []

    const step = Object.assign(
      async () => {
        attempts.push(TestWorkflowWorld.getStepMetadata().attempt)

        // Every kept execution before the last attempt fails; discarded ones succeed, unseen.
        if (attempts.length % 2 === 0 && attempts.length < 6) throw new Error('transient')

        return `attempt ${attempts.at(-1)}`
      },
      { maxRetries: 2 }
    )

    const { runId } = world.start(async () => world.runStep(step, [], 'flaky'), [])
    await world.settled(runId)

    expect(attempts).toEqual([1, 1, 2, 2, 3, 3])
    await expect(world.sdk.getRun<string>(runId).returnValue).resolves.toBe('attempt 3')

    const { stepAttempts, discardedStepExecutions } = world.inspect(runId)

    expect(stepAttempts.get('flaky')).toBe(3)
    expect(discardedStepExecutions.map(execution => execution.attempt)).toEqual([1, 2, 3])
  })

  it('re-executes only the attempts the option picks', async () => {
    const world = new TestWorkflowWorld({ discardStepExecution: ({ attempt }) => attempt === 2 })
    const attempts: Array<number> = []

    const step = Object.assign(
      async () => {
        attempts.push(TestWorkflowWorld.getStepMetadata().attempt)

        if (attempts.length === 1) throw new Error('transient')

        return 'ok'
      },
      { maxRetries: 1 }
    )

    const { runId } = world.start(async () => world.runStep(step, [], 'flaky'), [])
    await world.settled(runId)

    expect(attempts).toEqual([1, 2, 2])
    expect(world.inspect(runId).stepAttempts.get('flaky')).toBe(2)
  })
})

describe('TestWorkflowWorld hooks', () => {
  const nextTask = () => new Promise(resolve => setTimeout(resolve, 0))

  const gate = () => {
    let open = () => {}

    const opened = new Promise<void>(resolve => {
      open = resolve
    })

    return { open, opened }
  }

  it('resumes a registered hook, which is gone once its workflow disposed it', async () => {
    const world = new TestWorkflowWorld()
    let received: unknown

    const { runId } = world.start(async () => {
      using hook = TestWorkflowWorld.createHook<{ readonly answer: number }>({ token: 'hook-a' })

      received = await hook
    }, [])

    await nextTask()
    await world.resumeHook('hook-a', { answer: 42 })
    await world.settled(runId)

    expect(received).toEqual({ answer: 42 })
    expect(world.hasResumedHook('hook-a')).toBe(true)
    await expect(world.resumeHook('hook-a', {})).rejects.toBeInstanceOf(
      TestWorkflowHookNotFoundError
    )
  })

  // Issue #304: the platform appends every payload sent to a live hook and `resumeHook` succeeds
  // for each; the workflow reads only the first.
  it('accepts a second answer to a live hook but delivers only the first', async () => {
    const world = new TestWorkflowWorld()
    const received: Array<string> = []

    const { runId } = world.start(async () => {
      using hook = TestWorkflowWorld.createHook<string>({ token: 'pause-1' })

      received.push(await hook)
    }, [])

    await nextTask()
    // Two tabs answer before the workflow reads the hook.
    await expect(
      Promise.all([
        world.resumeHook('pause-1', 'answer-A'),
        world.resumeHook('pause-1', 'answer-B')
      ])
    ).resolves.toEqual([undefined, undefined])
    await world.settled(runId)

    expect(received).toEqual(['answer-A'])
  })

  it('accepts answers until the hook is disposed, then answers HookNotFoundError', async () => {
    const world = new TestWorkflowWorld()
    const received: Array<string> = []
    const holdHook = gate()
    const holdRun = gate()

    const { runId } = world.start(async () => {
      {
        using hook = TestWorkflowWorld.createHook<string>({ token: 'pause-1' })

        received.push(await hook)
        await holdHook.opened
      }

      await holdRun.opened
    }, [])

    await nextTask()
    await world.resumeHook('pause-1', 'first')
    await nextTask()
    expect(received).toEqual(['first'])
    // Read once but not yet disposed: accepted, never read.
    await world.resumeHook('pause-1', 'second')

    holdHook.open()
    await nextTask()
    // Disposed while the run is still running.
    expect(world.status(runId)).toBe('running')
    await expect(world.resumeHook('pause-1', 'third')).rejects.toBeInstanceOf(
      TestWorkflowHookNotFoundError
    )

    holdRun.open()
    await world.settled(runId)
    expect(received).toEqual(['first'])
  })

  it('answers HookNotFoundError for a hook whose run ended without disposing it', async () => {
    const world = new TestWorkflowWorld()

    const { runId } = world.start(async () => {
      void TestWorkflowWorld.createHook<string>({ token: 'abandoned' })
    }, [])

    await world.settled(runId)

    await expect(world.resumeHook('abandoned', 'late')).rejects.toBeInstanceOf(
      TestWorkflowHookNotFoundError
    )
  })

  it('lets a later run reuse the token of an earlier run that was resumed', async () => {
    const world = new TestWorkflowWorld()

    const first = world.start(async () => {
      using hook = TestWorkflowWorld.createHook<string>({ token: 'session-hitl' })

      return await hook
    }, [])

    await nextTask()
    await world.resumeHook('session-hitl', 'run-1 answer')
    await world.settled(first.runId)

    const received: Array<string> = []

    const second = world.start(async () => {
      using hook = TestWorkflowWorld.createHook<string>({ token: 'session-hitl' })

      received.push(await hook)
    }, [])

    await nextTask()
    await world.resumeHook('session-hitl', 'run-2 answer')
    await world.settled(second.runId)

    expect(received).toEqual(['run-2 answer'])
    expect(world.status(second.runId)).toBe('completed')
  })

  // Issue #306: a token reused by the next pause routes a late duplicate of the earlier answer to
  // the next pause, on the platform as here. Hosts give every pause its own token.
  it('delivers a late duplicate to the next pause that reuses the token', async () => {
    const world = new TestWorkflowWorld()
    const received: Array<string> = []

    const { runId } = world.start(async () => {
      for (let pause = 1; pause <= 2; pause++) {
        using hook = TestWorkflowWorld.createHook<string>({ token: 'session-hitl' })

        received.push(await hook)
      }
    }, [])

    await nextTask()
    await world.resumeHook('session-hitl', 'answer-for-pause-1')
    await nextTask()
    await world.resumeHook('session-hitl', 'answer-for-pause-1')
    await world.settled(runId)

    expect(received).toEqual(['answer-for-pause-1', 'answer-for-pause-1'])
  })

  // Issue #318: the platform refuses a hook whose token another live hook holds
  // (package-directives.integration.test.ts shows it).
  it("refuses a hook whose token another run's live hook holds", async () => {
    const world = new TestWorkflowWorld()

    const holder = world.start(async () => {
      using hook = TestWorkflowWorld.createHook<string>({ token: 'session-hitl' })

      return await hook
    }, [])

    await nextTask()

    let refusal: unknown

    const refused = world.start(async () => {
      using hook = TestWorkflowWorld.createHook<string>({ token: 'session-hitl' })

      refusal = await hook.then(
        () => undefined,
        (error: unknown) => error
      )
    }, [])

    // A refused hook left unawaited fails nothing.
    const unawaited = world.start(async () => {
      void TestWorkflowWorld.createHook<string>({ token: 'session-hitl' })
    }, [])

    await nextTask()

    expect(refusal).toBeInstanceOf(TestWorkflowHookConflictError)
    expect(refusal).toMatchObject({
      name: 'HookConflictError',
      token: 'session-hitl',
      conflictingRunId: holder.runId,
      message: `Hook token "session-hitl" is already in use by another workflow (run "${holder.runId}")`
    })
    await world.settled(refused.runId)
    await world.settled(unawaited.runId)
    expect(world.status(unawaited.runId)).toBe('completed')

    // The holder's hook still answers, and its token is free again once its run ends.
    await world.resumeHook('session-hitl', 'holder answer')
    await world.settled(holder.runId)
    await expect(world.sdk.getRun(holder.runId).returnValue).resolves.toBe('holder answer')

    const later = world.start(async () => {
      using hook = TestWorkflowWorld.createHook<string>({ token: 'session-hitl' })

      return await hook
    }, [])

    await nextTask()
    await world.resumeHook('session-hitl', 'later answer')
    await expect(world.sdk.getRun(later.runId).returnValue).resolves.toBe('later answer')
  })

  it('refuses a second live hook of the same run, whose disposal keeps the first', async () => {
    const world = new TestWorkflowWorld()
    let refusal: unknown
    let received: string | undefined

    const { runId } = world.start(async () => {
      using first = TestWorkflowWorld.createHook<string>({ token: 'pause-1' })

      {
        using second = TestWorkflowWorld.createHook<string>({ token: 'pause-1' })

        refusal = await second.then(
          () => undefined,
          (error: unknown) => error
        )
      }

      received = await first
    }, [])

    await nextTask()

    expect(refusal).toMatchObject({
      name: 'HookConflictError',
      token: 'pause-1',
      conflictingRunId: runId
    })

    await world.resumeHook('pause-1', 'first answer')
    await world.settled(runId)
    expect(received).toBe('first answer')
  })

  it('keeps a later hook live when an earlier hook with its token is disposed again', async () => {
    const world = new TestWorkflowWorld()
    const received: Array<string> = []

    const { runId } = world.start(async () => {
      const first = TestWorkflowWorld.createHook<string>({ token: 'pause-1' })

      received.push(await first)
      first[Symbol.dispose]()

      using second = TestWorkflowWorld.createHook<string>({ token: 'pause-1' })

      // Once the second hook holds the token.
      await Promise.resolve()
      first[Symbol.dispose]()
      received.push(await second)
    }, [])

    await nextTask()
    await world.resumeHook('pause-1', 'answer-1')
    await nextTask()
    await world.resumeHook('pause-1', 'answer-2')
    await world.settled(runId)

    expect(received).toEqual(['answer-1', 'answer-2'])
  })

  // The platform creates a hook when its run next suspends, after the disposals made since.
  it('lets the next hook take a token its run disposes after creating the next hook', async () => {
    const world = new TestWorkflowWorld()
    const received: Array<string> = []

    const { runId } = world.start(async () => {
      const previous = TestWorkflowWorld.createHook<string>({ token: 'pause-1' })

      received.push(await previous)

      using next = TestWorkflowWorld.createHook<string>({ token: 'pause-1' })

      previous[Symbol.dispose]()
      received.push(await next)
    }, [])

    await nextTask()
    await world.resumeHook('pause-1', 'first answer')
    await nextTask()
    await world.resumeHook('pause-1', 'next answer')
    await world.settled(runId)

    expect(received).toEqual(['first answer', 'next answer'])
  })

  it('refuses the next hook when its run suspends before disposing the token holder', async () => {
    const world = new TestWorkflowWorld()
    let refusal: unknown

    const { runId } = world.start(async () => {
      const previous = TestWorkflowWorld.createHook<string>({ token: 'pause-1' })

      await previous

      using next = TestWorkflowWorld.createHook<string>({ token: 'pause-1' })

      await world.runStep(async () => undefined, [], 'between-hooks')
      previous[Symbol.dispose]()
      refusal = await next.then(
        () => undefined,
        (error: unknown) => error
      )
    }, [])

    await nextTask()
    await world.resumeHook('pause-1', 'first answer')
    await world.settled(runId)

    expect(refusal).toMatchObject({ name: 'HookConflictError', conflictingRunId: runId })
  })

  it('rejects a hook still pending creation when its run is cancelled', async () => {
    const world = new TestWorkflowWorld()
    let hookError: unknown

    const { runId } = world.start(async () => {
      using hook = TestWorkflowWorld.createHook<string>({ token: 'pause-1' })

      // Cancelled before the hook is created.
      void world.cancel(TestWorkflowWorld.getWorkflowMetadata().workflowRunId)
      hookError = await hook.then(
        () => undefined,
        (error: unknown) => error
      )
    }, [])

    await nextTask()

    expect(hookError).toBeInstanceOf(TestWorkflowRunCancelledError)
    await world.settled(runId)
    expect(world.status(runId)).toBe('cancelled')
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
