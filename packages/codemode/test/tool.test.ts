import { Effect } from 'effect'
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
import { moduleOf, queryTool, runCode, text, type TestContext } from './fixtures.ts'

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

  it('applies the writes of successful scripts in order and skips everything else', () => {
    const store = codeModeStoreFromToolResults([
      result('a', { codemode: { ok: true, storeWrites: { set: { a: 1, b: 2 }, delete: [] } } }),
      result('b', { codemode: { ok: false, storeWrites: { set: { a: 99 }, delete: [] } } }),
      result('c', { other: true }),
      ToolResultMessage.make({
        toolCallId: 'd',
        content: 'x',
        structuredContent: { codemode: { ok: true, storeWrites: { set: { c: 3 }, delete: ['b'] } } }
      }),
      result('e', { codemode: { ok: true } }),
      result('f', { codemode: { ok: true, storeWrites: { set: { a: [1] }, delete: [] } } })
    ])

    expect(store).toEqual({ a: [1], c: 3 })
  })
})
