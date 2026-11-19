import { Predicate } from 'effect'
import { describe, expect, it } from 'vitest'
import { workflowEntry, workflowStep } from '../src/cloudflare/directives.ts'
import { FatalError } from '../src/cloudflare/errors.ts'
import { WorkflowExecution, type ExecutionHost } from '../src/cloudflare/execution.ts'
import { deserialize, serialize } from '../src/cloudflare/serialization.ts'
import { makeMemoryRunStore, type RunStore } from '../src/cloudflare/store.ts'
import {
  createHook,
  getStepMetadata,
  getWorkflowMetadata,
  getWritable,
  sleep
} from '../src/cloudflare/workflow.ts'

const makeHost = (store: RunStore) => {
  const settled: Array<() => void> = []

  const host: ExecutionHost = {
    store,
    wakeAt: () => undefined,
    claimHook: async () => ({ claimed: true }),
    chunkAppended: () => undefined,
    streamClosed: () => undefined,
    runSettled: () => {
      for (const resolve of settled.splice(0)) resolve()
    },
    log: () => undefined
  }

  return {
    host,
    settled: () => new Promise<void>(resolve => settled.push(resolve))
  }
}

const startRun = (store: RunStore, workflowId: string, args: ReadonlyArray<unknown>) => {
  store.createRun({
    runId: 'wrun_test',
    workflowId,
    args: serialize(args),
    status: 'pending',
    outcome: undefined,
    createdAt: Date.now(),
    completedAt: undefined
  })
}

const outcome = (store: RunStore) => {
  const run = store.readRun()

  return {
    status: run?.status,
    value: run?.outcome === undefined ? undefined : deserialize(run.outcome)
  }
}

const waitFor = async (condition: () => boolean) => {
  for (let tries = 0; tries < 200; tries++) {
    if (condition()) return

    await new Promise(resolve => setTimeout(resolve, 5))
  }

  throw new Error('condition not met')
}

describe('WorkflowExecution', () => {
  it('runs steps in order and records the result', async () => {
    let calls = 0
    const metadata: Array<unknown> = []

    async function add(left: number, right: number) {
      return workflowStep(add, 'test#add', async () => {
        calls += 1

        return {
          sum: left + right,
          attempt: getStepMetadata().attempt,
          runId: getWorkflowMetadata().workflowRunId
        }
      })
    }

    async function sumWorkflow(values: ReadonlyArray<number>) {
      let total = 0

      for (const value of values) {
        const result = await add(total, value)

        metadata.push(result)

        if (Predicate.hasProperty(result, 'sum')) total = Number(result.sum)
      }

      return total
    }

    workflowEntry(sumWorkflow, 'test#sum')

    const store = makeMemoryRunStore()
    const { host, settled } = makeHost(store)

    startRun(store, 'test#sum', [[1, 2, 3]])
    const done = settled()
    new WorkflowExecution(host).kick()
    await done

    expect(outcome(store)).toEqual({ status: 'completed', value: 6 })
    expect(calls).toBe(3)
    expect(metadata).toEqual([
      { sum: 1, attempt: 1, runId: 'wrun_test' },
      { sum: 3, attempt: 1, runId: 'wrun_test' },
      { sum: 6, attempt: 1, runId: 'wrun_test' }
    ])
  })

  it('replays finished steps without running them again after a restart', async () => {
    let stepRuns = 0

    async function prepare() {
      return workflowStep(prepare, 'test#prepare', async () => {
        stepRuns += 1

        return 'prepared'
      })
    }

    async function approvalWorkflow() {
      const prepared = await prepare()
      using hook = createHook({ token: 'approve-1' })
      const answer = await hook

      return `${String(prepared)}:${String(answer)}`
    }

    workflowEntry(approvalWorkflow, 'test#approval')

    const store = makeMemoryRunStore()
    const first = makeHost(store)

    startRun(store, 'test#approval', [])
    new WorkflowExecution(first.host).kick()
    await waitFor(() => store.readPendingHook('approve-1') !== undefined)

    // The object restarts: a new execution over the same storage receives the payload.
    const second = makeHost(store)
    const restarted = new WorkflowExecution(second.host)
    const done = second.settled()

    restarted.deliverHook('approve-1', serialize('yes'))
    await done

    expect(outcome(store)).toEqual({ status: 'completed', value: 'prepared:yes' })
    expect(stepRuns).toBe(1)
  })

  it('refuses a hook while another live hook of its run holds the token', async () => {
    const refusal = (hook: PromiseLike<unknown>) =>
      hook.then(
        () => 'accepted',
        (error: unknown) => ({
          name: Predicate.hasProperty(error, 'name') ? error.name : undefined,
          conflictingRunId: Predicate.hasProperty(error, 'conflictingRunId')
            ? error.conflictingRunId
            : undefined
        })
      )

    async function roundsWorkflow() {
      const first = createHook({ token: 'round' })
      const a = await first
      // The answered first hook still holds the token: a second hook is refused when awaited, and
      // disposing it never frees the first hook's token.
      const refused = createHook({ token: 'round' })
      const conflict = await refusal(refused)

      refused[Symbol.dispose]()

      const stillRefused = await refusal(createHook({ token: 'round' }))
      // Disposed before the run waits again: the next hook takes the token, as on the platform.
      const second = createHook({ token: 'round' })

      first[Symbol.dispose]()

      const b = await second

      second[Symbol.dispose]()

      using third = createHook({ token: 'round' })
      const c = await third

      return { a, conflict, stillRefused, b, c }
    }

    workflowEntry(roundsWorkflow, 'test#rounds')

    const store = makeMemoryRunStore()
    const { host, settled } = makeHost(store)
    const execution = new WorkflowExecution(host)
    const done = settled()

    startRun(store, 'test#rounds', [])
    execution.kick()
    await waitFor(() => store.readPendingHook('round') === 'hook:round#0')
    execution.deliverHook('round', serialize('a'))
    await waitFor(() => store.readPendingHook('round') === 'hook:round#3')
    execution.deliverHook('round', serialize('b'))
    await waitFor(() => store.readPendingHook('round') === 'hook:round#4')
    execution.deliverHook('round', serialize('c'))
    await done

    const conflict = { name: 'HookConflictError', conflictingRunId: 'wrun_test' }

    expect(outcome(store)).toEqual({
      status: 'completed',
      value: { a: 'a', conflict, stillRefused: conflict, b: 'b', c: 'c' }
    })
  })

  it('retries a failing step, stops on a fatal error, and wraps an exhausted one', async () => {
    let flaky = 0
    let fatal = 0
    let exhausted = 0

    async function flakyStep() {
      return workflowStep(flakyStep, 'test#flaky', async () => {
        flaky += 1

        if (flaky < 3) throw new Error('transient')

        return 'ok'
      })
    }

    async function fatalStep() {
      return workflowStep(fatalStep, 'test#fatal', async () => {
        fatal += 1
        throw new FatalError('do not retry')
      })
    }

    async function exhaustedStep() {
      return workflowStep(exhaustedStep, 'test#exhausted', async () => {
        exhausted += 1
        throw new Error('always', { cause: { code: 'x' } })
      })
    }

    Object.assign(flakyStep, { maxRetries: 3 })
    Object.assign(exhaustedStep, { maxRetries: 1 })

    async function retryWorkflow() {
      const results: Array<string> = [String(await flakyStep())]

      try {
        await fatalStep()
      } catch (error) {
        results.push(error instanceof Error ? error.name : 'unknown')
      }

      try {
        await exhaustedStep()
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined
        results.push(error instanceof Error ? error.name : 'unknown')
        results.push(cause instanceof Error ? cause.message : 'no cause')
      }

      return results
    }

    workflowEntry(retryWorkflow, 'test#retry')

    const store = makeMemoryRunStore()
    const { host, settled } = makeHost(store)

    startRun(store, 'test#retry', [])
    const done = settled()
    new WorkflowExecution(host).kick()
    await done

    expect(outcome(store)).toEqual({
      status: 'completed',
      value: ['ok', 'FatalError', 'FatalError', 'always']
    })
    expect([flaky, fatal, exhausted]).toEqual([3, 1, 2])
  }, 20_000)

  it('streams step writes and sleeps durably', async () => {
    async function writeStep(text: string) {
      return workflowStep(writeStep, 'test#write', async () => {
        const writer = getWritable().getWriter()

        await writer.write(new TextEncoder().encode(text))
        writer.releaseLock()
      })
    }

    async function closeStep() {
      return workflowStep(closeStep, 'test#close', async () => {
        await getWritable().close()
      })
    }

    async function streamWorkflow() {
      await writeStep('a')
      await sleep('10ms')
      await writeStep('b')
      await closeStep()
    }

    workflowEntry(streamWorkflow, 'test#stream')

    const store = makeMemoryRunStore()
    const { host, settled } = makeHost(store)

    startRun(store, 'test#stream', [])
    const done = settled()
    new WorkflowExecution(host).kick()
    await done

    const text = store
      .readChunks(0)
      .map(chunk => new TextDecoder().decode(chunk))
      .join('')

    expect(outcome(store).status).toBe('completed')
    expect(text).toBe('ab')
    expect(store.isStreamClosed()).toBe(true)
  })

  it('halts a cancelled run where it waits', async () => {
    async function waitingWorkflow() {
      using hook = createHook({ token: 'never' })

      return await hook
    }

    workflowEntry(waitingWorkflow, 'test#waiting')

    const store = makeMemoryRunStore()
    const { host } = makeHost(store)
    const execution = new WorkflowExecution(host)

    startRun(store, 'test#waiting', [])
    execution.kick()
    await waitFor(() => store.readPendingHook('never') !== undefined)
    execution.cancel()

    expect(store.readRun()?.status).toBe('cancelled')
    expect(execution.running).toBe(false)
  })
})
