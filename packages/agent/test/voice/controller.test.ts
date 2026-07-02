import { Effect, Queue, Stream, type Cause } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolApprovalPolicy, ToolApprovalRequest, ToolCall } from '@yolk-sdk/agent/protocol'
import {
  makeVoiceController,
  VoiceSessionError,
  VoiceSessionOpened,
  VoiceToolCall,
  VoiceToolCallApprovalRequiredOutcome,
  VoiceToolCallExecutedOutcome,
  VoiceToolCallsRequested,
  VoiceUserTranscriptFinal,
  type VoiceEvent,
  type VoiceToolCallOutcome,
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

  it.effect('surfaces approval-required outcomes as unexecuted failed calls', () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeTransport()
      const outcome: VoiceToolCallOutcome = VoiceToolCallApprovalRequiredOutcome.make({
        request: ToolApprovalRequest.make({
          requestId: 'approval:call_1',
          toolCallId: 'call_1',
          call: ToolCall.make({ id: 'call_1', name: 'sandbox', params: {} }),
          policy: ToolApprovalPolicy.make({ mode: 'manual' })
        })
      })
      const controller = yield* makeVoiceController({
        transport: fake.transport,
        codec: testCodec,
        executeToolCall: () => Effect.succeed(outcome)
      })

      yield* fake.emit(VoiceToolCallsRequested.make({ calls: [toolCall('call_1', 'sandbox')] }))
      yield* fake.end

      const events = yield* Stream.runCollect(controller.events)
      const failed = [...events].find(event => event._tag === 'ToolCallFailed')

      expect(failed).toMatchObject({ callId: 'call_1' })
      expect(fake.sent[0]).toContain('requires approval')
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
