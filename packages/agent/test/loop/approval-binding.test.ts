/**
 * Approval binds the call, not the tool's current policy. Hosts re-read tool policy at execution,
 * so a tool can stop requiring approval between the request and the human's answer. A recorded
 * answer must still win (a denial is never ignored), and an unanswered request from the resumed
 * pause must stay pending.
 */
import { Effect, Layer, Predicate, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  ToolApprovalPolicy,
  ToolApprovalResponse,
  ToolCall,
  ToolDef,
  UserMessage
} from '@yolk-sdk/agent/protocol'
import type { AgentEvent, HitlRequest } from '@yolk-sdk/agent/protocol'
import { ContextTransformer, LoopConfig, run, runToolBatch } from '../../src/loop'
import { FauxProvider, Reply, TestToolExecutor, type FauxResponse } from '../../src/loop/testing'

const call = ToolCall.make({ id: 'call_1', name: 'delete_file', params: { path: 'a.txt' } })

const gated = ToolDef.make({
  name: 'delete_file',
  description: 'Delete a file.',
  parameters: {},
  approval: ToolApprovalPolicy.make({ mode: 'manual', reason: 'destructive' })
})

/** The same tool after the host flipped its policy to automatic. */
const flipped = ToolDef.make({ name: 'delete_file', description: 'Delete a file.', parameters: {} })

const approved = () =>
  ToolApprovalResponse.make({
    requestId: 'approval:call_1',
    toolCallId: call.id,
    decision: 'approved',
    source: 'user'
  })

const denied = () =>
  ToolApprovalResponse.make({
    requestId: 'approval:call_1',
    toolCallId: call.id,
    decision: 'denied',
    source: 'user',
    reason: 'keep it'
  })

const tags = (events: ReadonlyArray<AgentEvent>) => events.map(event => event._tag)

const started = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap(event =>
    Predicate.isTagged(event, 'ToolExecutionStarted') ? [event.call.id] : []
  )

const awaitingRequestsOf = (events: ReadonlyArray<AgentEvent>): ReadonlyArray<HitlRequest> =>
  events.flatMap(event => (Predicate.isTagged(event, 'AgentAwaitingInput') ? event.requests : []))

const batch = (config: Omit<Parameters<typeof runToolBatch>[0], 'calls'>) =>
  runToolBatch({ calls: [call], ...config }).pipe(
    Stream.runCollect,
    Effect.map(chunk => Array.from(chunk)),
    Effect.provide(TestToolExecutor.layer({ delete_file: 'deleted' })),
    Effect.provide(LoopConfig.defaultLayer)
  )

/** The first tool step: the gated call pauses for approval. */
const requestApproval = batch({ tools: [gated] }).pipe(Effect.map(awaitingRequestsOf))

describe('approval binds the call across a policy change', () => {
  it.effect('requested, policy flips to auto, answered deny: not executed', () =>
    Effect.gen(function* () {
      const awaitingRequests = yield* requestApproval

      expect(awaitingRequests).toMatchObject([{ requestId: 'approval:call_1' }])

      for (const config of [
        { tools: [flipped], hitlResponses: [denied()], awaitingRequests },
        // The denial wins without the pause record too.
        { tools: [flipped], hitlResponses: [denied()] }
      ]) {
        const events = yield* batch(config)

        expect(started(events)).toEqual([])
        expect(tags(events)).toEqual(['ToolApprovalDenied', 'ToolExecutionCompleted'])
        expect(
          events.find(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))
        ).toMatchObject({
          result: { toolCallId: 'call_1', isError: true, content: 'Tool call denied: keep it' }
        })
      }
    })
  )

  it.effect('requested, policy flips to auto, answered approve: executed once', () =>
    Effect.gen(function* () {
      const awaitingRequests = yield* requestApproval

      const events = yield* batch({
        tools: [flipped],
        hitlResponses: [approved()],
        awaitingRequests
      })

      expect(tags(events)).toContain('ToolApprovalGranted')
      expect(started(events)).toEqual(['call_1'])
    })
  )

  it.effect('requested, policy flips to auto, unanswered: stays pending, not executed', () =>
    Effect.gen(function* () {
      const awaitingRequests = yield* requestApproval

      const events = yield* batch({ tools: [flipped], hitlResponses: [], awaitingRequests })

      expect(started(events)).toEqual([])
      expect(tags(events)).toEqual(['ToolApprovalRequested', 'AgentAwaitingInput'])
      // The same request, with the policy it was asked under.
      expect(awaitingRequestsOf(events)).toEqual(awaitingRequests)
    })
  )

  it.effect('an unanswered request also fences an approved sibling', () =>
    Effect.gen(function* () {
      const sibling = ToolCall.make({ id: 'call_2', name: 'delete_file', params: { path: 'b' } })

      const first = yield* runToolBatch({ calls: [call, sibling], tools: [gated] }).pipe(
        Stream.runCollect,
        Effect.map(chunk => awaitingRequestsOf(Array.from(chunk))),
        Effect.provide(TestToolExecutor.layer({ delete_file: 'deleted' })),
        Effect.provide(LoopConfig.defaultLayer)
      )

      const events = yield* runToolBatch({
        calls: [call, sibling],
        tools: [flipped],
        hitlResponses: [approved()],
        awaitingRequests: first
      }).pipe(
        Stream.runCollect,
        Effect.map(chunk => Array.from(chunk)),
        Effect.provide(TestToolExecutor.layer({ delete_file: 'deleted' })),
        Effect.provide(LoopConfig.defaultLayer)
      )

      expect(started(events)).toEqual([])
      expect(awaitingRequestsOf(events)).toMatchObject([{ requestId: 'approval:call_2' }])
    })
  )

  it.effect('run resumes a paused transcript with the same binding', () =>
    Effect.gen(function* () {
      const user = UserMessage.make({ content: 'delete a.txt' })

      const layer = (replies: ReadonlyArray<FauxResponse>) =>
        Layer.mergeAll(
          FauxProvider.layer(...replies),
          TestToolExecutor.layer({ delete_file: 'deleted' })
        ).pipe(
          Layer.provideMerge(Layer.mergeAll(ContextTransformer.identity, LoopConfig.defaultLayer))
        )

      const paused = Array.from(
        yield* run({
          messages: [user],
          systemPrompt: 'Use tools.',
          tools: [gated],
          model: 'faux'
        }).pipe(
          Stream.runCollect,
          Effect.provide(layer([Reply.toolCall({ id: 'call_1', name: 'delete_file', params: {} })]))
        )
      )

      const awaiting = paused.find(event => Predicate.isTagged(event, 'AgentAwaitingInput'))

      if (awaiting === undefined || !Predicate.isTagged(awaiting, 'AgentAwaitingInput')) {
        return expect.fail('expected a pause')
      }

      const resume = (hitlResponses: ReadonlyArray<ToolApprovalResponse>) =>
        run({
          messages: [user, ...awaiting.messages],
          systemPrompt: 'Use tools.',
          tools: [flipped],
          hitlResponses,
          awaitingRequests: awaiting.requests,
          model: 'faux'
        }).pipe(
          Stream.runCollect,
          Effect.map(chunk => Array.from(chunk)),
          Effect.provide(layer([Reply.text('done')]))
        )

      const unanswered = yield* resume([])

      expect(started(unanswered)).toEqual([])
      expect(tags(unanswered).at(-1)).toBe('AgentAwaitingInput')

      const refused = yield* resume([denied()])

      expect(started(refused)).toEqual([])
      expect(tags(refused)).toContain('ToolApprovalDenied')
      expect(tags(refused).at(-1)).toBe('AgentEnd')
    })
  )
})
