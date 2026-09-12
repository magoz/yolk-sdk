import { Effect, Layer, Predicate, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall, ToolDef, ToolResult, QuestionResponse } from '@yolk-sdk/agent/protocol'
import { LoopConfig, runToolBatch, ToolExecutor } from '../../src/loop/index.ts'

const question = ToolCall.make({
  id: 'question-call',
  name: 'question',
  params: { questions: [{ id: 'choice', prompt: 'Pick one', options: [{ id: 'a', label: 'A' }] }] }
})

describe('question capability boundary', () => {
  it.effect('rejects disabled questions before executor dispatch even with a replayed answer', () =>
    Effect.gen(function* () {
      let executed = 0

      const layer = Layer.merge(
        LoopConfig.defaultLayer,
        Layer.succeed(ToolExecutor, {
          execute: call =>
            Effect.sync(() => {
              executed++

              return ToolResult.make({ toolCallId: call.id, content: 'permissive executor' })
            })
        })
      )

      const answer = QuestionResponse.make({
        requestId: 'question:question-call',
        toolCallId: question.id,
        outcome: 'cancelled',
        source: 'user',
        answers: []
      })

      for (const hitlResponses of [[], [answer]]) {
        const events = yield* runToolBatch({ calls: [question], tools: [], hitlResponses }).pipe(
          Stream.runCollect,
          Effect.provide(layer)
        )

        expect(
          events.some(
            event =>
              Predicate.isTagged(event, 'QuestionRequested') ||
              Predicate.isTagged(event, 'AgentAwaitingInput')
          )
        ).toBe(false)
        expect(
          events.find(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))
        ).toMatchObject({
          result: {
            toolCallId: question.id,
            content: 'Question tool is unavailable',
            isError: true
          }
        })
      }

      expect(executed).toBe(0)

      const enabled = yield* runToolBatch({
        calls: [question],
        tools: [ToolDef.make({ name: 'question', description: 'Ask', parameters: {} })]
      }).pipe(Stream.runCollect, Effect.provide(layer))

      expect(enabled.some(event => Predicate.isTagged(event, 'QuestionRequested'))).toBe(true)
      expect(enabled.some(event => Predicate.isTagged(event, 'AgentAwaitingInput'))).toBe(true)
      expect(executed).toBe(0)
    })
  )
})
