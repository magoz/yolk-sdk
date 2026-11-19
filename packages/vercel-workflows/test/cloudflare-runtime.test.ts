import { DatabaseSync } from 'node:sqlite'
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
import { createHook, getWritable } from '../src/cloudflare/workflow.ts'
import { makeFakeWorkflowRuns, makeSqliteSql } from './cloudflare-fakes.ts'

const readText = async (stream: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder()
  let text = ''

  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true })

  return text + decoder.decode()
}

const waitFor = async (condition: () => Promise<boolean> | boolean) => {
  for (let tries = 0; tries < 200; tries++) {
    if (await condition()) return

    await new Promise(resolve => setTimeout(resolve, 5))
  }

  throw new Error('condition not met')
}

describe('WorkflowRun and the workflow/api module', () => {
  let runs = makeFakeWorkflowRuns()

  beforeEach(() => {
    runs = makeFakeWorkflowRuns()
    runs.install()
  })

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
