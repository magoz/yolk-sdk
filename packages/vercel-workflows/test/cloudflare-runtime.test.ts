import { DatabaseSync } from 'node:sqlite'
import { Predicate } from 'effect'
import { parseAst } from 'vite'
import { beforeEach, describe, expect, it } from 'vitest'
import { getRun, resumeHook, start } from '../src/cloudflare/api.ts'
import { workflowEntry, workflowStep } from '../src/cloudflare/directives.ts'
import {
  HookNotFoundError,
  parseDuration,
  RetryableError,
  WorkflowRunCancelledError
} from '../src/cloudflare/errors.ts'
import { registerWorkflowModules } from '../src/cloudflare/registry.ts'
import { deserialize, serialize } from '../src/cloudflare/serialization.ts'
import { makeSqliteRunStore } from '../src/cloudflare/sqlite-store.ts'
import { compileWorkflowDirectives, workflowDirectivesRuntime } from '../src/cloudflare/vite.ts'
import { createHook, getWritable, sleep } from '../src/cloudflare/workflow.ts'
import { makeFakeWorkflowRuns, makeGate, makeSqliteSql } from './cloudflare-fakes.ts'

const readText = async (stream: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder()
  let text = ''

  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true })

  return text + decoder.decode()
}

const waitFor = async (condition: () => Promise<boolean> | boolean, timeoutMs = 1000) => {
  for (let tries = 0; tries < timeoutMs / 5; tries++) {
    if (await condition()) return

    await new Promise(resolve => setTimeout(resolve, 5))
  }

  throw new Error('condition not met')
}

/** What a workflow body sees of a refused hook. */
const refusalOf = (error: unknown) => ({
  name: Predicate.hasProperty(error, 'name') ? error.name : undefined,
  conflictingRunId: Predicate.hasProperty(error, 'conflictingRunId')
    ? error.conflictingRunId
    : undefined
})

describe('WorkflowRun and the workflow/api module', () => {
  let runs = makeFakeWorkflowRuns()

  beforeEach(() => {
    runs = makeFakeWorkflowRuns()
    runs.install()
  })

  // A run (the returner) freed `token` and the index still names it. Another run (the arriver)
  // claims it: the index asks the returner, whose answer (it holds nothing) is held at a gate while
  // the returner creates a new hook on the token and claims it again. The test opens the gate.
  const returnWhileAnswerIsLate = async (token: string) => {
    const gate = makeGate()
    let gated = ''

    runs.installWith((name, stub) =>
      name === gated
        ? {
            ...stub,
            hookHeld: async held => {
              const answer = await stub.hookHeld(held)

              await gate.wait()

              return answer
            }
          }
        : stub
    )

    let reclaim: () => void = () => undefined

    const reclaimed = new Promise<void>(resolve => {
      reclaim = resolve
    })

    async function returning() {
      const first = createHook({ token })

      await sleep(10)
      first.dispose()
      await sleep(10)
      // Not durable: the test lets the run go on once the arriver's claim waits on the gate.
      await reclaimed

      using second = createHook({ token })

      try {
        return { answer: await second }
      } catch (error) {
        return refusalOf(error)
      }
    }

    async function arriving() {
      using hook = createHook({ token })

      return { answer: await hook }
    }

    workflowEntry(returning, `runtime#returning-${token}`)
    workflowEntry(arriving, `runtime#arriving-${token}`)

    const returner = await start(returning)
    const index = runs.namespace.getByName(`hook:${token}`)
    const returnerObject = runs.namespace.getByName(returner.runId)

    await waitFor(async () => (await index.hookRun()) === returner.runId)
    await waitFor(async () => !(await returnerObject.hookHeld(token)))
    gated = returner.runId

    const arriver = await start(arriving)

    await waitFor(() => gate.reached)
    reclaim()
    await waitFor(() => returnerObject.hookHeld(token))

    return { gate, index, returner, arriver }
  }

  it('starts a run, streams its chunks, and returns its result', async () => {
    async function emit(text: string) {
      return workflowStep(emit, 'runtime#emit', async () => {
        const writer = getWritable().getWriter()

        await writer.write(new TextEncoder().encode(text))
        writer.releaseLock()

        return text.length
      })
    }

    async function finish() {
      return workflowStep(finish, 'runtime#finish', async () => {
        await getWritable().close()
      })
    }

    async function greet(name: string) {
      const lengths = [await emit('hello '), await emit(name)]

      await finish()

      return { lengths, at: new Date(0) }
    }

    workflowEntry(greet, 'runtime#greet')

    const run = await start(greet, ['ada'])

    expect(run.runId).toMatch(/^wrun_[0-9a-f]{32}$/)
    expect(await run.returnValue).toEqual({ lengths: [6, 3], at: new Date(0) })
    expect(await run.status).toBe('completed')
    expect(await readText(getRun(run.runId).getReadable())).toBe('hello ada')
    expect(await readText(getRun(run.runId).getReadable({ startIndex: -1 }))).toBe('ada')
    expect(await getRun(run.runId).getReadable().getTailIndex()).toBe(1)
  })

  it('resumes a hook by token and refuses tokens no run waits on', async () => {
    async function approval() {
      using hook = createHook({ token: 'runtime-approve' })

      return { answer: await hook }
    }

    workflowEntry(approval, 'runtime#approval')

    const run = await start(approval)

    await waitFor(
      async () => (await runs.namespace.getByName('hook:runtime-approve').hookRun()) !== undefined
    )
    await resumeHook('runtime-approve', { ok: true })

    expect(await run.returnValue).toEqual({ answer: { ok: true } })
    await expect(resumeHook('runtime-approve', 'again')).rejects.toSatisfy(HookNotFoundError.is)
    await expect(resumeHook('runtime-unknown', 'x')).rejects.toSatisfy(HookNotFoundError.is)
  })

  it('refuses a hook whose token a live hook of another run holds, until that run ends', async () => {
    async function holding() {
      // Never disposed: the token is freed when the run ends.
      const hook = createHook({ token: 'runtime-shared' })

      return await hook
    }

    async function taking() {
      using hook = createHook({ token: 'runtime-shared' })

      try {
        return { answer: await hook }
      } catch (error) {
        return {
          refused: Predicate.hasProperty(error, 'name') ? error.name : undefined,
          conflictingRunId: Predicate.hasProperty(error, 'conflictingRunId')
            ? error.conflictingRunId
            : undefined
        }
      }
    }

    workflowEntry(holding, 'runtime#holding')
    workflowEntry(taking, 'runtime#taking')

    const holder = await start(holding)
    const index = runs.namespace.getByName('hook:runtime-shared')

    await waitFor(async () => (await index.hookRun()) === holder.runId)

    const refused = await start(taking)

    expect(await refused.returnValue).toEqual({
      refused: 'HookConflictError',
      conflictingRunId: holder.runId
    })

    // The holder keeps the token and its answers.
    await resumeHook('runtime-shared', 'first')
    expect(await holder.returnValue).toBe('first')

    const taker = await start(taking)

    await waitFor(async () => (await index.hookRun()) === taker.runId)
    await resumeHook('runtime-shared', 'second')
    expect(await taker.returnValue).toEqual({ answer: 'second' })
  })

  it('frees a token when its hook is disposed', async () => {
    async function abandoning() {
      const hook = createHook({ token: 'runtime-abandoned' })

      // The run waits: its hook takes the token. Then it disposes the hook unanswered.
      await sleep(20)
      hook[Symbol.dispose]()

      return await createHook({ token: 'runtime-after' })
    }

    async function retaking() {
      using hook = createHook({ token: 'runtime-abandoned' })

      return await hook
    }

    workflowEntry(abandoning, 'runtime#abandoning')
    workflowEntry(retaking, 'runtime#retaking')

    const abandoned = await start(abandoning)
    const index = runs.namespace.getByName('hook:runtime-abandoned')

    await waitFor(async () => (await index.hookRun()) === abandoned.runId)
    await waitFor(
      async () =>
        (await runs.namespace.getByName('hook:runtime-after').hookRun()) === abandoned.runId
    )
    await expect(resumeHook('runtime-abandoned', 'late')).rejects.toSatisfy(HookNotFoundError.is)

    const taker = await start(retaking)

    await waitFor(async () => (await index.hookRun()) === taker.runId)
    await resumeHook('runtime-abandoned', 'taken')
    expect(await taker.returnValue).toBe('taken')

    await resumeHook('runtime-after', 'done')
    expect(await abandoned.returnValue).toBe('done')
  })

  it('gives a token to one run when its last holder claims it again during a late answer', async () => {
    const { gate, index, returner, arriver } = await returnWhileAnswerIsLate('runtime-aba')

    gate.open()

    // The arriver took the token; the returner's new hook is refused instead of holding it too.
    await waitFor(async () => (await returner.status) === 'completed')
    expect(await returner.returnValue).toEqual({
      name: 'HookConflictError',
      conflictingRunId: arriver.runId
    })
    expect(await index.hookRun()).toBe(arriver.runId)
    await resumeHook('runtime-aba', 'arrived')
    expect(await arriver.returnValue).toEqual({ answer: 'arrived' })
  })

  it('delivers no payload to a hook whose claim is still undecided', async () => {
    const { gate, returner, arriver } = await returnWhileAnswerIsLate('runtime-undecided')

    // The index still names the returner, but its new hook has not taken the token.
    await expect(resumeHook('runtime-undecided', 'early')).rejects.toSatisfy(HookNotFoundError.is)
    gate.open()
    await waitFor(async () => (await returner.status) === 'completed')
    expect(await returner.returnValue).toEqual({
      name: 'HookConflictError',
      conflictingRunId: arriver.runId
    })
    await resumeHook('runtime-undecided', 'arrived')
    expect(await arriver.returnValue).toEqual({ answer: 'arrived' })
  })

  it('claims a hook again when its object restarted during the claim', async () => {
    const gate = makeGate()
    let first = true

    runs.installWith((name, stub) =>
      name === 'hook:runtime-cut'
        ? {
            ...stub,
            hookClaim: async (token, runId) => {
              // The first claim never returns: its object restarts meanwhile.
              if (first) {
                first = false
                await gate.wait()
              }

              return stub.hookClaim(token, runId)
            }
          }
        : stub
    )

    async function cut() {
      using hook = createHook({ token: 'runtime-cut' })

      return await hook
    }

    workflowEntry(cut, 'runtime#cut')

    const run = await start(cut)

    await waitFor(() => gate.reached)
    await runs.settleBackground()
    runs.evict(run.runId)
    await runs.fireAlarm(run.runId)
    await waitFor(
      async () => (await runs.namespace.getByName('hook:runtime-cut').hookRun()) === run.runId
    )
    await resumeHook('runtime-cut', 'after restart')
    expect(await run.returnValue).toBe('after restart')
    // The claim armed the guard alarm that replayed the run.
    expect(runs.alarmOf(run.runId)).toBeTypeOf('number')
  })

  it('retries a hook claim the index failed', async () => {
    let failures = 1

    runs.installWith((name, stub) =>
      name === 'hook:runtime-flaky'
        ? {
            ...stub,
            hookClaim: async (token, runId) => {
              if (failures > 0) {
                failures -= 1

                throw new Error('index reset')
              }

              return stub.hookClaim(token, runId)
            }
          }
        : stub
    )

    async function flaky() {
      using hook = createHook({ token: 'runtime-flaky' })

      return await hook
    }

    workflowEntry(flaky, 'runtime#flaky')

    const run = await start(flaky)

    await waitFor(
      async () => (await runs.namespace.getByName('hook:runtime-flaky').hookRun()) === run.runId,
      3000
    )
    await resumeHook('runtime-flaky', 'retried')
    expect(await run.returnValue).toBe('retried')
  })

  it('lets another run take a token whose hook was disposed while its claim waited to retry', async () => {
    let first = true

    runs.installWith((name, stub) =>
      name === 'hook:runtime-backoff'
        ? {
            ...stub,
            hookClaim: async (token, runId) => {
              const claim = await stub.hookClaim(token, runId)

              // Granted, but the answer never reaches the run, which waits to retry.
              if (first) {
                first = false

                throw new Error('answer lost')
              }

              return claim
            }
          }
        : stub
    )

    async function abandoningDuringBackoff() {
      const hook = createHook({ token: 'runtime-backoff' })

      await sleep(50)
      hook.dispose()

      return await createHook({ token: 'runtime-backoff-next' })
    }

    async function takingAfterBackoff() {
      using hook = createHook({ token: 'runtime-backoff' })

      return await hook
    }

    workflowEntry(abandoningDuringBackoff, 'runtime#abandoning-during-backoff')
    workflowEntry(takingAfterBackoff, 'runtime#taking-after-backoff')

    const abandoned = await start(abandoningDuringBackoff)
    const index = runs.namespace.getByName('hook:runtime-backoff')

    await waitFor(async () => (await index.hookRun()) === abandoned.runId)
    // The run disposed its hook at 50 ms; its claim would retry only after a second.
    await new Promise(resolve => setTimeout(resolve, 150))

    const taker = await start(takingAfterBackoff)

    await waitFor(async () => (await index.hookRun()) === taker.runId)
    await resumeHook('runtime-backoff', 'taken')
    expect(await taker.returnValue).toBe('taken')
  })

  it('claims a token while the index of another token of the run keeps failing', async () => {
    const gate = makeGate()

    runs.installWith((name, stub) =>
      name === 'hook:runtime-stuck'
        ? {
            ...stub,
            hookClaim: async () => {
              await gate.wait()

              throw new Error('index unreachable')
            }
          }
        : stub
    )

    async function twoTokens() {
      createHook({ token: 'runtime-stuck' })

      using hook = createHook({ token: 'runtime-free' })

      return await hook
    }

    workflowEntry(twoTokens, 'runtime#two-tokens')

    const run = await start(twoTokens)

    await waitFor(
      async () => (await runs.namespace.getByName('hook:runtime-free').hookRun()) === run.runId
    )
    await resumeHook('runtime-free', 'free')
    expect(await run.returnValue).toBe('free')
  })

  it('replays a refused hook as refused after an eviction', async () => {
    async function keeping() {
      const hook = createHook({ token: 'runtime-replayed' })

      return await hook
    }

    async function refusedThenWaiting() {
      const refusal = await createHook({ token: 'runtime-replayed' }).then(
        () => undefined,
        refusalOf
      )

      return { refusal, next: await createHook({ token: 'runtime-replayed-next' }) }
    }

    workflowEntry(keeping, 'runtime#keeping')
    workflowEntry(refusedThenWaiting, 'runtime#refused-then-waiting')

    const holder = await start(keeping)

    await waitFor(
      async () =>
        (await runs.namespace.getByName('hook:runtime-replayed').hookRun()) === holder.runId
    )

    const refused = await start(refusedThenWaiting)

    await waitFor(
      async () =>
        (await runs.namespace.getByName('hook:runtime-replayed-next').hookRun()) === refused.runId
    )
    runs.evict(refused.runId)
    await resumeHook('runtime-replayed-next', 'next')
    expect(await refused.returnValue).toEqual({
      refusal: { name: 'HookConflictError', conflictingRunId: holder.runId },
      next: 'next'
    })
  })

  it('replays a run after its object was evicted without re-running finished steps', async () => {
    let prepared = 0

    async function prepare() {
      return workflowStep(prepare, 'runtime#prepare', async () => {
        prepared += 1

        return new Map([['step', prepared]])
      })
    }

    async function evicted() {
      const value = await prepare()
      using hook = createHook()

      return { value, payload: await hook, token: hook.token }
    }

    workflowEntry(evicted, 'runtime#evicted')

    const run = await start(evicted)
    const token = `${run.runId}:hook#0`

    await waitFor(
      async () => (await runs.namespace.getByName(`hook:${token}`).hookRun()) !== undefined
    )
    runs.evict(run.runId)
    await resumeHook(token, 'after eviction')

    expect(await run.returnValue).toEqual({
      value: new Map([['step', 1]]),
      payload: 'after eviction',
      token
    })
    expect(prepared).toBe(1)
  })

  it('re-runs a step cut off by an eviction when the step guard alarm fires', async () => {
    let attempts = 0

    async function cutOff() {
      return workflowStep(cutOff, 'runtime#cut-off', async () => {
        attempts += 1

        // The first attempt never finishes: its object is evicted while the step runs.
        if (attempts === 1) await new Promise(() => undefined)

        return attempts
      })
    }

    async function recovered() {
      return await cutOff()
    }

    workflowEntry(recovered, 'runtime#recovered')

    const run = await start(recovered)

    await waitFor(() => attempts === 1)
    await runs.settleBackground()
    expect(runs.alarmOf(run.runId)).toBeTypeOf('number')

    runs.evict(run.runId)
    await runs.fireAlarm(run.runId)

    expect(await run.returnValue).toBe(2)
    expect(attempts).toBe(2)
  })

  it('rejects a cancelled run with WorkflowRunCancelledError', async () => {
    async function waiting() {
      using hook = createHook({ token: 'runtime-never' })

      return await hook
    }

    workflowEntry(waiting, 'runtime#waiting')

    const run = await start(waiting)

    await waitFor(async () => (await run.status) === 'running')
    await run.cancel()

    expect(await run.status).toBe('cancelled')
    await expect(run.returnValue).rejects.toSatisfy(WorkflowRunCancelledError.is)
  })

  it('rejects returnValue with the workflow error and fails unknown workflows', async () => {
    async function failing() {
      throw new TypeError('bad input', { cause: { code: 'E_INPUT' } })
    }

    workflowEntry(failing, 'runtime#failing')

    const failed = await start(failing)

    await expect(failed.returnValue).rejects.toMatchObject({
      name: 'TypeError',
      message: 'bad input',
      cause: { code: 'E_INPUT' }
    })
    await expect(start(async () => undefined)).rejects.toThrow('"use workflow"')
  })

  it('loads a registered workflow module lazily when a run needs it', async () => {
    let loaded = 0

    async function lazy(value: number) {
      return value * 2
    }

    registerWorkflowModules({
      'lazy/module.ts': async () => {
        loaded += 1
        workflowEntry(lazy, 'lazy/module.ts#lazy')
      }
    })

    expect(loaded).toBe(0)

    // A Worker that only receives the run (it did not start it) knows the id, not the function.
    await runs.namespace
      .getByName('wrun_lazy')
      .start({ runId: 'wrun_lazy', workflowId: 'lazy/module.ts#lazy', args: serialize([21]) })

    expect(await getRun('wrun_lazy').returnValue).toBe(42)
    expect(loaded).toBe(1)
  })
})

describe('the SQLite run store', () => {
  it('splits large values into parts and reads them back whole', () => {
    const store = makeSqliteRunStore(makeSqliteSql(new DatabaseSync(':memory:')))
    const large = 'x'.repeat(512 * 1024 * 2 + 7)

    store.createRun({
      runId: 'wrun_sqlite',
      workflowId: 'store#large',
      args: serialize([large]),
      status: 'pending',
      outcome: undefined,
      createdAt: 1,
      completedAt: undefined
    })
    store.writeJournal('step:large#0', { ok: true, value: serialize(large) })
    store.writePendingHook('token', 'hook:token#0')
    store.writeSleep('sleep#0', 50)
    store.writeSleep('sleep#1', 20)
    store.writeJournal('sleep#1', { ok: true, value: serialize(undefined) })

    expect(deserialize(store.readRun()?.args ?? '')).toEqual([large])
    expect(deserialize(store.readJournal('step:large#0')?.value ?? '')).toBe(large)
    expect(store.readPendingHook('token')).toBe('hook:token#0')
    expect(store.earliestPendingSleep()).toBe(50)

    expect(store.appendChunk(new Uint8Array([1, 2]))).toBe(0)
    expect(store.appendChunk(new Uint8Array([3]))).toBe(1)
    expect(store.readChunks(1)).toEqual([new Uint8Array([3])])
    expect(store.isStreamClosed()).toBe(false)
    store.closeStream()
    expect(store.isStreamClosed()).toBe(true)

    store.finishRun('completed', serialize('done'))
    expect(store.readRun()?.status).toBe('completed')
    expect(store.readRun()?.completedAt).toBeTypeOf('number')
  })
})

describe('serialization', () => {
  it('keeps error names, causes and the platform step signals', () => {
    const retryable = new RetryableError('later', { retryAfter: '1m' })
    const copy = deserialize(serialize({ retryable, set: new Set([1]), missing: undefined }))

    expect(copy).toEqual({ retryable: expect.any(Error), set: new Set([1]), missing: undefined })
    expect(copy).toHaveProperty('retryable.name', 'RetryableError')
    expect(copy).toHaveProperty('retryable.retryAfter', retryable.retryAfter)
  })

  it('parses Workflow duration strings', () => {
    expect([parseDuration('500'), parseDuration('30s'), parseDuration('2 hours')]).toEqual([
      500, 30_000, 7_200_000
    ])
    expect(parseDuration('1w')).toBe(604_800_000)
    expect(() => parseDuration('soon')).toThrow('Invalid duration')
  })
})

describe('compileWorkflowDirectives', () => {
  const compile = (code: string) =>
    compileWorkflowDirectives(code, {
      modulePath: 'app/flow.ts',
      runtime: workflowDirectivesRuntime,
      parse: source => parseAst(source)
    })

  it('wraps step bodies and registers workflows under <module>#<name>', () => {
    const output = compile(
      [
        'export async function load(id) {',
        "  'use step'",
        '  return id',
        '}',
        'export async function flow(id) {',
        "  'use workflow'",
        '  return load(id)',
        '}',
        'async function plain() { return 1 }'
      ].join('\n')
    )

    expect(output).toContain(`from "@yolk-sdk/vercel-workflows/cloudflare/directives";`)
    expect(output).toContain(
      `{ return __yolkWorkflowStep(load, "app/flow.ts#load", async () => {\n  'use step'`
    )
    expect(output).toContain('__yolkWorkflowEntry(flow, "app/flow.ts#flow");')
    expect(output).not.toContain('app/flow.ts#plain')
  })

  it('leaves modules without top-level directive functions alone', () => {
    expect(compile('export const x = 1')).toBeUndefined()
    expect(compile("const f = async () => { 'use step'; return 1 }")).toBeUndefined()
  })
})
