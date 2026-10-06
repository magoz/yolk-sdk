import { Effect, Exit, Layer, Match, Predicate, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentEvent,
  ToolApprovalPolicy,
  ToolApprovalRequest,
  ToolApprovalResponse,
  ToolCall,
  ToolResult,
  type HitlRequest
} from '@yolk-sdk/agent/protocol'
import { LoopConfig, prepareToolBatch, runToolBatch, ToolError } from '../../src/loop/index.ts'
import {
  makeTool,
  makeToolExecutorLayer,
  resolveTools,
  ToolValueChange,
  type ToolChangePreview
} from '../../src/tools/index.ts'

const Params = Schema.Struct({ id: Schema.String, status: Schema.String })

const statusPreview = (params: typeof Params.Type): ToolChangePreview => ({
  target: { label: `Record ${params.id}`, id: params.id },
  changes: [
    ToolValueChange.make({
      field: 'status',
      label: 'Status',
      before: 'draft',
      after: params.status
    })
  ]
})

const setup = (previewed: Array<string>) =>
  resolveTools(
    [
      {
        id: 'records',
        tools: [
          makeTool({
            name: 'update_record',
            description: 'Update a record',
            parameters: Params,
            access: 'write',
            approval: ToolApprovalPolicy.make({ mode: 'manual' }),
            changePreview: ({ params }) =>
              Effect.suspend(() => {
                previewed.push(params.id)

                return Match.value(params.id).pipe(
                  Match.when('broken', () =>
                    Effect.fail(
                      new ToolError({
                        tool: 'update_record',
                        cause: 'unavailable',
                        message: 'records are down'
                      })
                    )
                  ),
                  Match.when('crash', () => Effect.die(new Error('bug'))),
                  Match.orElse(() => Effect.succeed(statusPreview(params)))
                )
              }),
            execute: ({ call }) =>
              Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'updated' }))
          }),
          makeTool({
            name: 'delete_record',
            description: 'Delete a record',
            parameters: Params,
            access: 'destructive',
            approval: ToolApprovalPolicy.make({ mode: 'manual' }),
            execute: ({ call }) =>
              Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'deleted' }))
          })
        ]
      }
    ],
    {}
  )

const update = (id: string, name = 'update_record') =>
  ToolCall.make({ id: `call_${id}`, name, params: { id, status: 'published' } })

const approvalRequests = (requests: ReadonlyArray<HitlRequest>) =>
  requests.filter(request => Predicate.isTagged(request, 'ToolApprovalRequest'))

describe('approval change previews', () => {
  it.effect('raises each sibling approval with its own preview, or a preview error', () =>
    Effect.gen(function* () {
      const previewed: Array<string> = []
      const toolSet = yield* setup(previewed)

      const prepared = yield* prepareToolBatch({
        tools: toolSet.tools,
        responses: [],
        calls: [
          update('r1'),
          update('r2'),
          update('broken'),
          update('crash'),
          update('r3', 'delete_record')
        ],
        approvalPreviews: toolSet.approvalPreviews
      })

      const requests = approvalRequests(prepared.pendingRequests)

      expect(
        requests.map(request => [request.requestId, request.preview, request.previewError])
      ).toEqual([
        ['approval:call_r1', statusPreview({ id: 'r1', status: 'published' }), undefined],
        ['approval:call_r2', statusPreview({ id: 'r2', status: 'published' }), undefined],
        ['approval:call_broken', undefined, { cause: 'failed', message: 'records are down' }],
        [
          'approval:call_crash',
          undefined,
          { cause: 'failed', message: 'The change preview of update_record failed.' }
        ],
        // No hook: a plain approval request, as before.
        ['approval:call_r3', undefined, undefined]
      ])
      expect(prepared.callsToExecute).toEqual([])

      // The requested events carry the same requests, so hosts persist what the person approves.
      const requested = prepared.pendingEvents.flatMap(event =>
        Predicate.isTagged(event, 'ToolApprovalRequested') && event.request !== undefined
          ? [event.request]
          : []
      )

      expect(requested).toEqual(requests)
    })
  )

  it.effect('round-trips approval requests with previews through the wire codecs', () =>
    Effect.gen(function* () {
      const toolSet = yield* setup([])

      const events = yield* runToolBatch({
        calls: [update('r1')],
        tools: toolSet.tools,
        approvalPreviews: toolSet.approvalPreviews
      }).pipe(
        Stream.runCollect,
        Effect.provide(Layer.merge(LoopConfig.defaultLayer, makeToolExecutorLayer(toolSet)))
      )

      const codec = Schema.toCodecJson(AgentEvent)

      const encoded = yield* Schema.encodeUnknownEffect(Schema.Array(codec))(events)

      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(codec))(
        JSON.parse(JSON.stringify(encoded))
      )

      const awaiting = decoded.find(event => Predicate.isTagged(event, 'AgentAwaitingInput'))
      const request = awaiting === undefined ? undefined : approvalRequests(awaiting.requests)[0]

      expect(request?.preview).toEqual(statusPreview({ id: 'r1', status: 'published' }))

      // Requests persisted before previews existed still decode.
      const legacy = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(ToolApprovalRequest))({
        _tag: 'ToolApprovalRequest',
        requestId: 'approval:call_r1',
        toolCallId: 'call_r1',
        call: { id: 'call_r1', name: 'update_record', params: { id: 'r1', status: 'published' } }
      })

      expect(legacy.preview).toBeUndefined()
    })
  )

  it.effect('does not preview calls that already have a response', () =>
    Effect.gen(function* () {
      const previewed: Array<string> = []
      const toolSet = yield* setup(previewed)

      const respond = (id: string, decision: 'approved' | 'denied') =>
        ToolApprovalResponse.make({
          requestId: `approval:call_${id}`,
          toolCallId: `call_${id}`,
          decision,
          source: 'user'
        })

      const prepared = yield* prepareToolBatch({
        tools: toolSet.tools,
        responses: [respond('r1', 'approved'), respond('r2', 'denied')],
        calls: [update('r1'), update('r2')],
        approvalPreviews: toolSet.approvalPreviews
      })

      expect(prepared.pendingRequests).toEqual([])
      expect(prepared.callsToExecute.map(item => item.call.id)).toEqual(['call_r1'])
      expect(previewed).toEqual([])
    })
  )

  it.effect('never lets a host previewer defect block the approval', () =>
    Effect.gen(function* () {
      const toolSet = yield* setup([])

      const prepared = yield* prepareToolBatch({
        tools: toolSet.tools,
        responses: [],
        calls: [update('r1')],
        approvalPreviews: { update_record: () => Effect.die(new Error('host bug')) }
      })

      const [request] = approvalRequests(prepared.pendingRequests)

      expect(request?.requestId).toBe('approval:call_r1')
      expect(request?.previewError).toEqual({
        cause: 'failed',
        message: 'The change preview failed.'
      })
    })
  )

  it.effect('propagates interruption instead of reporting a preview error', () =>
    Effect.gen(function* () {
      const toolSet = yield* setup([])

      const exit = yield* prepareToolBatch({
        tools: toolSet.tools,
        responses: [],
        calls: [update('r1')],
        approvalPreviews: { update_record: () => Effect.interrupt }
      }).pipe(Effect.exit)

      expect(Exit.hasInterrupts(exit)).toBe(true)
    })
  )

  it.effect('leaves approval requests unchanged without previewers', () =>
    Effect.gen(function* () {
      const previewed: Array<string> = []
      const toolSet = yield* setup(previewed)

      const prepared = yield* prepareToolBatch({
        tools: toolSet.tools,
        responses: [],
        calls: [update('r1')]
      })

      const [request] = approvalRequests(prepared.pendingRequests)

      expect(request?.preview).toBeUndefined()
      expect(request?.previewError).toBeUndefined()
      expect(previewed).toEqual([])
    })
  )
})
