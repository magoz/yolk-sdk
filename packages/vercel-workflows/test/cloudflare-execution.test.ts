import { Predicate } from 'effect'
import { describe, expect, it } from 'vitest'
import { workflowEntry, workflowStep } from '../src/cloudflare/directives.ts'
import { FatalError, WorkflowRunCancelledError } from '../src/cloudflare/errors.ts'
import { WorkflowExecution, type ExecutionHost } from '../src/cloudflare/execution.ts'
import { deserialize, serialize } from '../src/cloudflare/serialization.ts'
import { registerWorkflowModules } from '../src/cloudflare/registry.ts'
import { makeMemoryRunStore, type RunStore } from '../src/cloudflare/store.ts'
import {
  createHook,
  getStepMetadata,
  getStepSignal,
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

  it('frees a token on replay when an eviction lost its disposal', async () => {
    async function relayWorkflow() {
      const first = createHook({ token: 'relay' })

      await sleep(1)
      first[Symbol.dispose]()

      using second = createHook({ token: 'relay' })

      return await second
    }

    workflowEntry(relayWorkflow, 'test#relay')

    const store = makeMemoryRunStore()
    const { host, settled } = makeHost(store)
    const execution = new WorkflowExecution(host)
    const done = settled()

    startRun(store, 'test#relay', [])
    // An earlier execution: the first hook took the token and the sleep fired, then the object went
    // away before the disposal that followed was applied.
    store.writePendingHook('relay', 'hook:relay#0')
    store.writeSleep('sleep#0', Date.now())
    store.writeJournal('sleep#0', { ok: true, value: serialize(undefined) })
    execution.kick()
    await waitFor(() => store.readPendingHook('relay') === 'hook:relay#1')
    execution.deliverHook('relay', serialize('relayed'))
    await done

    expect(outcome(store)).toEqual({ status: 'completed', value: 'relayed' })
  })

  it('drops a payload sent to a disposed hook before its disposal applies', async () => {
    const store = makeMemoryRunStore()
    const { host, settled } = makeHost(store)
    const execution = new WorkflowExecution(host)

    async function lateWorkflow() {
      const hook = createHook({ token: 'late' })

      await sleep(20)
      hook[Symbol.dispose]()
      // A resume that arrives before the disposal applies (when the run next waits).
      execution.deliverHook('late', serialize('late'))

      return 'done'
    }

    workflowEntry(lateWorkflow, 'test#late')

    const done = settled()

    startRun(store, 'test#late', [])
    execution.kick()
    await done

    expect(outcome(store)).toEqual({ status: 'completed', value: 'done' })
    // Journaled, a replay would hand the payload to the hook it disposed unanswered.
    expect(store.readJournal('hook:late#0')).toBeUndefined()
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
    const executed = execution.kick()
    await waitFor(() => store.readPendingHook('never') !== undefined)
    execution.cancel()

    expect(store.readRun()?.status).toBe('cancelled')
    expect(execution.running).toBe(false)
    // The halted body never resumes, but the execution ends.
    await executed
  })

  it("aborts a running step's signal on cancel, drops its outcome, then settles", async () => {
    const seen: Array<string> = []
    let started = false
    let finish: () => void = () => undefined

    async function slowStep() {
      return workflowStep(slowStep, 'test#slow', async () => {
        const signal = getStepSignal()

        started = true
        signal.addEventListener('abort', () => {
          seen.push(`aborted: ${WorkflowRunCancelledError.is(signal.reason)}`)
        })

        // The step ends on its own schedule after the abort, as a fetch that honours it would.
        await new Promise<void>(resolve => {
          finish = resolve
        })

        return 'late'
      })
    }

    async function slowWorkflow() {
      seen.push(`step: ${String(await slowStep())}`)

      return 'done'
    }

    workflowEntry(slowWorkflow, 'test#slow-workflow')

    const store = makeMemoryRunStore()
    const { host } = makeHost(store)
    const execution = new WorkflowExecution(host)
    let ended = false

    startRun(store, 'test#slow-workflow', [])
    void execution.kick().then(() => {
      ended = true
    })
    await waitFor(() => started)
    execution.cancel()

    expect(seen).toEqual(['aborted: true'])

    // Not ended while its step still runs.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(ended).toBe(false)

    finish()
    await waitFor(() => ended)

    // The step's outcome is dropped: never journaled, never seen by the body.
    expect(seen).toEqual(['aborted: true'])
    expect(store.readJournal('step:test#slow#0')).toBeUndefined()
    expect(store.readRun()?.status).toBe('cancelled')
  })

  it('ends a step waiting to retry at once when its run is cancelled', async () => {
    let attempts = 0

    async function failingStep() {
      return workflowStep(failingStep, 'test#failing', async () => {
        attempts += 1
        throw new Error('transient')
      })
    }

    Object.assign(failingStep, { maxRetries: 3 })

    async function failingWorkflow() {
      return await failingStep()
    }

    workflowEntry(failingWorkflow, 'test#failing-workflow')

    const store = makeMemoryRunStore()
    const { host } = makeHost(store)
    const execution = new WorkflowExecution(host)

    startRun(store, 'test#failing-workflow', [])
    const executed = execution.kick()
    await waitFor(() => attempts === 1)

    // The first backoff is a second; the cancelled run's execution ends well before it.
    const cancelledAt = Date.now()
    execution.cancel()
    await executed

    expect(Date.now() - cancelledAt).toBeLessThan(500)
    expect(attempts).toBe(1)
  })

  it('never retries or journals a step that fails with its abort reason', async () => {
    let attempts = 0

    async function abortableStep() {
      return workflowStep(abortableStep, 'test#abortable', async () => {
        const signal = getStepSignal()

        attempts += 1

        // A fetch given the signal rejects with its reason when the run is cancelled.
        await new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      })
    }

    Object.assign(abortableStep, { maxRetries: 3 })

    async function abortableWorkflow() {
      return await abortableStep()
    }

    workflowEntry(abortableWorkflow, 'test#abortable-workflow')

    const store = makeMemoryRunStore()
    const { host } = makeHost(store)
    const execution = new WorkflowExecution(host)

    startRun(store, 'test#abortable-workflow', [])
    const executed = execution.kick()
    await waitFor(() => attempts === 1)
    execution.cancel()
    await executed

    expect(attempts).toBe(1)
    expect(store.readJournal('step:test#abortable#0')).toBeUndefined()
    expect(store.readRun()?.status).toBe('cancelled')
  })

  it('keeps a run cancelled while its workflow module loads', async () => {
    let loaded: () => void = () => undefined
    let ran = false

    async function lazyWorkflow() {
      ran = true

      return 'ran'
    }

    registerWorkflowModules({
      'test-lazy': async () => {
        await new Promise<void>(resolve => {
          loaded = resolve
        })
        workflowEntry(lazyWorkflow, 'test-lazy#lazyWorkflow')
      }
    })

    const store = makeMemoryRunStore()
    const { host } = makeHost(store)
    const execution = new WorkflowExecution(host)

    startRun(store, 'test-lazy#lazyWorkflow', [])
    const executed = execution.kick()
    execution.cancel()
    loaded()
    await executed

    expect(store.readRun()?.status).toBe('cancelled')
    expect(ran).toBe(false)
  })

  it('gives the step signal only inside a step', () => {
    expect(() => getStepSignal()).toThrow('getStepSignal() can only be called inside a step')
  })
})
