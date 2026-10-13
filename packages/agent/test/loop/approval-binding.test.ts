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
  ToolApprovalRequest,
  ToolApprovalResponse,
  ToolCall,
  ToolDef,
  ToolValueChange,
  UserMessage,
  type ToolChangePreview
} from '@yolk-sdk/agent/protocol'
import type { AgentEvent, HitlRequest } from '@yolk-sdk/agent/protocol'
import { ContextTransformer, LoopConfig, prepareToolBatch, run, runToolBatch } from '../../src/loop'
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

  it.effect('a fresh model turn with a reused call id follows the policy, not old answers', () =>
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        FauxProvider.layer(
          Reply.toolCall({ id: 'call_1', name: 'delete_file', params: {} }),
          Reply.text('done')
        ),
        TestToolExecutor.layer({ delete_file: 'deleted' })
      ).pipe(
        Layer.provideMerge(Layer.mergeAll(ContextTransformer.identity, LoopConfig.defaultLayer))
      )

      // Answers to an earlier turn's call_1, which the provider reuses for a new call.
      for (const stale of [denied(), approved()]) {
        const events = Array.from(
          yield* run({
            messages: [UserMessage.make({ content: 'delete a.txt' })],
            systemPrompt: 'Use tools.',
            tools: [flipped],
            hitlResponses: [stale],
            model: 'faux'
          }).pipe(Stream.runCollect, Effect.provide(layer))
        )

        expect(started(events)).toEqual(['call_1'])
        expect(tags(events)).not.toContain('ToolApprovalDenied')
        expect(tags(events)).not.toContain('ToolApprovalGranted')
      }
    })
  )

  it.effect('reuses an outstanding request only while it still describes the call', () =>
    Effect.gen(function* () {
      const awaitingRequests = yield* requestApproval

      const changedParams = ToolCall.make({
        id: 'call_1',
        name: 'delete_file',
        params: { path: 'b' }
      })

      const changedName = ToolCall.make({
        id: 'call_1',
        name: 'remove_file',
        params: { path: 'a.txt' }
      })

      const removeFile = ToolDef.make({
        name: 'remove_file',
        description: 'Remove.',
        parameters: {}
      })

      for (const changed of [changedParams, changedName]) {
        const prepared = yield* prepareToolBatch({
          calls: [changed],
          tools: [flipped, removeFile],
          responses: [],
          awaitingRequests
        })

        expect(prepared.callsToExecute).toEqual([])
        expect(prepared.pendingRequests).toHaveLength(1)
        // A fresh request for the call as it is now, not the outstanding one.
        expect(prepared.pendingRequests[0]).toMatchObject({
          requestId: 'approval:call_1',
          call: changed
        })
        // A reused request keeps the policy it was asked under; a fresh one has today's (none).
        expect(prepared.pendingRequests[0]).not.toMatchObject({ policy: { mode: 'manual' } })
      }

      const same = yield* prepareToolBatch({
        calls: [call],
        tools: [flipped],
        responses: [],
        awaitingRequests
      })

      expect(same.pendingRequests).toEqual(awaitingRequests)
      expect(same.pendingRequests[0]).toMatchObject({ policy: { mode: 'manual' } })
    })
  )

  it.effect('recomputes a reused request preview, or drops it without a previewer', () =>
    Effect.gen(function* () {
      const preview = (label: string): ToolChangePreview => ({
        target: { label },
        changes: [
          ToolValueChange.make({ field: 'path', label: 'Path', before: 'a.txt', after: '' })
        ]
      })

      const outstanding = ToolApprovalRequest.make({
        requestId: 'approval:call_1',
        toolCallId: 'call_1',
        call,
        policy: gated.approval,
        preview: preview('old')
      })

      const dropped = yield* prepareToolBatch({
        calls: [call],
        tools: [flipped],
        responses: [],
        awaitingRequests: [outstanding]
      })

      expect(dropped.pendingRequests[0]).toMatchObject({ requestId: 'approval:call_1' })
      expect(dropped.pendingRequests[0]).not.toHaveProperty('preview')

      const recomputed = yield* prepareToolBatch({
        calls: [call],
        tools: [flipped],
        responses: [],
        awaitingRequests: [outstanding],
        approvalPreviews: { delete_file: () => Effect.succeed(preview('new')) }
      })

      expect(recomputed.pendingRequests[0]).toMatchObject({ preview: { target: { label: 'new' } } })
    })
  )

  it.effect('ignores outstanding requests of calls that are not in the batch', () =>
    Effect.gen(function* () {
      const awaitingRequests = yield* requestApproval
      const other = ToolCall.make({ id: 'call_9', name: 'delete_file', params: {} })

      const prepared = yield* prepareToolBatch({
        calls: [other],
        tools: [flipped],
        responses: [],
        awaitingRequests
      })

      expect(prepared.pendingRequests).toEqual([])
      expect(prepared.callsToExecute).toEqual([{ index: 0, call: other }])
    })
  )

  it.effect('a background-v1 mode flip keeps a denial and re-asks an unanswered request', () =>
    Effect.gen(function* () {
      const background = ToolDef.make({
        name: 'work',
        description: 'Work.',
        parameters: {},
        execution: 'background-v1',
        approval: ToolApprovalPolicy.make({ mode: 'manual' })
      })

      // The same tool, now foreground and automatic.
      const foreground = ToolDef.make({ name: 'work', description: 'Work.', parameters: {} })

      const work = ToolCall.make({
        id: 'bg',
        name: 'work',
        params: { execution: 'background', arguments: { value: 'x' } }
      })

      const paused = yield* prepareToolBatch({ calls: [work], tools: [background], responses: [] })
      const [request] = paused.pendingRequests

      expect(request?.requestId).toMatch(/^approval:bg:background-v1:/)

      const deniedAfterFlip = yield* prepareToolBatch({
        calls: [work],
        tools: [foreground],
        responses: [
          ToolApprovalResponse.make({
            requestId: request?.requestId ?? '',
            toolCallId: 'bg',
            decision: 'denied',
            source: 'user'
          })
        ]
      })

      expect(deniedAfterFlip.callsToExecute).toEqual([])
      expect(deniedAfterFlip.resultMessages).toMatchObject([
        { message: { toolCallId: 'bg', isError: true } }
      ])

      const unanswered = yield* prepareToolBatch({
        calls: [work],
        tools: [foreground],
        responses: [],
        awaitingRequests: paused.pendingRequests
      })

      expect(unanswered.callsToExecute).toEqual([])
      expect(unanswered.pendingRequests).toMatchObject([{ requestId: 'approval:bg' }])
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
