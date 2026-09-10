import { Effect, Layer, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  BackgroundToolAccepted,
  ToolApprovalPolicy,
  ToolApprovalResponse,
  ToolCall,
  ToolResult,
  UserMessage,
  zeroAgentUsage
} from '@yolk-sdk/agent/protocol'
import {
  ContextTransformer,
  LoopConfig,
  prepareToolBatch,
  run,
  runToolBatch,
  ToolError,
  type LLMRequest
} from '../../src/loop/index.ts'
import { FauxProvider, Reply } from '../../src/loop/testing/index.ts'
import {
  makeTool,
  makeToolExecutorLayer,
  resolveTools,
  type BackgroundToolHost
} from '../../src/tools/index.ts'

const call = (id = 'bg', mode = 'background', value = 'work') =>
  ToolCall.make({ id, name: 'work', params: { execution: mode, arguments: { value } } })
const receipt = BackgroundToolAccepted.make({ version: 1, executionId: 'owner:bg' })
const setFor = (host: BackgroundToolHost<unknown>, manual = false) =>
  resolveTools(
    [
      {
        id: 'test',
        tools: [
          makeTool({
            name: 'work',
            description: '',
            access: 'write',
            background: true,
            ...(manual ? { approval: ToolApprovalPolicy.make({ mode: 'manual' }) } : {}),
            parameters: Schema.Struct({ value: Schema.String }),
            execute: ({ call }) =>
              Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'inline' }))
          })
        ]
      }
    ],
    {},
    { backgroundHost: host }
  )

const response = (requestId: string, decision: 'approved' | 'denied' = 'approved') =>
  ToolApprovalResponse.make({ requestId, toolCallId: 'bg', decision, source: 'user' })

describe('background loop admission', () => {
  it.effect(
    'fences the whole batch, including automatic siblings, until exact approval resumes',
    () =>
      Effect.gen(function* () {
        let admissions = 0
        const host: BackgroundToolHost<unknown> = {
          accept: () => {
            admissions++
            return Effect.succeed(receipt)
          }
        }
        const gated = yield* setFor(host, true)
        const automatic = yield* setFor(host)
        const sibling = ToolCall.make({ ...call('sibling'), name: 'automatic' })
        const tools = [
          ...gated.tools,
          ...automatic.tools.map(def => ({ ...def, name: 'automatic' }))
        ]
        const first = yield* prepareToolBatch({ calls: [sibling, call()], tools, responses: [] })
        expect(first.callsToExecute).toHaveLength(1)
        expect(first.pendingRequests).toHaveLength(1)
        const events = yield* runToolBatch({ calls: [sibling, call()], tools }).pipe(
          Stream.runCollect,
          Effect.provide(Layer.merge(LoopConfig.defaultLayer, makeToolExecutorLayer(gated)))
        )
        expect(events.map(event => event._tag)).toContain('AgentAwaitingInput')
        expect(events.map(event => event._tag)).not.toContain('ToolExecutionStarted')
        expect(admissions).toBe(0)
        const pending = first.pendingRequests[0]
        expect(pending?.call.params).toEqual(call().params)
        const approved = yield* runToolBatch({
          calls: [call()],
          tools: gated.tools,
          hitlResponses: [response(pending?.requestId ?? '')]
        }).pipe(
          Stream.runCollect,
          Effect.provide(Layer.merge(LoopConfig.defaultLayer, makeToolExecutorLayer(gated)))
        )
        expect(approved.map(event => event._tag)).toEqual([
          'ToolApprovalGranted',
          'ToolExecutionStarted',
          'ToolExecutionAccepted'
        ])
        expect(admissions).toBe(1)
      })
  )

  it.effect(
    'binds approval to exact name, payload and mode; canonical key order permits replay',
    () =>
      Effect.gen(function* () {
        const set = yield* setFor({ accept: () => Effect.succeed(receipt) }, true)
        const prepare = (current: ToolCall, responses: readonly ToolApprovalResponse[] = []) =>
          prepareToolBatch({ calls: [current], tools: set.tools, responses })
        const pending = (yield* prepare(call())).pendingRequests[0]
        const approved = response(pending?.requestId ?? '')
        expect((yield* prepare(call(), [approved])).pendingRequests).toEqual([])
        expect(
          (yield* prepare(
            ToolCall.make({
              ...call(),
              params: { arguments: { value: 'work' }, execution: 'background' }
            }),
            [approved]
          )).pendingRequests
        ).toEqual([])
        for (const changed of [call('bg', 'foreground'), call('bg', 'background', 'changed')]) {
          expect((yield* prepare(changed, [approved])).pendingRequests).toHaveLength(1)
        }
        // An omitted mode is not an approvable variant: it is rejected before any prompt.
        const omitted = yield* prepare(
          ToolCall.make({ ...call(), params: { arguments: { value: 'work' } } }),
          [approved]
        )
        expect(omitted.pendingRequests).toEqual([])
        expect(omitted.callsToExecute).toEqual([])
        expect(omitted.resultMessages[0]?.message).toMatchObject({ isError: true })
        expect((yield* prepare(call(), [response('approval:bg')])).pendingRequests).toHaveLength(1)
        const denied = yield* prepare(call(), [response(pending?.requestId ?? '', 'denied')])
        expect(denied.callsToExecute).toEqual([])
        expect(denied.resultMessages[0]?.message).toMatchObject({ isError: true })
      })
  )

  it.effect(
    'rejects malformed envelopes at preflight instead of prompting a human or launching',
    () =>
      Effect.gen(function* () {
        let admissions = 0
        const host: BackgroundToolHost<unknown> = {
          accept: () => {
            admissions++
            return Effect.succeed(receipt)
          }
        }
        const gated = yield* setFor(host, true)
        const automatic = yield* setFor(host)
        const malformed = [
          ToolCall.make({ id: 'bg', name: 'work', params: { arguments: { value: 'work' } } }),
          ToolCall.make({
            id: 'bg',
            name: 'work',
            params: { execution: 'later', arguments: { value: 'work' } }
          }),
          ToolCall.make({
            id: 'bg',
            name: 'work',
            params: { execution: 'background', arguments: { value: 'work' }, extra: true }
          }),
          ToolCall.make({ id: 'bg', name: 'work', params: { value: 'work' } })
        ]
        for (const set of [gated, automatic]) {
          for (const current of malformed) {
            const prepared = yield* prepareToolBatch({
              calls: [current],
              tools: set.tools,
              responses: []
            })
            expect(prepared.pendingRequests).toEqual([])
            expect(prepared.callsToExecute).toEqual([])
            expect(prepared.resultMessages).toMatchObject([
              { index: 0, message: { toolCallId: 'bg', isError: true } }
            ])
            expect(prepared.resultEvents.map(event => event._tag)).toEqual([
              'ToolExecutionCompleted'
            ])
          }
        }
        const events = yield* runToolBatch({
          calls: [malformed[0] ?? call()],
          tools: automatic.tools
        }).pipe(
          Stream.runCollect,
          Effect.provide(Layer.merge(LoopConfig.defaultLayer, makeToolExecutorLayer(automatic)))
        )
        expect(events.map(event => event._tag)).not.toContain('ToolExecutionStarted')
        expect(admissions).toBe(0)
        // Non-activated foreground registrations keep the legacy approval identity and raw params.
        const legacy = yield* resolveTools(
          [
            {
              id: 'legacy',
              tools: [
                makeTool({
                  name: 'work',
                  description: '',
                  access: 'write',
                  approval: ToolApprovalPolicy.make({ mode: 'manual' }),
                  parameters: Schema.Struct({ value: Schema.String }),
                  execute: ({ call }) =>
                    Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'inline' }))
                })
              ]
            }
          ],
          {}
        )
        const legacyPending = yield* prepareToolBatch({
          calls: [ToolCall.make({ id: 'bg', name: 'work', params: { value: 'work' } })],
          tools: legacy.tools,
          responses: []
        })
        expect(legacyPending.pendingRequests[0]?.requestId).toBe('approval:bg')
      })
  )

  it.effect(
    'continues the provider with one admission acknowledgement and no terminal/usage fiction',
    () =>
      Effect.gen(function* () {
        const set = yield* setFor({ accept: () => Effect.succeed(receipt) })
        const requests: LLMRequest[] = []
        const events = yield* run({
          model: 'fake',
          systemPrompt: '',
          messages: [UserMessage.make({ content: 'work' })],
          tools: set.tools
        }).pipe(
          Stream.runCollect,
          Effect.provide(
            Layer.mergeAll(
              ContextTransformer.identity,
              LoopConfig.defaultLayer,
              makeToolExecutorLayer(set),
              FauxProvider.layerWithRequests({
                requests,
                responses: [Reply.toolCall(call()), Reply.text('Continuing without waiting')]
              })
            )
          )
        )
        expect(events.filter(event => event._tag === 'ToolExecutionAccepted')).toHaveLength(1)
        expect(
          events.filter(
            event => event._tag === 'ToolExecutionCompleted' || event._tag === 'SubagentCompleted'
          )
        ).toEqual([])
        expect(requests).toHaveLength(2)
        expect(
          requests[1]?.messages.filter(message => message._tag === 'ToolResult')
        ).toMatchObject([{ toolCallId: 'bg', acceptance: receipt }])
        const end = events.find(event => event._tag === 'AgentEnd')
        expect(end?.usage).toEqual(zeroAgentUsage)
        expect(end?.messages.filter(message => message._tag === 'ToolResult')).toHaveLength(1)
        // Replayed acknowledgement settles the original call; it is never admitted again on resume.
        let readmissions = 0
        const replaySet = yield* setFor({
          accept: () => {
            readmissions++
            return Effect.succeed(receipt)
          }
        })
        yield* run({
          model: 'fake',
          systemPrompt: '',
          messages: [...(end?.messages ?? []), UserMessage.make({ content: 'continue' })],
          tools: replaySet.tools
        }).pipe(
          Stream.runCollect,
          Effect.provide(
            Layer.mergeAll(
              ContextTransformer.identity,
              LoopConfig.defaultLayer,
              makeToolExecutorLayer(replaySet),
              FauxProvider.layer(Reply.text('ok'))
            )
          )
        )
        expect(readmissions).toBe(0)
      })
  )

  it.effect('preserves accepted sibling receipts when another host dispatch fails', () =>
    Effect.gen(function* () {
      const set = yield* setFor({
        accept: ({ call }) =>
          call.id === 'fail'
            ? Effect.fail(
                new ToolError({ tool: call.name, cause: 'unavailable', message: 'Not admitted' })
              )
            : Effect.succeed(receipt)
      })
      const events = yield* runToolBatch({
        calls: [call('accepted'), call('fail')],
        tools: set.tools
      }).pipe(
        Stream.runCollect,
        Effect.provide(Layer.merge(LoopConfig.defaultLayer, makeToolExecutorLayer(set)))
      )
      expect(events.filter(event => event._tag === 'ToolExecutionAccepted')).toMatchObject([
        { result: { toolCallId: 'accepted', acceptance: receipt } }
      ])
      expect(events.filter(event => event._tag === 'ToolExecutionCompleted')).toMatchObject([
        { result: { toolCallId: 'fail', isError: true } }
      ])
    })
  )
})
