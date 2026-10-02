import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  ClassificationProviderError,
  ClassificationRequestInvalid,
  ClassificationResponseInvalid,
  type ClassificationError,
  type ClassificationRequest,
  type ClassificationResult
} from '@yolk-sdk/agent/classification'
import { ProviderErrorInfo, ToolCall } from '@yolk-sdk/agent/protocol'
import { makeClassifierTool, makeCodeModeTool } from '../src/index.ts'
import { makePiCodeModeExecutor } from '../src/node.ts'
import { context, moduleOf, runCode, text, type TestContext } from './fixtures.ts'

const answer = (request: ClassificationRequest): ClassificationResult => ({
  model: 'synthetic/classifier',
  answers: Object.fromEntries(
    Object.keys(request.questions).map(id => [id, { type: 'boolean', probability: 0.9 }])
  ),
  usage: { inputTokens: 10, outputTokens: 0, costUsd: 0.0001 }
})

const question = { urgent: { type: 'boolean', instructions: 'Is this urgent?' } } as const

describe('makeClassifierTool', () => {
  it('registers a listed, codemode-only read tool with request and result schemas', () => {
    const tool = makeClassifierTool<TestContext>({
      classify: request => Effect.succeed(answer(request))
    })

    expect(tool.def.name).toBe('classify')
    expect(tool.def.callableBy).toBe('codemode')
    expect(tool.def.discovery).toBe('listed')
    expect(tool.access).toBe('read')
    expect(tool.def.parameters).toMatchObject({ type: 'object', required: ['state', 'questions'] })
    expect(JSON.stringify(tool.def.parameters)).not.toContain('providerOptions')
    expect(tool.def.outputSchema).toMatchObject({ type: 'object', required: ['model', 'answers'] })
    expect(tool.def.description).toContain('at most 100 classifications of one script run at once')
  })

  it.live('classifies from scripts with compact answers, the full result, and usage', () =>
    Effect.gen(function* () {
      const seen: Array<ClassificationRequest> = []

      const tool = makeClassifierTool<TestContext>({
        classify: {
          classify: request =>
            Effect.sync(() => {
              seen.push(request)

              return answer(request)
            })
        }
      })

      const result = yield* runCode(
        [
          moduleOf('host', [makeCodeModeTool<TestContext>({ executor: makePiCodeModeExecutor() })]),
          moduleOf('ai', [tool])
        ],
        `const result = await tools.classify({ state: { subject: 'Server down' }, questions: ${JSON.stringify(question)} })
         return result.answers.urgent.probability`
      )

      expect(text(result.content)).toContain('Return value:\n0.9')
      expect(seen).toEqual([{ state: { subject: 'Server down' }, questions: question }])
      expect(result.nestedCalls?.calls[0]?.usage).toMatchObject({
        input: { total: 10 },
        output: { total: 0 }
      })
      expect(result.usage).toMatchObject({ input: { total: 10 }, output: { total: 0 } })
    })
  )

  it.live('caps concurrent classifications per script; each script gets its own cap', () =>
    Effect.gen(function* () {
      const active = new Map<string, number>()
      const peaks = new Map<string, number>()
      let total = 0
      let totalPeak = 0

      const tool = makeClassifierTool<TestContext>({
        maxConcurrency: 2,
        classify: request =>
          Effect.gen(function* () {
            const script = String(request.state).split(' ')[0] ?? ''
            const now = (active.get(script) ?? 0) + 1

            active.set(script, now)
            peaks.set(script, Math.max(peaks.get(script) ?? 0, now))
            total++
            totalPeak = Math.max(totalPeak, total)
            yield* Effect.sleep('100 millis')
            active.set(script, (active.get(script) ?? 1) - 1)
            total--

            return answer(request)
          })
      })

      const modules = [
        moduleOf('host', [makeCodeModeTool<TestContext>({ executor: makePiCodeModeExecutor() })]),
        moduleOf('ai', [tool])
      ]

      const script = (
        name: string
      ) => `const items = Array.from({ length: 6 }, (_, index) => '${name} item ' + index)
        const results = await Promise.all(items.map(state => tools.classify({ state, questions: ${JSON.stringify(question)} })))
        return results.length`

      const results = yield* Effect.all(
        [
          runCode(modules, script('a'), { callId: 'call_a' }),
          runCode(modules, script('b'), { callId: 'call_b' })
        ],
        { concurrency: 'unbounded' }
      )

      expect(results.map(result => text(result.content))).toEqual([
        expect.stringContaining('Return value:\n6'),
        expect.stringContaining('Return value:\n6')
      ])
      expect(peaks).toEqual(
        new Map([
          ['a', 2],
          ['b', 2]
        ])
      )
      expect(totalPeak).toBe(4)

      // Entries are cleaned up: a later script with the same call id starts with a fresh cap.
      const again = yield* runCode(modules, script('a'), { callId: 'call_a' })

      expect(text(again.content)).toContain('Return value:\n6')
    })
  )

  it.live('turns classifier errors into model-visible error results and keeps billed usage', () =>
    Effect.gen(function* () {
      const errors: ReadonlyArray<ClassificationError> = [
        ClassificationRequestInvalid.make({
          message: 'Invalid classification request: too many options'
        }),
        ClassificationProviderError.make({
          message: 'Classifier provider failed with status 503',
          retryable: true,
          provider: ProviderErrorInfo.make({
            provider: 'synthetic',
            kind: 'overloaded',
            status: 503
          })
        }),
        ClassificationResponseInvalid.make({
          message: 'Classification answers do not fit their questions: missing_answer',
          reason: 'missing_answer',
          questionId: 'urgent',
          usage: { inputTokens: 7, outputTokens: 0 }
        })
      ]

      let index = 0

      const tool = makeClassifierTool<TestContext>({
        classify: () => {
          const error = errors[index++]

          return error === undefined ? Effect.die(new Error('unexpected call')) : Effect.fail(error)
        }
      })

      const result = yield* runCode(
        [
          moduleOf('host', [makeCodeModeTool<TestContext>({ executor: makePiCodeModeExecutor() })]),
          moduleOf('ai', [tool])
        ],
        `const messages = []
         for (let i = 0; i < 3; i++) {
           try { await tools.classify({ state: 'x', questions: ${JSON.stringify(question)} }) }
           catch (error) { messages.push(error.message) }
         }
         return messages`
      )

      expect(text(result.content)).toContain(
        'Return value:\n["Invalid classification request: too many options","Classifier provider failed with status 503","Classification answers do not fit their questions: missing_answer"]'
      )
      expect(result.nestedCalls?.calls.map(call => call.status)).toEqual([
        'error',
        'error',
        'error'
      ])
      expect(result.nestedCalls?.calls[2]?.usage).toMatchObject({ input: { total: 7 } })
    })
  )

  it.effect('maps error reasons into structured model-visible errors', () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [ClassificationError, string]> = [
        [ClassificationRequestInvalid.make({ message: 'bad request' }), 'invalid_input'],
        [
          ClassificationProviderError.make({
            message: 'Classifier provider failed with status 429',
            retryable: true,
            provider: ProviderErrorInfo.make({ provider: 'synthetic', kind: 'rate_limit' })
          }),
          'unavailable'
        ]
      ]

      for (const [error, reason] of cases) {
        const tool = makeClassifierTool<TestContext>({
          name: 'triage',
          classify: () => Effect.fail(error)
        })

        const result = yield* tool.execute({
          call: ToolCall.make({
            id: 'call_x',
            name: 'triage',
            params: { state: 'x', questions: question }
          }),
          context
        })

        expect(result.isError).toBe(true)
        expect(result.content).toBe(error.message)
        expect(result.structuredContent).toEqual({
          type: 'model_visible_tool_error',
          tool: 'triage',
          reason,
          message: error.message
        })
        expect(result.usage).toBeUndefined()
      }
    })
  )

  it.live('rejects invalid requests before classifying', () =>
    Effect.gen(function* () {
      let calls = 0

      const tool = makeClassifierTool<TestContext>({
        classify: request =>
          Effect.sync(() => {
            calls++

            return answer(request)
          })
      })

      const result = yield* runCode(
        [
          moduleOf('host', [makeCodeModeTool<TestContext>({ executor: makePiCodeModeExecutor() })]),
          moduleOf('ai', [tool])
        ],
        `try {
           await tools.classify({ state: 'x', questions: { level: { type: 'score', instructions: 'How bad?', criteria: ['only one'] } }, providerOptions: {} })
         } catch (error) { return error.message }`
      )

      expect(calls).toBe(0)
      expect(text(result.content)).toContain('Invalid classify arguments')
    })
  )
})
