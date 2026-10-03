import { Effect, Fiber } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, it } from '@effect/vitest'
import { ToolResult, ToolResultMessage } from '@yolk-sdk/agent/protocol'
import {
  boundCodeModeSegments,
  codeModeStoreFromToolResults,
  defaultCodeModeLimits,
  makeCodeModeTool,
  summarizeCodeModeCalls,
  type CodeModeExecuteOptions,
  type CodeModeExecutionResult,
  type CodeModeExecutor,
  type CodeModeResultSegment
} from '../src/index.ts'
import { makeTool, type ToolRegistration } from '@yolk-sdk/agent/tools'
import {
  moduleOf,
  QueryParams,
  queryTool,
  runCode,
  text,
  type TestContext,
  type ToolLog
} from './fixtures.ts'

const capturingExecutor = (result: CodeModeExecutionResult | Error = { ok: true, output: [] }) => {
  const seen: Array<CodeModeExecuteOptions> = []

  const executor: CodeModeExecutor = {
    execute: (_code, options) => {
      seen.push(options)

      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
    }
  }

  return { executor, seen }
}

describe('makeCodeModeTool limits and plumbing', () => {
  it.effect('passes default limits, tools, globals, and an empty store', () =>
    Effect.gen(function* () {
      const { executor, seen } = capturingExecutor()

      yield* runCode(
        [
          moduleOf('host', [makeCodeModeTool<TestContext>({ executor })]),
          moduleOf('docs', [queryTool('my-tool')])
        ],
        'return 1'
      )

      expect(seen[0]?.timeoutMs).toBe(defaultCodeModeLimits.timeoutMs)
      expect(seen[0]?.memoryLimitBytes).toBe(64 * 1024 * 1024)
      expect(seen[0]?.store).toEqual({})
      expect(seen[0]?.tools.map(tool => [tool.name, tool.outputSchema])).toEqual([
        ['my-tool', { type: 'string' }]
      ])
      expect(seen[0]?.globals.map(global => global.name)).toEqual([
        'searchTools',
        'describeTool',
        'describeNamespace'
      ])
    })
  )

  it.effect('clamps the timeout to the host deadline minus a margin, never below one second', () =>
    Effect.gen(function* () {
      const { executor, seen } = capturingExecutor()

      // The test clock starts at epoch 0.
      const run = (deadline: number | undefined) =>
        runCode(
          [
            moduleOf('host', [
              makeCodeModeTool<TestContext>({
                executor,
                limits: { timeoutMs: 60_000 },
                deadline: () => deadline
              })
            ])
          ],
          'return 1'
        )

      yield* run(20_000)
      yield* run(2_000)
      yield* run(500_000)
      yield* run(undefined)

      expect(seen.map(options => options.timeoutMs)).toEqual([15_000, 1_000, 60_000, 60_000])
    })
  )

  it.effect('passes the loaded store and maps executor rejections to sandbox failures', () =>
    Effect.gen(function* () {
      const { executor, seen } = capturingExecutor(new Error('worker crashed'))

      const result = yield* runCode(
        [
          moduleOf('host', [
            makeCodeModeTool<TestContext>({
              executor,
              loadStore: () => Effect.succeed({ cursor: 'abc' })
            })
          ])
        ],
        'return 1'
      )

      expect(seen[0]?.store).toEqual({ cursor: 'abc' })
      expect(result.isError).toBe(true)
      expect(text(result.content)).toContain(
        'Script error: sandbox: The code mode executor failed: worker crashed'
      )
      expect(result.structuredContent).toEqual({ codemode: { ok: false } })
    })
  )

  it.effect('never reports store writes for failed scripts', () =>
    Effect.gen(function* () {
      const { executor } = capturingExecutor({
        ok: false,
        error: { kind: 'script', message: 'Error: nope' },
        output: [{ type: 'text', text: 'partial' }],
        storeWrites: { set: { leaked: true }, delete: [] }
      })

      const result = yield* runCode(
        [moduleOf('host', [makeCodeModeTool<TestContext>({ executor })])],
        'throw new Error("nope")'
      )

      expect(result.structuredContent).toEqual({ codemode: { ok: false } })
      expect(text(result.content)).toContain('Output:\npartial')
      expect(text(result.content)).toContain(
        'Tool calls made before the failure (they are not undone): none.'
      )
    })
  )
})

const callingExecutor = (
  script: (options: CodeModeExecuteOptions) => Promise<CodeModeExecutionResult>
): CodeModeExecutor => ({ execute: (_code, options) => script(options) })

const callFirstTool = (options: CodeModeExecuteOptions, args: unknown) => {
  const tool = options.tools[0]

  return tool === undefined
    ? Promise.reject(new Error('no tool'))
    : tool.execute(args, { signal: options.signal })
}

const settle = (promise: Promise<unknown>) =>
  promise.then(
    value => ({ ok: true as const, value }),
    (error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : ''
    })
  )

const rawTool = (
  name: string,
  execute: () => Effect.Effect<ToolResult>
): ToolRegistration<TestContext> =>
  makeTool<TestContext, typeof QueryParams>({
    name,
    description: `${name} tool`,
    parameters: QueryParams,
    access: 'read',
    execute
  })

describe('nested call failures, hooks, and backstops', () => {
  it.effect('rejects with "failed unexpectedly" and records an error when a nested tool dies', () =>
    Effect.gen(function* () {
      const executor = callingExecutor(async options => ({
        ok: true,
        value: await settle(callFirstTool(options, { query: 'x' })),
        output: []
      }))

      const result = yield* runCode(
        [
          moduleOf('host', [makeCodeModeTool<TestContext>({ executor })]),
          moduleOf('docs', [rawTool('dies', () => Effect.die(new Error('boom')))])
        ],
        'ignored'
      )

      expect(text(result.content)).toContain(
        'Return value:\n{"ok":false,"message":"tools.dies failed unexpectedly."}'
      )
      expect(result.nestedCalls?.calls.map(call => [call.name, call.status])).toEqual([
        ['dies', 'error']
      ])
    })
  )

  it.effect('prefixes error-result rejections with the tool but records the raw error', () =>
    Effect.gen(function* () {
      const executor = callingExecutor(async options => ({
        ok: true,
        value: [
          await settle(callFirstTool(options, { query: 'x' })),
          await settle(callFirstTool(options, { query: 'y' }))
        ],
        output: []
      }))

      const result = yield* runCode(
        [
          moduleOf('host', [makeCodeModeTool<TestContext>({ executor })]),
          moduleOf('docs', [
            rawTool('docs-lookup', () =>
              Effect.succeed(
                ToolResult.make({ toolCallId: 'x', content: 'Not found.', isError: true })
              )
            )
          ])
        ],
        'ignored'
      )

      expect(text(result.content)).toContain(
        'Return value:\n[{"ok":false,"message":"tools.docs_lookup: Not found."},{"ok":false,"message":"tools.docs_lookup: Not found."}]'
      )
      expect(result.nestedCalls?.calls.map(call => [call.status, call.error])).toEqual([
        ['error', 'Not found.'],
        ['error', 'Not found.']
      ])
    })
  )

  it.effect('rejects empty error results with the fallback text under the prefix', () =>
    Effect.gen(function* () {
      const executor = callingExecutor(async options => ({
        ok: true,
        value: await settle(callFirstTool(options, { query: 'x' })),
        output: []
      }))

      const result = yield* runCode(
        [
          moduleOf('host', [makeCodeModeTool<TestContext>({ executor })]),
          moduleOf('docs', [
            rawTool('silent', () =>
              Effect.succeed(ToolResult.make({ toolCallId: 'x', content: '', isError: true }))
            )
          ])
        ],
        'ignored'
      )

      expect(text(result.content)).toContain(
        '{"ok":false,"message":"tools.silent: Tool silent failed."}'
      )
      expect(result.nestedCalls?.calls[0]).toMatchObject({ status: 'error', error: '' })
    })
  )

  it.effect('reports cancellation only for interrupts', () =>
    Effect.gen(function* () {
      const executor = callingExecutor(async options => ({
        ok: true,
        value: await settle(callFirstTool(options, { query: 'x' })),
        output: []
      }))

      const result = yield* runCode(
        [
          moduleOf('host', [makeCodeModeTool<TestContext>({ executor })]),
          moduleOf('docs', [rawTool('interrupted', () => Effect.interrupt)])
        ],
        'ignored'
      )

      expect(text(result.content)).toContain('"message":"tools.interrupted was cancelled."')
      expect(result.nestedCalls?.calls[0]?.status).toBe('cancelled')
    })
  )

  it.effect('describeNamespace returns the module description', () =>
    Effect.gen(function* () {
      const executor = callingExecutor(async options => {
        const describe = options.globals.find(global => global.name === 'describeNamespace')

        return {
          ok: true,
          value: await describe?.execute('docs', { signal: options.signal }),
          output: []
        }
      })

      const result = yield* runCode(
        [
          moduleOf('host', [makeCodeModeTool<TestContext>({ executor })]),
          { id: 'docs', description: 'Product documentation', tools: [queryTool('lookup')] }
        ],
        'ignored'
      )

      expect(text(result.content)).toContain(
        'Return value:\n{"name":"docs","tools":[{"name":"lookup","description":"lookup tool"}],"description":"Product documentation"}'
      )
    })
  )

  it.effect('beforeNestedCall rejects a nested call without executing it', () =>
    Effect.gen(function* () {
      const log: ToolLog = []
      const seen: Array<string> = []

      const executor = callingExecutor(async options => ({
        ok: true,
        value: [
          await settle(callFirstTool(options, { query: 'allowed' })),
          await settle(callFirstTool(options, { query: 'denied' }))
        ],
        output: []
      }))

      const result = yield* runCode(
        [
          moduleOf('host', [
            makeCodeModeTool<TestContext>({
              executor,
              beforeNestedCall: ({ call, context }) =>
                Effect.suspend(() => {
                  seen.push(`${call.id}:${call.name}:${context.tenant}`)

                  return JSON.stringify(call.params).includes('denied')
                    ? Effect.fail('The run is no longer active.')
                    : Effect.void
                })
            })
          ]),
          moduleOf('docs', [queryTool('lookup', { log })])
        ],
        'ignored'
      )

      expect(seen).toEqual(['call_1/1:lookup:tenant_1', 'call_1/2:lookup:tenant_1'])
      expect(log).toEqual(['lookup:allowed:tenant_1'])
      // The script sees which call failed; the record keeps the raw message.
      expect(text(result.content)).toContain(
        '{"ok":false,"message":"tools.lookup: The run is no longer active."}'
      )
      expect(
        result.nestedCalls?.calls.map(call => [call.id, call.status, call.error ?? ''])
      ).toEqual([
        ['call_1/1', 'ok', ''],
        ['call_1/2', 'error', 'The run is no longer active.']
      ])
    })
  )

  it.effect('times out executors that ignore timeoutMs after the margin and aborts them', () =>
    Effect.gen(function* () {
      const signals: Array<AbortSignal> = []

      const executor = callingExecutor(options => {
        signals.push(options.signal)

        return new Promise<never>(() => {})
      })

      const fiber = yield* runCode(
        [
          moduleOf('host', [
            makeCodeModeTool<TestContext>({ executor, limits: { timeoutMs: 1_000 } })
          ])
        ],
        'ignored'
      ).pipe(Effect.forkChild)

      yield* TestClock.adjust('5999 millis')
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust('1 millis')

      const result = yield* Fiber.join(fiber)

      expect(result.isError).toBe(true)
      expect(text(result.content)).toContain(
        'Script error: timeout: Execution timed out after 1000 ms'
      )
      expect(signals[0]?.aborted).toBe(true)
    })
  )

  it.effect('bounds the wait for nested calls that ignore interruption', () =>
    Effect.gen(function* () {
      const executor = callingExecutor(options => {
        void callFirstTool(options, { query: 'x' }).catch(() => undefined)

        return Promise.resolve({ ok: true, output: [] })
      })

      const fiber = yield* runCode(
        [
          moduleOf('host', [makeCodeModeTool<TestContext>({ executor })]),
          moduleOf('docs', [rawTool('stuck', () => Effect.uninterruptible(Effect.never))])
        ],
        'ignored'
      ).pipe(Effect.forkChild)

      for (let step = 0; step < 4; step++) {
        yield* Effect.yieldNow
        yield* TestClock.adjust('5 seconds')
      }

      const result = yield* Fiber.join(fiber)

      expect(result.isError).toBeUndefined()
      expect(result.nestedCalls?.calls.map(call => [call.name, call.status])).toEqual([
        ['stuck', 'cancelled']
      ])
    })
  )
})

describe('result bounding', () => {
  const image: CodeModeResultSegment = { type: 'image', data: 'AAAA', mimeType: 'image/png' }

  it('keeps short results unchanged', () => {
    const segments: ReadonlyArray<CodeModeResultSegment> = [{ type: 'text', text: 'short' }, image]

    expect(boundCodeModeSegments(segments, 100)).toBe(segments)
  })

  it('keeps the head and tail and counts omitted characters and images', () => {
    const bounded = boundCodeModeSegments(
      [
        { type: 'text', text: 'H'.repeat(200) },
        image,
        { type: 'text', text: 'M'.repeat(1_000) },
        image,
        { type: 'text', text: 'T'.repeat(200) }
      ],
      280
    )

    const texts = bounded.flatMap(segment => (segment.type === 'text' ? [segment.text] : []))
    const joined = texts.join('')

    expect(joined.startsWith('H'.repeat(100))).toBe(true)
    expect(joined.endsWith('T'.repeat(100))).toBe(true)
    expect(joined).toContain('[… 1200 characters and 2 images omitted …]')
    expect(bounded.filter(segment => segment.type === 'image')).toHaveLength(0)
  })

  it('never splits surrogate pairs at the cut', () => {
    const bounded = boundCodeModeSegments([{ type: 'text', text: '😀'.repeat(200) }], 120)
    const joined = bounded.map(segment => (segment.type === 'text' ? segment.text : '')).join('')

    expect(joined).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    )
  })

  it('summarizes calls by tool and status in order of first appearance', () => {
    expect(
      summarizeCodeModeCalls([
        { name: 'send', status: 'ok' },
        { name: 'fetch', status: 'error' },
        { name: 'send', status: 'cancelled' },
        { name: 'send', status: 'ok' }
      ])
    ).toBe('send: 2 ok, 1 cancelled; fetch: 1 error')
  })
})

describe('codeModeStoreFromToolResults', () => {
  const result = (id: string, structuredContent: unknown) =>
    ToolResult.make({ toolCallId: id, content: 'x', structuredContent })

  const codemode = (id: string, structuredContent: unknown) => ({
    toolName: 'codemode',
    result: result(id, structuredContent)
  })

  it('applies the writes of successful scripts in order and skips everything else', () => {
    const store = codeModeStoreFromToolResults([
      codemode('a', { codemode: { ok: true, storeWrites: { set: { a: 1, b: 2 }, delete: [] } } }),
      codemode('b', { codemode: { ok: false, storeWrites: { set: { a: 99 }, delete: [] } } }),
      codemode('c', { other: true }),
      {
        toolName: 'codemode',
        result: ToolResultMessage.make({
          toolCallId: 'd',
          content: 'x',
          structuredContent: {
            codemode: { ok: true, storeWrites: { set: { c: 3 }, delete: ['b'] } }
          }
        })
      },
      codemode('e', { codemode: { ok: true } }),
      codemode('f', { codemode: { ok: true, storeWrites: { set: { a: [1] }, delete: [] } } })
    ])

    expect(store).toEqual({ a: [1], c: 3 })
  })

  it('ignores code-mode-shaped results of other tools and honors a custom tool name', () => {
    const spoofed = {
      toolName: 'web_fetch',
      result: result('s', {
        codemode: { ok: true, storeWrites: { set: { admin: true }, delete: ['a'] } }
      })
    }

    const entries = [
      codemode('a', { codemode: { ok: true, storeWrites: { set: { a: 1 }, delete: [] } } }),
      spoofed
    ]

    expect(codeModeStoreFromToolResults(entries)).toEqual({ a: 1 })
    expect(codeModeStoreFromToolResults(entries, { toolName: 'web_fetch' })).toEqual({
      admin: true
    })
  })

  it('drops writes beyond 256 KiB per value or 1 MiB in total, keeping previous values', () => {
    const value = (chars: number) => 'v'.repeat(chars - 2) // JSON adds two quotes.

    const store = codeModeStoreFromToolResults([
      codemode('a', {
        codemode: {
          ok: true,
          storeWrites: { set: { keep: 'old', pad: value(100_000) }, delete: [] }
        }
      }),
      codemode('b', {
        codemode: {
          ok: true,
          storeWrites: { set: { keep: value(256 * 1024 + 1), small: 1 }, delete: [] }
        }
      }),
      codemode('c', {
        codemode: {
          ok: true,
          storeWrites: {
            set: { k1: value(262_000), k2: value(262_000), k3: value(262_000), k4: value(262_000) },
            delete: []
          }
        }
      }),
      codemode('d', {
        codemode: { ok: true, storeWrites: { set: { k5: value(262_000) }, delete: ['k1'] } }
      })
    ])

    expect(store.keep).toBe('old')
    expect(store.small).toBe(1)
    // k4 would exceed 1 MiB with k1..k3 present; after deleting k1, k5 fits.
    expect(Object.keys(store).sort()).toEqual(['k2', 'k3', 'k5', 'keep', 'pad', 'small'])
  })
})
