import { Effect, Fiber, Queue, Stream, type Cause } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolApprovalPolicy, ToolApprovalRequest, ToolApprovalResponse, ToolCall } from '@yolk-sdk/agent/protocol'
import {
  makeVoiceController,
  VoiceSessionError,
  VoiceSessionOpened,
  VoiceToolCall,
  VoiceToolCallApprovalRequiredOutcome,
  VoiceToolCallDeniedOutcome,
  VoiceToolCallExecutedOutcome,
  VoiceToolCallsRequested,
  VoiceUserTranscriptFinal,
  voiceApprovalRequestId,
  type VoiceControllerApi,
  type VoiceEvent,
  type VoiceTransportApi
} from '../../src/voice/index.ts'
import type { VoiceClientCodec } from '../../src/voice/index.ts'

type FakeTransport = {
  readonly transport: VoiceTransportApi
  readonly emit: (event: VoiceEvent) => Effect.Effect<void>
  readonly end: Effect.Effect<void>
  readonly sent: Array<string>
}

const makeFakeTransport = (): Effect.Effect<FakeTransport> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<VoiceEvent, VoiceSessionError | Cause.Done>()
    const sent: Array<string> = []

    return {
      transport: {
        send: (data: string) =>
          Effect.sync(() => {
            sent.push(data)
          }),
        events: Stream.fromQueue(queue)
      },
      emit: (event: VoiceEvent) => Queue.offer(queue, event).pipe(Effect.asVoid),
      end: Queue.end(queue).pipe(Effect.asVoid),
      sent
    }
  })

const testCodec: VoiceClientCodec = {
  encodeToolOutput: (callId, output) => Effect.succeed([`tool-output:${callId}:${output}`]),
  encodeResponseTurn: () => Effect.succeed(['response-turn']),
  encodeUserText: text => Effect.succeed([`user:${text}`]),
  encodeAssistantText: text => Effect.succeed([`assistant:${text}`])
}

const toolCall = (callId: string, name = 'web_search') =>
  VoiceToolCall.make({ callId, name, argumentsJson: '{"q":"x"}' })

const approvalRequiredOutcome = (callId: string) =>
  VoiceToolCallApprovalRequiredOutcome.make({
    request: ToolApprovalRequest.make({
      requestId: voiceApprovalRequestId(callId),
      toolCallId: callId,
      call: ToolCall.make({ id: callId, name: 'sandbox', params: {} }),
      policy: ToolApprovalPolicy.make({ mode: 'manual' })
    })
  })

const approvalResponse = (decision: 'approved' | 'denied', reason?: string) =>
  ToolApprovalResponse.make({
    requestId: voiceApprovalRequestId('call_1'),
    toolCallId: 'call_1',
    decision,
    source: 'user',
    ...(reason === undefined ? {} : { reason })
  })

type EventCollector = {
  readonly seen: Array<VoiceEvent>
  readonly fiber: Fiber.Fiber<void, VoiceSessionError>
}

const collectEvents = (controller: VoiceControllerApi): Effect.Effect<EventCollector> =>
  Effect.gen(function* () {
    const seen: Array<VoiceEvent> = []
    const fiber = yield* Effect.forkChild(
      Stream.runForEach(controller.events, event =>
        Effect.sync(() => {
          seen.push(event)
        })
      )
    )

    return { seen, fiber }
  })

const awaitEventTag = (collector: EventCollector, tag: VoiceEvent['_tag']) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (collector.seen.some(event => event._tag === tag)) {
        return
      }

      yield* Effect.yieldNow
    }

    return yield* Effect.die(new Error(`Event ${tag} was not observed`))
  })

describe('makeVoiceController', () => {
  it.effect('forwards tool batches to the server and submits outputs plus one turn', () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeTransport()
      const executed: Array<string> = []
      const controller = yield* makeVoiceController({
        transport: fake.transport,
        codec: testCodec,
        executeToolCall: call =>
          Effect.sync(() => {
            executed.push(call.callId)

            return VoiceToolCallExecutedOutcome.make({
              callId: call.callId,
              output: `{"result":"${call.callId}"}`
            })
          })
      })

      yield* fake.emit(VoiceSessionOpened.make({ model: 'gpt-realtime-2' }))
      yield* fake.emit(
        VoiceToolCallsRequested.make({ calls: [toolCall('call_1'), toolCall('call_2')] })
      )
      yield* fake.end

      const events = yield* Stream.runCollect(controller.events)

      expect([...events].map(event => event._tag)).toEqual([
        'SessionOpened',
        'ToolCallsRequested',
        'ToolCallExecuting',
        'ToolCallCompleted',
        'ToolCallExecuting',
        'ToolCallCompleted'
      ])
      expect(executed).toEqual(['call_1', 'call_2'])
      expect(fake.sent).toEqual([
        'tool-output:call_1:{"result":"call_1"}',
        'tool-output:call_2:{"result":"call_2"}',
        'response-turn'
      ])
    })
  )

  it.effect('de-dupes provider tool-call re-emissions by call id', () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeTransport()
      const executed: Array<string> = []
      const controller = yield* makeVoiceController({
        transport: fake.transport,
        codec: testCodec,
        executeToolCall: call =>
          Effect.sync(() => {
            executed.push(call.callId)

            return VoiceToolCallExecutedOutcome.make({ callId: call.callId, output: '{}' })
          })
      })

      yield* fake.emit(VoiceToolCallsRequested.make({ calls: [toolCall('call_1')] }))
      yield* fake.emit(VoiceToolCallsRequested.make({ calls: [toolCall('call_1')] }))
      yield* fake.end

      const events = yield* Stream.runCollect(controller.events)

      expect(executed).toEqual(['call_1'])
      expect([...events].filter(event => event._tag === 'ToolCallCompleted')).toHaveLength(1)
      expect(fake.sent.filter(payload => payload === 'response-turn')).toHaveLength(1)
    })
  )

  it.effect('maps server failures to failed tool calls with model-visible error output', () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeTransport()
      const controller = yield* makeVoiceController({
        transport: fake.transport,
        codec: testCodec,
        executeToolCall: () =>
          Effect.fail(
            new VoiceSessionError({ code: 'provider_error', message: 'tool endpoint failed' })
          )
      })

      yield* fake.emit(VoiceToolCallsRequested.make({ calls: [toolCall('call_1')] }))
      yield* fake.end

      const events = yield* Stream.runCollect(controller.events)
      const failed = [...events].find(event => event._tag === 'ToolCallFailed')

      expect(failed).toMatchObject({ callId: 'call_1', message: 'tool endpoint failed' })
      expect(fake.sent[0]).toContain('tool endpoint failed')
      expect(fake.sent[1]).toBe('response-turn')
    })
  )

  it.effect('pauses approval-gated calls and executes after approval', () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeTransport()
      const approvals: Array<string> = []
      const controller = yield* makeVoiceController({
        transport: fake.transport,
        codec: testCodec,
        executeToolCall: (call, approval) => {
          if (approval === undefined) {
            return Effect.succeed(approvalRequiredOutcome('call_1'))
          }

          approvals.push(approval.decision)

          return Effect.succeed(
            VoiceToolCallExecutedOutcome.make({ callId: call.callId, output: '{"ok":true}' })
          )
        }
      })
      const collector = yield* collectEvents(controller)

      yield* fake.emit(VoiceToolCallsRequested.make({ calls: [toolCall('call_1', 'sandbox')] }))
      yield* awaitEventTag(collector, 'AwaitingInput')
      yield* controller.submitHitlResponse(approvalResponse('approved'))
      yield* fake.end
      yield* Fiber.join(collector.fiber)

      expect(collector.seen.map(event => event._tag)).toEqual([
        'ToolCallsRequested',
        'ToolCallExecuting',
        'AwaitingInput',
        'ToolCallCompleted'
      ])
      expect(approvals).toEqual(['approved'])
      expect(fake.sent).toEqual(['tool-output:call_1:{"ok":true}', 'response-turn'])
    })
  )

  it.effect('submits denial output without executing when approval is denied', () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeTransport()
      const resumeDecisions: Array<string> = []
      const controller = yield* makeVoiceController({
        transport: fake.transport,
        codec: testCodec,
        executeToolCall: (call, approval) => {
          if (approval === undefined) {
            return Effect.succeed(approvalRequiredOutcome('call_1'))
          }

          resumeDecisions.push(approval.decision)

          return Effect.succeed(
            VoiceToolCallDeniedOutcome.make({
              callId: call.callId,
              output: '{"error":"denied by user"}',
              reason: 'denied by user'
            })
          )
        }
      })
      const collector = yield* collectEvents(controller)

      yield* fake.emit(VoiceToolCallsRequested.make({ calls: [toolCall('call_1', 'sandbox')] }))
      yield* awaitEventTag(collector, 'AwaitingInput')
      yield* controller.submitHitlResponse(approvalResponse('denied', 'denied by user'))
      yield* fake.end
      yield* Fiber.join(collector.fiber)

      const failed = collector.seen.find(event => event._tag === 'ToolCallFailed')

      expect(failed).toMatchObject({ callId: 'call_1', message: 'Tool was denied: denied by user' })
      expect(resumeDecisions).toEqual(['denied'])
      expect(fake.sent[0]).toContain('denied by user')
    })
  )

  it.effect('ignores duplicate and unknown approval responses', () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeTransport()
      const serverCalls: Array<string> = []
      const controller = yield* makeVoiceController({
        transport: fake.transport,
        codec: testCodec,
        executeToolCall: (call, approval) => {
          serverCalls.push(approval === undefined ? 'initial' : 'resume')

          return approval === undefined
            ? Effect.succeed(approvalRequiredOutcome('call_1'))
            : Effect.succeed(
                VoiceToolCallExecutedOutcome.make({ callId: call.callId, output: '{}' })
              )
        }
      })
      const collector = yield* collectEvents(controller)

      yield* controller.submitHitlResponse(approvalResponse('approved'))
      yield* fake.emit(VoiceToolCallsRequested.make({ calls: [toolCall('call_1', 'sandbox')] }))
      yield* awaitEventTag(collector, 'AwaitingInput')
      yield* controller.submitHitlResponse(approvalResponse('approved'))
      yield* controller.submitHitlResponse(approvalResponse('denied'))
      yield* fake.end
      yield* Fiber.join(collector.fiber)

      expect(serverCalls).toEqual(['initial', 'resume'])
      expect(collector.seen.filter(event => event._tag === 'ToolCallCompleted')).toHaveLength(1)
      expect(collector.seen.filter(event => event._tag === 'ToolCallFailed')).toHaveLength(0)
    })
  )

  it.effect('completes the stream and keeps approval pending when the session ends', () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeTransport()
      const serverCalls: Array<string> = []
      const controller = yield* makeVoiceController({
        transport: fake.transport,
        codec: testCodec,
        executeToolCall: (_, approval) => {
          serverCalls.push(approval === undefined ? 'initial' : 'resume')

          return Effect.succeed(approvalRequiredOutcome('call_1'))
        }
      })
      const collector = yield* collectEvents(controller)

      yield* fake.emit(VoiceToolCallsRequested.make({ calls: [toolCall('call_1', 'sandbox')] }))
      yield* awaitEventTag(collector, 'AwaitingInput')
      yield* fake.end
      yield* Fiber.join(collector.fiber)

      expect(collector.seen.map(event => event._tag)).toEqual([
        'ToolCallsRequested',
        'ToolCallExecuting',
        'AwaitingInput'
      ])
      expect(serverCalls).toEqual(['initial'])
      expect(fake.sent.filter(payload => payload.startsWith('tool-output'))).toHaveLength(0)
    })
  )

  it.effect('sends user text with a response turn and seeds without one', () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeTransport()
      const controller = yield* makeVoiceController({
        transport: fake.transport,
        codec: testCodec,
        executeToolCall: () =>
          Effect.succeed(VoiceToolCallExecutedOutcome.make({ callId: 'x', output: '{}' }))
      })

      yield* controller.sendText('hello')
      yield* controller.seedUserText('earlier user message')
      yield* controller.seedAssistantText('earlier assistant message')

      expect(fake.sent).toEqual([
        'user:hello',
        'response-turn',
        'user:earlier user message',
        'assistant:earlier assistant message'
      ])
    })
  )

  it.effect('passes through non-tool events untouched', () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeTransport()
      const controller = yield* makeVoiceController({
        transport: fake.transport,
        codec: testCodec,
        executeToolCall: () =>
          Effect.succeed(VoiceToolCallExecutedOutcome.make({ callId: 'x', output: '{}' }))
      })
      const transcript = VoiceUserTranscriptFinal.make({ itemId: 'item_1', text: 'Hi' })

      yield* fake.emit(transcript)
      yield* fake.end

      const events = yield* Stream.runCollect(controller.events)

      expect([...events]).toEqual([transcript])
    })
  )
})
