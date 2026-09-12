import { Effect, Layer, Ref } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  QuestionAnswer,
  QuestionResponse,
  ToolApprovalPolicy,
  ToolApprovalResponse,
  ToolCall,
  ToolDef,
  type HitlRequest,
  type HitlResponse
} from '@yolk-sdk/agent/protocol'
import { LoopConfig } from '@yolk-sdk/agent/loop'
import { TestToolExecutor } from '@yolk-sdk/agent/loop/testing'
import { Driver } from '../src/driver.ts'
import { makeInMemoryHarnessLayer } from '../src/driver/memory.ts'
import { Inbox } from '../src/inbox.ts'
import { attemptToolBatch, resumeHitlIfMatched } from '../src/outcome.ts'

const weatherTool = ToolDef.make({
  name: 'weather',
  description: 'Get weather.',
  parameters: {},
  approval: ToolApprovalPolicy.make({ mode: 'manual', reason: 'external lookup' })
})

const questionTool = ToolDef.make({ name: 'question', description: 'Ask', parameters: {} })

const weatherCall = ToolCall.make({ id: 'call_1', name: 'weather', params: {} })

const questionCall = ToolCall.make({
  id: 'call_q',
  name: 'question',
  params: {
    questions: [{ id: 'choice', prompt: 'Pick one', options: [{ id: 'a', label: 'A' }] }]
  }
})

const tools = [weatherTool, questionTool]
const calls = [weatherCall, questionCall]
const loopLayer = Layer.mergeAll(
  TestToolExecutor.layer({ weather: '72F' }),
  LoopConfig.defaultLayer
)

describe('HITL loop bridge', () => {
  it.effect('protocol mismatch never resumes; matching approval and question execute once', () =>
    Effect.gen(function* () {
      const pending = yield* Ref.make<ReadonlyArray<HitlRequest>>([])
      const payloads = yield* Ref.make<ReadonlyMap<string, HitlResponse>>(new Map())
      const executed = yield* Ref.make<ReadonlyArray<string>>([])
      const drains = yield* Ref.make(0)
      const layer = makeInMemoryHarnessLayer({
        drain: (runId, _force, _scope, context) =>
          Effect.gen(function* () {
            yield* Ref.update(drains, count => count + 1)
            const inbox = yield* Inbox
            if (context.readyResponses.length > 0) {
              const stored = yield* Ref.get(payloads)
              const hitlResponses = context.readyResponses.flatMap(item => {
                const payload = stored.get(item.itemId)
                return payload === undefined ? [] : [payload]
              })
              const outcome = yield* attemptToolBatch({ calls, tools, hitlResponses }).pipe(
                Effect.provide(loopLayer),
                Effect.orDie
              )
              if (outcome._tag === 'Completed') {
                yield* Ref.set(
                  executed,
                  outcome.toolCalls.map(call => call.id)
                )
              }
              return
            }
            const outcome = yield* attemptToolBatch({ calls, tools }).pipe(
              Effect.provide(loopLayer),
              Effect.orDie
            )
            if (outcome._tag !== 'AwaitingInput') return
            yield* Ref.set(pending, outcome.requests)
            yield* inbox.park(
              runId,
              outcome.requests.map(request => request.requestId),
              context.drainToken
            )
          })
      })

      yield* Effect.gen(function* () {
        const driver = yield* Driver
        const inbox = yield* Inbox

        yield* driver.wake('run_1')
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(drains)).toBe(1)
        const parked = yield* inbox.parked('run_1')
        const requests = yield* Ref.get(pending)
        expect(parked).toBeDefined()
        expect(parked?.requestIds).toHaveLength(2)
        if (parked === undefined) return
        const approval = requests.find(request => request._tag === 'ToolApprovalRequest')
        const question = requests.find(request => request._tag === 'QuestionRequest')
        expect(approval).toBeDefined()
        expect(question).toBeDefined()
        if (approval === undefined || question === undefined) return

        const resumed = yield* Ref.make(false)
        const mismatch = yield* resumeHitlIfMatched({
          pending: requests,
          response: ToolApprovalResponse.make({
            requestId: 'missing',
            toolCallId: approval.toolCallId,
            decision: 'approved',
            source: 'user'
          }),
          resume: requestId =>
            Ref.set(resumed, true).pipe(
              Effect.andThen(
                driver.resumeHitl('run_1', {
                  itemId: 'item_a',
                  requestId,
                  generation: parked.generation
                })
              )
            )
        })
        expect(mismatch._tag).toBe('Mismatch')
        expect(yield* Ref.get(resumed)).toBe(false)
        expect(yield* Ref.get(drains)).toBe(1)

        const approvalResponse = ToolApprovalResponse.make({
          requestId: approval.requestId,
          toolCallId: approval.toolCallId,
          decision: 'approved',
          source: 'user'
        })
        yield* Ref.update(payloads, current => new Map(current).set('item_a', approvalResponse))
        const first = yield* resumeHitlIfMatched({
          pending: requests,
          response: approvalResponse,
          resume: requestId =>
            driver.resumeHitl('run_1', {
              itemId: 'item_a',
              requestId,
              generation: parked.generation
            })
        })
        expect(first._tag).toBe('Accepted')
        expect(yield* Ref.get(drains)).toBe(1)

        const questionResponse = QuestionResponse.make({
          requestId: question.requestId,
          toolCallId: question.toolCallId,
          outcome: 'answered',
          source: 'user',
          answers: [QuestionAnswer.make({ questionId: 'choice', optionIds: ['a'] })]
        })
        yield* Ref.update(payloads, current => new Map(current).set('item_q', questionResponse))
        const ready = yield* resumeHitlIfMatched({
          pending: requests,
          response: questionResponse,
          resume: requestId =>
            driver.resumeHitl('run_1', {
              itemId: 'item_q',
              requestId,
              generation: parked.generation
            })
        })
        expect(ready._tag).toBe('Ready')
        yield* driver.awaitIdle('run_1')
        expect(yield* Ref.get(drains)).toBe(2)
        expect(yield* Ref.get(executed)).toContain('call_1')
        expect(yield* inbox.parked('run_1')).toBeUndefined()
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect('denied approval is model-visible and does not execute the tool', () =>
    Effect.gen(function* () {
      const paused = yield* attemptToolBatch({
        calls: [weatherCall],
        tools: [weatherTool]
      })
      expect(paused._tag).toBe('AwaitingInput')
      if (paused._tag !== 'AwaitingInput') return
      const request = paused.requests[0]
      expect(request).toBeDefined()
      if (request === undefined) return
      const started = yield* Ref.make<ReadonlyArray<string>>([])
      const errorResults = yield* Ref.make<
        ReadonlyArray<{ readonly callId: string; readonly content: string }>
      >([])
      const denied = yield* attemptToolBatch(
        {
          calls: [weatherCall],
          tools: [weatherTool],
          hitlResponses: [
            ToolApprovalResponse.make({
              requestId: request.requestId,
              toolCallId: request.toolCallId,
              decision: 'denied',
              source: 'user',
              reason: 'nope'
            })
          ]
        },
        {
          onEvent: event => {
            if (event._tag === 'ToolExecutionStarted') {
              return Ref.update(started, current => [...current, event.call.id])
            }
            if (event._tag === 'ToolExecutionCompleted' && event.result.isError === true) {
              return Ref.update(errorResults, current => [
                ...current,
                { callId: event.call.id, content: String(event.result.content) }
              ])
            }
            return Effect.void
          }
        }
      )
      expect(denied._tag).toBe('Completed')
      expect(yield* Ref.get(started)).toEqual([])
      const errors = yield* Ref.get(errorResults)
      expect(errors).toHaveLength(1)
      expect(errors[0]?.callId).toBe('call_1')
      expect(errors[0]?.content.includes('nope')).toBe(true)
    }).pipe(Effect.provide(loopLayer))
  )

  it.effect('cancelled question is a model-visible error and does not execute tools', () =>
    Effect.gen(function* () {
      const paused = yield* attemptToolBatch({
        calls: [questionCall],
        tools: [questionTool]
      })
      expect(paused._tag).toBe('AwaitingInput')
      if (paused._tag !== 'AwaitingInput') return
      const request = paused.requests[0]
      expect(request).toBeDefined()
      if (request === undefined) return
      const started = yield* Ref.make<ReadonlyArray<string>>([])
      const cancelled = yield* attemptToolBatch(
        {
          calls: [questionCall],
          tools: [questionTool],
          hitlResponses: [
            QuestionResponse.make({
              requestId: request.requestId,
              toolCallId: request.toolCallId,
              outcome: 'cancelled',
              source: 'user',
              reason: 'never mind'
            })
          ]
        },
        {
          onEvent: event =>
            event._tag === 'ToolExecutionStarted'
              ? Ref.update(started, current => [...current, event.call.id])
              : event._tag === 'ToolExecutionCompleted' && event.result.isError === true
                ? Ref.update(started, current => [
                    ...current,
                    `error:${String(event.result.content)}`
                  ])
                : Effect.void
        }
      )
      expect(cancelled._tag).toBe('Completed')
      const recorded = yield* Ref.get(started)
      expect(recorded.some(item => item.startsWith('error:') && item.includes('cancelled'))).toBe(
        true
      )
      expect(recorded.filter(item => !item.startsWith('error:'))).toEqual([])
    }).pipe(Effect.provide(loopLayer))
  )
})
