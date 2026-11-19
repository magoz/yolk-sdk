import { createContext, runInContext } from 'node:vm'
import { Effect, Predicate } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { modelVisibleToolError, makeTool } from '@yolk-sdk/agent/tools'
import {
  makeDynamicWorkerCodeModeExecutor,
  type WorkerLoader,
  type WorkerLoaderCode
} from '../src/cloudflare.ts'
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
      globalOutbound: null
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

  it('maps loader failures and malformed replies to sandbox errors', async () => {
    const failing = makeDynamicWorkerCodeModeExecutor({
      loader: () => {
        throw new Error('LOADER binding missing')
      }
    })

    const malformed = controlledLoader(async () => ({ ok: 'yes' }))

    const badWrites = controlledLoader(async () => ({
      ok: true,
      payload: '1',
      writes: '[["k","{not json"]]',
      output: []
    }))

    expect(await failing.execute('return 1', options())).toMatchObject({
      error: { kind: 'sandbox', message: 'The script sandbox failed: LOADER binding missing' }
    })
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
