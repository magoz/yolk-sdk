import { Effect, Fiber, Layer, Predicate, Queue, Stream, type Cause } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  InputDescriptor,
  InputResponse,
  ToolApprovalPolicy,
  ToolApprovalRequest,
  ToolApprovalResponse,
  ToolCall,
  ToolDef
} from '@yolk-sdk/agent/protocol'
import { ToolError, ToolExecutor } from '@yolk-sdk/agent/loop'
import {
  decideVoiceToolCall,
  handleVoiceToolCall,
  makeVoiceController,
  VoiceToolCall,
  VoiceToolCallApprovalRequiredOutcome,
  VoiceToolCallExecutedOutcome,
  VoiceToolCallsRequested,
  VoiceTransport,
  voiceApprovalRequestId,
  voiceInputUnsupportedMessage,
  type VoiceControllerOptions,
  type VoiceEvent,
  type VoiceSessionError,
  type VoiceTransportApi
} from '../../src/voice/index.ts'
import type { VoiceClientCodec } from '../../src/voice/index.ts'

const inputDef = ToolDef.make({
  name: 'word',
  description: 'Collect a word.',
  parameters: {},
  input: InputDescriptor.make({ kind: 'text-field' })
})

const inputCall = VoiceToolCall.make({ callId: 'call_1', name: 'word', argumentsJson: '"kind"' })

const inputResponse = InputResponse.make({
  requestId: 'input:word:call_1',
  toolCallId: 'call_1',
  outcome: 'submitted',
  source: 'user',
  data: 'kind'
})

type FakeTransport = {
  readonly transport: VoiceTransportApi
  readonly emit: (event: VoiceEvent) => Effect.Effect<void>
  readonly end: Effect.Effect<void>
}

const makeFakeTransport = (): Effect.Effect<FakeTransport> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<VoiceEvent, VoiceSessionError | Cause.Done>()

    return {
      transport: {
        send: () => Effect.void,
        events: Stream.fromQueue(queue)
      },
      emit: event => Queue.offer(queue, event).pipe(Effect.asVoid),
      end: Queue.end(queue).pipe(Effect.asVoid)
    }
  })

const testCodec: VoiceClientCodec = {
  encodeToolOutput: (callId, output) => Effect.succeed([`tool-output:${callId}:${output}`]),
  encodeResponseTurn: () => Effect.succeed(['response-turn']),
  encodeUserText: text => Effect.succeed([`user:${text}`]),
  encodeAssistantText: text => Effect.succeed([`assistant:${text}`])
}

const openController = (
  fake: FakeTransport,
  executeToolCall: VoiceControllerOptions['executeToolCall']
) =>
  makeVoiceController({ codec: testCodec, executeToolCall }).pipe(
    Effect.provideService(VoiceTransport, fake.transport)
  )

const sandboxCall = (callId: string) =>
  VoiceToolCall.make({ callId, name: 'sandbox', argumentsJson: '{"command":"ls"}' })

const approvalRequiredOutcome = (callId: string) =>
  VoiceToolCallApprovalRequiredOutcome.make({
    request: ToolApprovalRequest.make({
      requestId: voiceApprovalRequestId(callId),
      toolCallId: callId,
      call: ToolCall.make({ id: callId, name: 'sandbox', params: {} }),
      policy: ToolApprovalPolicy.make({ mode: 'manual' })
    })
  })

const awaitEventTag = (
  seen: () => ReadonlyArray<VoiceEvent>,
  tag: VoiceEvent['_tag']
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (seen().some(event => event._tag === tag)) {
        return
      }

      yield* Effect.yieldNow
    }

    return yield* Effect.die(new Error(`Event ${tag} was not observed`))
  })

describe('voice input rejection', () => {
  it('denies generic input tools before approval matching', () => {
    const decision = decideVoiceToolCall([inputDef], inputCall)

    expect(decision._tag).toBe('Deny')
    expect(decision).toMatchObject({ reason: voiceInputUnsupportedMessage })
  })

  it('denies approval-bearing input tools without granting authorization', () => {
    const gatedDef = ToolDef.make({
      name: 'word',
      description: 'Collect a word.',
      parameters: {},
      approval: ToolApprovalPolicy.make({ mode: 'manual' }),
      input: InputDescriptor.make({ kind: 'text-field' })
    })

    const decision = decideVoiceToolCall([gatedDef], inputCall)

    expect(decision._tag).toBe('Deny')
    expect(decision).toMatchObject({ reason: voiceInputUnsupportedMessage })
  })

  it.effect('never executes input tools server-side', () =>
    Effect.gen(function* () {
      const executed: Array<ToolCall> = []

      const executorLayer = Layer.succeed(
        ToolExecutor,
        ToolExecutor.of({
          execute: call => {
            executed.push(call)

            return Effect.fail(
              new ToolError({ tool: call.name, cause: 'execution', message: 'must not run' })
            )
          }
        })
      )

      const outcome = yield* handleVoiceToolCall({
        call: inputCall,
        tools: [inputDef]
      }).pipe(Effect.provide(executorLayer))

      expect(outcome._tag).toBe('Denied')
      expect(outcome).toMatchObject({
        callId: 'call_1',
        reason: voiceInputUnsupportedMessage
      })
      expect(executed).toEqual([])
    })
  )

  it.effect('ignores generic input responses without disturbing approvals', () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeTransport()
      const serverCalls: Array<string> = []

      const controller = yield* openController(fake, (call, approval) => {
        serverCalls.push(approval === undefined ? 'initial' : 'resume')

        return approval === undefined
          ? Effect.succeed(approvalRequiredOutcome('call_1'))
          : Effect.succeed(VoiceToolCallExecutedOutcome.make({ callId: call.callId, output: '{}' }))
      })

      const seen: Array<VoiceEvent> = []

      const fiber = yield* Effect.forkChild(
        Stream.runForEach(controller.events, event =>
          Effect.sync(() => {
            seen.push(event)
          })
        )
      )

      yield* controller.submitHitlResponse(inputResponse)
      yield* fake.emit(VoiceToolCallsRequested.make({ calls: [sandboxCall('call_1')] }))
      yield* awaitEventTag(() => seen, 'AwaitingInput')
      yield* controller.submitHitlResponse(inputResponse)
      yield* controller.submitHitlResponse(
        ToolApprovalResponse.make({
          requestId: voiceApprovalRequestId('call_1'),
          toolCallId: 'call_1',
          decision: 'approved',
          source: 'user'
        })
      )
      yield* fake.end
      yield* Fiber.join(fiber)

      expect(serverCalls).toEqual(['initial', 'resume'])
      expect(seen.filter(event => Predicate.isTagged(event, 'ToolCallCompleted'))).toHaveLength(1)
    })
  )
})
