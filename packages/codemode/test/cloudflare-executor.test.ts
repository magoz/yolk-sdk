import { createContext, runInContext } from 'node:vm'
import { Effect, Predicate } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { modelVisibleToolError, makeTool } from '@yolk-sdk/agent/tools'
import {
  defaultDynamicWorkerCpuMs,
  makeDynamicWorkerCodeModeExecutor,
  type WorkerLoader,
  type WorkerLoaderCode
} from '../src/cloudflare.ts'
import { rejectionPrefix } from '../src/guard.ts'
import { makeCodeModeTool, type CodeModeExecuteOptions } from '../src/index.ts'
import { moduleOf, QueryParams, runCode, text, type TestContext } from './fixtures.ts'

// Workers cannot run here, so two fake Worker Loaders stand in: `vmLoader` evaluates the module
// the executor builds in a fresh Node VM context per execution (what a fresh isolate gives the
// script: its own globals), and `controlledLoader` hands `run` to the test.

const workerEntrypointShim = 'class WorkerEntrypoint {}'

// Any class can be constructed without arguments; `run` is what the executor checks for.
const isConstructor = (value: unknown): value is new () => unknown => Predicate.isFunction(value)

/** Evaluates the isolate's main module as workerd would load it, in a fresh VM context. */
const instantiate = (code: WorkerLoaderCode) => {
  const source = code.modules[code.mainModule]

  if (source === undefined) throw new Error(`No main module ${code.mainModule}`)

  const importLine = 'import { WorkerEntrypoint } from "cloudflare:workers";'
  const exportLine = 'export default class CodeModeScript extends WorkerEntrypoint {'

  if (!source.startsWith(importLine) || !source.includes(exportLine)) {
    throw new Error('Unexpected module shape')
  }

  // The module's default export becomes the script's completion value.
  const script = `${source
    .replace(importLine, workerEntrypointShim)
    .replace(
      exportLine,
      'const CodeModeScript = class extends WorkerEntrypoint {'
    )}\nCodeModeScript`

  const Script: unknown = runInContext(script, createContext({}))

  if (!isConstructor(Script)) throw new Error('The module exports no entrypoint class')

  return new Script()
}

const loaded: Array<WorkerLoaderCode> = []

const vmLoader: WorkerLoader = {
  load: code => {
    loaded.push(code)

    return { getEntrypoint: () => instantiate(code) }
  }
}

const vmExecutor = makeDynamicWorkerCodeModeExecutor({ loader: () => vmLoader })

const controlledLoader = (run: (...args: ReadonlyArray<unknown>) => Promise<unknown>) => {
  const loader: WorkerLoader = { load: () => ({ getEntrypoint: () => ({ run }) }) }

  return makeDynamicWorkerCodeModeExecutor({ loader: () => loader })
}

const options = (overrides: Partial<CodeModeExecuteOptions> = {}): CodeModeExecuteOptions => ({
  tools: [],
  globals: [],
  timeoutMs: 5000,
  memoryLimitBytes: 64 * 1024 * 1024,
  store: {},
  signal: new AbortController().signal,
  ...overrides
})

describe('makeDynamicWorkerCodeModeExecutor', () => {
  it('loads an isolate without network access and runs TypeScript scripts in it', async () => {
    loaded.length = 0

    const result = await vmExecutor.execute('const n: number = 2\nreturn n * 21', options())

    expect(result).toEqual({
      ok: true,
      value: 42,
      output: [],
      storeWrites: { set: {}, delete: [] }
    })
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({
      compatibilityDate: '2026-05-12',
      mainModule: 'script.js',
      globalOutbound: null,
      limits: { cpuMs: 500 }
    })
    expect(loaded[0]?.modules['script.js']).not.toContain(
      'Object.defineProperty(globalThis, "console"'
    )
  })

  it('calls tools and globals on the host and collects output in order', async () => {
    const calls: Array<unknown> = []

    const result = await vmExecutor.execute(
      [
        'const hits = await tools.search_docs({ query: "q", when: new Date(0) })',
        'console.log("found", hits.length)',
        'text({ total: await sum(1, 2) })',
        'return hits'
      ].join('\n'),
      options({
        tools: [
          {
            name: 'search-docs',
            execute: async args => {
              calls.push(args)

              return [{ id: 'a' }]
            }
          }
        ],
        globals: [
          {
            name: 'sum',
            spread: true,
            execute: async args => (Array.isArray(args) ? args.reduce((a, b) => a + b, 0) : 0)
          }
        ]
      })
    )

    expect(calls).toEqual([{ query: 'q', when: '1970-01-01T00:00:00.000Z' }])
    expect(result).toMatchObject({
      ok: true,
      value: [{ id: 'a' }],
      output: [
        { type: 'text', text: 'found 1' },
        { type: 'text', text: '{"total":3}' }
      ]
    })
  })

  it('reads the store and reports writes of successful scripts', async () => {
    const result = await vmExecutor.execute(
      'store("count", load("count") + 1)\nstore("gone", undefined)\nreturn load("count")',
      options({ store: { count: 1, gone: 'x' } })
    )

    expect(result).toEqual({
      ok: true,
      value: 2,
      output: [],
      storeWrites: { set: { count: 2 }, delete: ['gone'] }
    })
  })

  it('applies the tools guard before a call leaves the isolate', async () => {
    let executed = false

    const result = await vmExecutor.execute(
      'await tools.write({ when: new Date(NaN) })',
      options({
        tools: [
          {
            name: 'write',
            execute: async () => {
              executed = true
            }
          }
        ]
      })
    )

    expect(executed).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.error?.message).toBe(
      'TypeError: tools.write: argument at when is an invalid Date; pass a valid Date or an ISO string'
    )
  })

  it('rejects unbound tools with their hint', async () => {
    const result = await vmExecutor.execute(
      'await tools.deploy({})',
      options({ unbound: [{ key: 'deploy', message: 'Stage deploy with stage()' }] })
    )

    expect(result.error?.message).toBe('TypeError: Stage deploy with stage()')
  })

  it('reports script errors and parse failures as script errors', async () => {
    const thrown = await vmExecutor.execute('throw new RangeError("too far")', options())
    const unparsable = await vmExecutor.execute('return (', options())

    expect(thrown).toMatchObject({
      ok: false,
      error: { kind: 'script', message: 'RangeError: too far' }
    })
    expect(unparsable.error?.kind).toBe('script')
    expect(unparsable.error?.message).toMatch(/^The script could not be parsed/)
  })

  it('times out a script that does not finish and aborts its tool calls', async () => {
    let toolSignal: AbortSignal | undefined

    const result = await vmExecutor.execute(
      'await tools.wait({})',
      options({
        timeoutMs: 50,
        tools: [
          {
            name: 'wait',
            execute: (_args, { signal }) => {
              toolSignal = signal

              return new Promise(() => undefined)
            }
          }
        ]
      })
    )

    expect(result).toEqual({
      ok: false,
      error: { kind: 'timeout', message: 'Execution timed out after 50 ms' },
      output: []
    })
    expect(toolSignal?.aborted).toBe(true)
  })

  it('ends with aborted when the caller aborts, before or during the run', async () => {
    const before = new AbortController()

    before.abort()

    let release: (() => void) | undefined

    const pending = controlledLoader(
      () =>
        new Promise(resolve => {
          release = () => resolve({ ok: true, payload: null, writes: null, output: [] })
        })
    )

    const during = new AbortController()
    const running = pending.execute('return 1', options({ signal: during.signal }))

    during.abort()

    expect(await vmExecutor.execute('return 1', options({ signal: before.signal }))).toMatchObject({
      error: { kind: 'aborted' }
    })
    expect(await running).toMatchObject({ ok: false, error: { kind: 'aborted' } })
    release?.()
  })

  it('maps malformed replies to sandbox errors', async () => {
    const malformed = controlledLoader(async () => ({ ok: 'yes' }))

    const badWrites = controlledLoader(async () => ({
      ok: true,
      payload: '1',
      writes: '[["k","{not json"]]',
      output: []
    }))

    expect(await malformed.execute('return 1', options())).toMatchObject({
      error: { kind: 'sandbox', message: 'The script returned a malformed result.' }
    })
    expect(await badWrites.execute('return 1', options())).toMatchObject({
      error: { kind: 'sandbox', message: 'The script reported store writes that are not JSON.' }
    })
  })

  it('decodes output items and drops unknown ones', async () => {
    const executor = controlledLoader(async () => ({
      ok: false,
      payload: JSON.stringify({ name: 'Error', message: 'boom', stack: 'Error: boom\n    at x' }),
      writes: null,
      output: [
        { type: 'text', text: 'a' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'audio', data: 'x' }
      ]
    }))

    expect(await executor.execute('return 1', options())).toEqual({
      ok: false,
      error: { kind: 'script', message: 'Error: boom', stack: 'Error: boom\n    at x' },
      output: [
        { type: 'text', text: 'a' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' }
      ]
    })
  })
})

type Host = { call(kind: string, name: string, argsJson: string | null): Promise<unknown> }

const isHost = (value: unknown): value is Host =>
  Predicate.hasProperty(value, 'call') && Predicate.isFunction(value.call)

type Runnable = { run(...args: ReadonlyArray<unknown>): Promise<unknown> }

const isRunnable = (value: unknown): value is Runnable =>
  Predicate.hasProperty(value, 'run') && Predicate.isFunction(value.run)

/**
 * `vmLoader` whose isolate reaches the host through `wrap(host)`: records each call's reply
 * promise (what the isolate waits on) or stands in for a failing RPC.
 */
const wrappingExecutor = (wrap: (host: Host) => Host) => {
  const loader: WorkerLoader = {
    load: code => ({
      getEntrypoint: () => {
        const instance = instantiate(code)

        if (!isRunnable(instance)) throw new Error('No run method')

        return {
          run: (host: unknown, ...rest: ReadonlyArray<unknown>) => {
            if (!isHost(host)) throw new Error('No host')

            return instance.run(wrap(host), ...rest)
          }
        }
      }
    })
  }

  return makeDynamicWorkerCodeModeExecutor({ loader: () => loader })
}

const recordingExecutor = () => {
  const replies: Array<Promise<unknown>> = []

  const executor = wrappingExecutor(host => ({
    call: (kind, name, argsJson) => {
      const reply = host.call(kind, name, argsJson)

      replies.push(reply)

      return reply
    }
  }))

  return { executor, replies }
}

const unsettled = Symbol('unsettled')

/** The reply, or `unsettled` when it is still pending after `ms`. */
const settledWithin = (reply: Promise<unknown> | undefined, ms = 200) =>
  Promise.race([
    reply ?? Promise.resolve(unsettled),
    new Promise(resolve => setTimeout(() => resolve(unsettled), ms))
  ])

const endedMessage =
  'The script ended before this call settled; await every tool call before returning.'

const endedToolReply = {
  ok: false,
  message: `${rejectionPrefix}${JSON.stringify({ message: endedMessage })}`
}

const endedGlobalReply = { ok: false, message: endedMessage }

/** A tool that never settles and records the signal it got. */
const hangingTool = (signals: Array<AbortSignal>) => ({
  name: 'slow',
  execute: (_args: unknown, { signal }: { readonly signal: AbortSignal }) => {
    signals.push(signal)

    return new Promise<unknown>(() => undefined)
  }
})

describe('Dynamic Worker limits and lifetime', () => {
  it('loads every script with a CPU limit, 500 ms unless configured', async () => {
    const codes: Array<WorkerLoaderCode> = []

    const loader: WorkerLoader = {
      load: code => {
        codes.push(code)

        return { getEntrypoint: () => instantiate(code) }
      }
    }

    const custom = makeDynamicWorkerCodeModeExecutor({ loader: () => loader, cpuMs: 25.7 })
    const fallback = makeDynamicWorkerCodeModeExecutor({ loader: () => loader })

    expect(await custom.execute('return 1', options())).toMatchObject({ ok: true, value: 1 })
    expect(await fallback.execute('return 1', options())).toMatchObject({ ok: true, value: 1 })
    expect(defaultDynamicWorkerCpuMs).toBe(500)
    expect(codes.map(code => code.limits)).toEqual([{ cpuMs: 25 }, { cpuMs: 500 }])
  })

  it('answers calls the script did not await once it returns', async () => {
    const { executor, replies } = recordingExecutor()
    const signals: Array<AbortSignal> = []

    const result = await executor.execute(
      // Not awaited; the catches only keep the VM's rejections handled.
      'tools.slow({}).catch(() => {})\nfind("x").catch(() => {})\nreturn 1',
      options({
        tools: [hangingTool(signals)],
        globals: [{ name: 'find', execute: () => new Promise(() => undefined) }]
      })
    )

    expect(result).toMatchObject({ ok: true, value: 1 })
    expect(replies).toHaveLength(2)
    expect(await settledWithin(replies[0])).toEqual(endedToolReply)
    expect(await settledWithin(replies[1])).toEqual(endedGlobalReply)
    expect(signals.map(signal => signal.aborted)).toEqual([true])
  })

  it('answers pending calls when the execution times out', async () => {
    const { executor, replies } = recordingExecutor()
    const signals: Array<AbortSignal> = []

    const result = await executor.execute(
      'await tools.slow({})',
      options({ timeoutMs: 50, tools: [hangingTool(signals)] })
    )

    expect(result.error?.kind).toBe('timeout')
    expect(await settledWithin(replies[0])).toEqual(endedToolReply)
    expect(signals[0]?.aborted).toBe(true)
  })

  it('answers pending calls when the caller aborts', async () => {
    const { executor, replies } = recordingExecutor()
    const controller = new AbortController()
    const signals: Array<AbortSignal> = []
    const slow = hangingTool(signals)

    const result = await executor.execute(
      'await tools.slow({})',
      options({
        signal: controller.signal,
        tools: [
          {
            name: 'slow',
            execute: (args, context) => {
              setTimeout(() => controller.abort(), 0)

              return slow.execute(args, context)
            }
          }
        ]
      })
    )

    expect(result.error?.kind).toBe('aborted')
    expect(await settledWithin(replies[0])).toEqual(endedToolReply)
    expect(signals[0]?.aborted).toBe(true)
  })

  it('rejects calls arriving after the execution ended without running them', async () => {
    let host: unknown
    let executed = 0

    const executor = controlledLoader(async received => {
      host = received

      return { ok: true, payload: null, writes: null, output: [] }
    })

    const result = await executor.execute(
      'return 1',
      options({
        tools: [{ name: 'write', execute: async () => executed++ }],
        globals: [{ name: 'find', execute: async () => executed++ }]
      })
    )

    expect(result.ok).toBe(true)

    if (!isHost(host)) throw new Error('The executor passed no host')

    expect(await host.call('call', 'write', '{}')).toEqual(endedToolReply)
    expect(await host.call('global', 'find', null)).toEqual(endedGlobalReply)
    expect(executed).toBe(0)
  })

  it('disposes the loaded Worker and its entrypoint however the execution ends', async () => {
    const disposed: Array<string> = []

    const disposingExecutor = (run: () => Promise<unknown>, throwing = false) => {
      const dispose = (name: string) => () => {
        disposed.push(name)

        if (throwing) throw new Error('dispose failed')
      }

      const loader: WorkerLoader = {
        load: () => ({
          getEntrypoint: () => ({ run, [Symbol.dispose]: dispose('entrypoint') }),
          [Symbol.dispose]: dispose('worker')
        })
      }

      return makeDynamicWorkerCodeModeExecutor({ loader: () => loader })
    }

    const done = async () => ({ ok: true, payload: '1', writes: null, output: [] })

    expect(await disposingExecutor(done).execute('return 1', options())).toMatchObject({
      ok: true,
      value: 1
    })
    expect(disposed.splice(0)).toEqual(['entrypoint', 'worker'])

    const hanging = disposingExecutor(() => new Promise(() => undefined))

    expect(await hanging.execute('return 1', options({ timeoutMs: 20 }))).toMatchObject({
      error: { kind: 'timeout' }
    })
    expect(disposed.splice(0)).toEqual(['entrypoint', 'worker'])

    expect(await disposingExecutor(done, true).execute('return 1', options())).toMatchObject({
      ok: true,
      value: 1
    })
    expect(disposed.splice(0)).toEqual(['entrypoint', 'worker'])
  })
})

describe('Dynamic Worker failures', () => {
  const secret = 'sk-live-0123456789'

  it('reports loader failures with a fixed message', async () => {
    const throwingLoader = makeDynamicWorkerCodeModeExecutor({
      loader: () => {
        throw new Error(`LOADER binding missing (${secret})`)
      }
    })

    const throwingEntrypoint = makeDynamicWorkerCodeModeExecutor({
      loader: () => ({
        load: () => ({
          getEntrypoint: () => {
            throw new Error(secret)
          }
        })
      })
    })

    for (const executor of [throwingLoader, throwingEntrypoint]) {
      expect(await executor.execute('return 1', options())).toEqual({
        ok: false,
        error: { kind: 'sandbox', message: 'Could not load the script sandbox.' },
        output: []
      })
    }
  })

  it('reports isolate failures with a fixed message', async () => {
    const executor = controlledLoader(async () => {
      throw new Error(`Internal error: ${secret}`)
    })

    expect(await executor.execute('return 1', options())).toEqual({
      ok: false,
      error: { kind: 'sandbox', message: 'The script sandbox failed.' },
      output: []
    })
  })

  it('reports an isolate past its CPU limit as a timeout', async () => {
    const cpuError = async () => {
      throw new Error('Worker exceeded CPU time limit.')
    }

    const loader: WorkerLoader = { load: () => ({ getEntrypoint: () => ({ run: cpuError }) }) }

    expect(await controlledLoader(cpuError).execute('return 1', options())).toEqual({
      ok: false,
      error: { kind: 'timeout', message: 'Execution exceeded its CPU limit of 500 ms' },
      output: []
    })
    expect(
      await makeDynamicWorkerCodeModeExecutor({ loader: () => loader, cpuMs: 30 }).execute(
        'return 1',
        options()
      )
    ).toMatchObject({
      error: { kind: 'timeout', message: 'Execution exceeded its CPU limit of 30 ms' }
    })
  })

  it('gives a call whose host RPC fails a fixed message', async () => {
    const executor = wrappingExecutor(() => ({
      call: async () => {
        throw new Error(`RPC failed: ${secret}`)
      }
    }))

    const result = await executor.execute(
      'try {\n  await tools.lookup({})\n} catch (error) {\n  return error.message\n}',
      options({ tools: [{ name: 'lookup', execute: async () => 'never' }] })
    )

    expect(result).toMatchObject({ ok: true, value: 'The call could not reach the host.' })
  })
})

describe('code mode on the Dynamic Worker executor', () => {
  it.live('rejects nested calls with the tool label and its model-visible error code', () =>
    Effect.gen(function* () {
      const limited = makeTool<TestContext, typeof QueryParams>({
        name: 'limited',
        description: 'Always rate limited',
        parameters: QueryParams,
        access: 'read',
        callableBy: 'codemode',
        execute: () =>
          Effect.fail(
            modelVisibleToolError({
              tool: 'limited',
              reason: 'not_found',
              code: 'rate_limited',
              message: 'Slow down'
            })
          )
      })

      const result = yield* runCode(
        [
          moduleOf('limits', [limited]),
          {
            id: 'codemode',
            tools: [makeCodeModeTool<TestContext>({ executor: vmExecutor })]
          }
        ],
        [
          'try {',
          '  await tools.limited({ query: "x" })',
          '} catch (error) {',
          '  return `${error.code}|${error.message}`',
          '}'
        ].join('\n')
      )

      expect(result.isError).not.toBe(true)
      expect(text(result.content)).toContain('rate_limited|tools.limited: Slow down')
    })
  )
})
