import { constants, createContext, runInContext } from 'node:vm'
import { Effect, Predicate } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { modelVisibleToolError, makeTool } from '@yolk-sdk/agent/tools'
import {
  defaultDynamicWorkerCpuMs,
  makeDynamicWorkerCodeModeExecutor,
  maxDynamicWorkerHostCallFailureReports,
  type WorkerLoader,
  type WorkerLoaderCode
} from '../src/cloudflare.ts'
import { rejectionPrefix } from '../src/guard.ts'
import {
  makeCodeModeTool,
  type CodeModeExecuteOptions,
  type CodeModeInternalError,
  type CodeModeInternalErrorObserver
} from '../src/index.ts'
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

  // An ordinary global, as an isolate has: a contextified one mishandles the prelude making the
  // built-in globals read-only (`defineProperty` without a value stores `undefined`).
  const Script: unknown = runInContext(script, createContext(constants.DONT_CONTEXTIFY))

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

const controlledLoader = (
  run: (...args: ReadonlyArray<unknown>) => Promise<unknown>,
  onInternalError?: CodeModeInternalErrorObserver
) => {
  const loader: WorkerLoader = { load: () => ({ getEntrypoint: () => ({ run }) }) }

  return onInternalError === undefined
    ? makeDynamicWorkerCodeModeExecutor({ loader: () => loader })
    : makeDynamicWorkerCodeModeExecutor({ loader: () => loader, onInternalError })
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

  it('fails a script that prints past the output limit', async () => {
    const result = await vmExecutor.execute('while (true) console.log("")', options())

    expect(result).toMatchObject({ ok: false, error: { kind: 'script' } })
    expect(result.error?.message).toContain('script output exceeded the limit')
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

type Host = {
  call(kind: string, name: string, argsJson: string | null): Promise<unknown>
  reportCallFailure?(cause: unknown): Promise<void>
}

const isHost = (value: unknown): value is Host =>
  Predicate.hasProperty(value, 'call') && Predicate.isFunction(value.call)

type Runnable = { run(...args: ReadonlyArray<unknown>): Promise<unknown> }

const isRunnable = (value: unknown): value is Runnable =>
  Predicate.hasProperty(value, 'run') && Predicate.isFunction(value.run)

/**
 * `vmLoader` whose isolate reaches the host through `wrap(host)`: records each call's reply
 * promise (what the isolate waits on) or stands in for a failing RPC.
 */
const wrappingExecutor = (
  wrap: (host: Host) => Host,
  onInternalError?: CodeModeInternalErrorObserver
) => {
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

  return onInternalError === undefined
    ? makeDynamicWorkerCodeModeExecutor({ loader: () => loader })
    : makeDynamicWorkerCodeModeExecutor({ loader: () => loader, onInternalError })
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

describe('Dynamic Worker internal errors (onInternalError)', () => {
  const secret = 'sk-live-0123456789'

  /** An observer recording every report. */
  const observed = () => {
    const reports: Array<CodeModeInternalError> = []

    return { reports, observe: (error: CodeModeInternalError) => void reports.push(error) }
  }

  /** A host whose RPC fails with `cause`; the isolate still reaches `reportCallFailure`. */
  const failingHost =
    (cause: Error) =>
    (host: Host): Host => ({
      call: async () => {
        throw cause
      },
      reportCallFailure: async reported => {
        await host.reportCallFailure?.(reported)
      }
    })

  const lookupTool = { name: 'lookup', execute: async () => 'never' }

  const catchingScript =
    'try {\n  await tools.lookup({})\n} catch (error) {\n  return error.message\n}'

  it('reports loader failures as load with the original error', async () => {
    const { reports, observe } = observed()
    const bindingError = new Error(`LOADER binding missing (${secret})`)
    const entrypointError = new Error(secret)

    const throwingLoader = makeDynamicWorkerCodeModeExecutor({
      loader: () => {
        throw bindingError
      },
      onInternalError: observe
    })

    const throwingEntrypoint = makeDynamicWorkerCodeModeExecutor({
      loader: () => ({
        load: () => ({
          getEntrypoint: () => {
            throw entrypointError
          }
        })
      }),
      onInternalError: observe
    })

    for (const executor of [throwingLoader, throwingEntrypoint]) {
      expect(await executor.execute('return 1', options())).toEqual({
        ok: false,
        error: { kind: 'sandbox', message: 'Could not load the script sandbox.' },
        output: []
      })
    }

    expect(reports).toHaveLength(2)
    expect(reports[0]).toEqual({ stage: 'load', cause: bindingError })
    expect(reports[0]?.cause).toBe(bindingError)
    expect(reports[1]?.cause).toBe(entrypointError)
  })

  it('reports isolate failures, rejected or thrown, as isolate with the original error', async () => {
    const { reports, observe } = observed()
    const rejected = new Error(`Internal error: ${secret}`)
    const thrown = new Error(`Network connection lost: ${secret}`)

    const rejecting = controlledLoader(async () => {
      throw rejected
    }, observe)

    const throwing = controlledLoader(() => {
      throw thrown
    }, observe)

    for (const executor of [rejecting, throwing]) {
      expect(await executor.execute('return 1', options())).toEqual({
        ok: false,
        error: { kind: 'sandbox', message: 'The script sandbox failed.' },
        output: []
      })
    }

    expect(reports.map(report => report.stage)).toEqual(['isolate', 'isolate'])
    expect(reports[0]?.cause).toBe(rejected)
    expect(reports[1]?.cause).toBe(thrown)
  })

  it('reports an isolate past its CPU limit as cpu-limit with the original error', async () => {
    const { reports, observe } = observed()
    const cpuError = new Error('Worker exceeded CPU time limit.')

    const executor = controlledLoader(async () => {
      throw cpuError
    }, observe)

    expect(await executor.execute('return 1', options())).toEqual({
      ok: false,
      error: { kind: 'timeout', message: 'Execution exceeded its CPU limit of 500 ms' },
      output: []
    })
    expect(reports).toHaveLength(1)
    expect(reports[0]?.stage).toBe('cpu-limit')
    expect(reports[0]?.cause).toBe(cpuError)
  })

  it('reports a failed host RPC as host-call with the error the isolate saw', async () => {
    const { reports, observe } = observed()
    const rpcError = new Error(`RPC failed: ${secret}`)

    const result = await wrappingExecutor(failingHost(rpcError), observe).execute(
      catchingScript,
      options({ tools: [lookupTool] })
    )

    expect(result).toMatchObject({ ok: true, value: 'The call could not reach the host.' })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(reports).toHaveLength(1)
    expect(reports[0]?.stage).toBe('host-call')
    expect(reports[0]?.cause).toBe(rpcError)
  })

  it('reports at most a bounded number of host-call failures per execution', async () => {
    const { reports, observe } = observed()
    const calls = maxDynamicWorkerHostCallFailureReports + 5

    const result = await wrappingExecutor(failingHost(new Error(secret)), observe).execute(
      [
        'let failed = 0',
        `for (let i = 0; i < ${calls}; i++) await tools.lookup({}).catch(() => failed++)`,
        'return failed'
      ].join('\n'),
      options({ tools: [lookupTool] })
    )

    expect(result).toMatchObject({ ok: true, value: calls })
    expect(maxDynamicWorkerHostCallFailureReports).toBe(10)
    expect(reports).toHaveLength(maxDynamicWorkerHostCallFailureReports)
    expect(reports.every(report => report.stage === 'host-call')).toBe(true)
  })

  it('ignores an observer that throws or rejects', async () => {
    let calls = 0

    const throwing: CodeModeInternalErrorObserver = () => {
      calls++

      throw new Error('observer failed')
    }

    // Assignable to the `void` observer type; its rejection must not go unhandled.
    const rejecting = async () => {
      calls++

      throw new Error('observer rejected')
    }

    for (const observe of [throwing, rejecting]) {
      const loadFailure = makeDynamicWorkerCodeModeExecutor({
        loader: () => {
          throw new Error(secret)
        },
        onInternalError: observe
      })

      const isolateFailure = controlledLoader(async () => {
        throw new Error(secret)
      }, observe)

      const cpuFailure = controlledLoader(async () => {
        throw new Error('exceeded CPU time limit')
      }, observe)

      expect(await loadFailure.execute('return 1', options())).toEqual({
        ok: false,
        error: { kind: 'sandbox', message: 'Could not load the script sandbox.' },
        output: []
      })
      expect(await isolateFailure.execute('return 1', options())).toEqual({
        ok: false,
        error: { kind: 'sandbox', message: 'The script sandbox failed.' },
        output: []
      })
      expect(await cpuFailure.execute('return 1', options())).toEqual({
        ok: false,
        error: { kind: 'timeout', message: 'Execution exceeded its CPU limit of 500 ms' },
        output: []
      })
      expect(
        await wrappingExecutor(failingHost(new Error(secret)), observe).execute(
          catchingScript,
          options({ tools: [lookupTool] })
        )
      ).toMatchObject({ ok: true, value: 'The call could not reach the host.' })
    }

    expect(calls).toBe(8)
  })

  it('is not called for script errors, rejections, timeouts or aborts', async () => {
    const { reports, observe } = observed()

    const executor = makeDynamicWorkerCodeModeExecutor({
      loader: () => vmLoader,
      onInternalError: observe
    })

    const rejectingTool = {
      name: 'lookup',
      execute: async () => {
        throw new Error('not found')
      }
    }

    const rejectingGlobal = {
      name: 'find',
      execute: async () => {
        throw new Error('no match')
      }
    }

    expect(await executor.execute('throw new Error("boom")', options())).toMatchObject({
      error: { kind: 'script' }
    })
    expect(await executor.execute('return (', options())).toMatchObject({
      error: { kind: 'script' }
    })
    expect(
      await executor.execute('await tools.lookup({})', options({ tools: [rejectingTool] }))
    ).toMatchObject({ error: { kind: 'script', message: 'Error: not found' } })
    expect(
      await executor.execute('await find("x")', options({ globals: [rejectingGlobal] }))
    ).toMatchObject({ error: { kind: 'script' } })
    expect(
      await executor.execute(
        'await tools.slow({})',
        options({ timeoutMs: 20, tools: [hangingTool([])] })
      )
    ).toMatchObject({ error: { kind: 'timeout', message: 'Execution timed out after 20 ms' } })

    const before = new AbortController()

    before.abort()

    expect(await executor.execute('return 1', options({ signal: before.signal }))).toMatchObject({
      error: { kind: 'aborted' }
    })

    // An isolate failing after the execution timed out or was aborted is not reported: only the
    // failure that settled the execution is.
    const lateFailures: Array<() => void> = []

    const failingLate = controlledLoader(
      () =>
        new Promise((_resolve, reject) => {
          lateFailures.push(() => reject(new Error(`exceeded CPU time limit: ${secret}`)))
        }),
      observe
    )

    const during = new AbortController()
    const aborted = failingLate.execute('return 1', options({ signal: during.signal }))

    during.abort()

    expect(await aborted).toMatchObject({ error: { kind: 'aborted' } })
    expect(await failingLate.execute('return 1', options({ timeoutMs: 20 }))).toMatchObject({
      error: { kind: 'timeout', message: 'Execution timed out after 20 ms' }
    })

    for (const fail of lateFailures) fail()

    await new Promise(resolve => setTimeout(resolve, 10))
    expect(reports).toEqual([])

    // The same observer sees an isolate failure that settles an execution.
    const isolateError = new Error(secret)

    expect(
      await controlledLoader(async () => {
        throw isolateError
      }, observe).execute('return 1', options())
    ).toMatchObject({ error: { kind: 'sandbox' } })
    expect(reports).toEqual([{ stage: 'isolate', cause: isolateError }])
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
