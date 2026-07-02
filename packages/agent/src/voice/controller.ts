import { Effect, Ref, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import type { VoiceClientCodec } from './client-codec.ts'
import {
  VoiceToolCallCompleted,
  VoiceToolCallExecuting,
  VoiceToolCallFailed,
  type VoiceEvent,
  type VoiceSessionError,
  type VoiceToolCall,
  type VoiceToolCallOutcome,
  type VoiceToolCallsRequested
} from './protocol.ts'
import type { VoiceTransportApi } from './transport.ts'

/**
 * Client-side voice controller options. The controller never executes tools:
 * `executeToolCall` forwards each provider tool call to the host's
 * authenticated server endpoint and returns the server outcome.
 */
export type VoiceControllerOptions = {
  readonly transport: VoiceTransportApi
  readonly codec: VoiceClientCodec
  readonly executeToolCall: (
    call: VoiceToolCall
  ) => Effect.Effect<VoiceToolCallOutcome, VoiceSessionError>
}

export type VoiceControllerApi = {
  /** Transport events with tool-call orchestration events interleaved. */
  readonly events: Stream.Stream<VoiceEvent, VoiceSessionError>
  /** Send a user text message and request a response turn. */
  readonly sendText: (text: string) => Effect.Effect<void, VoiceSessionError>
  /** Seed conversation context without requesting a response turn. */
  readonly seedUserText: (text: string) => Effect.Effect<void, VoiceSessionError>
  readonly seedAssistantText: (text: string) => Effect.Effect<void, VoiceSessionError>
}

const encodeErrorOutput = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)

const errorOutputJson = (message: string) =>
  encodeErrorOutput({ error: message }).pipe(Effect.orElseSucceed(() => '{"error":"Tool failed"}'))

const sendAll = (
  transport: VoiceTransportApi,
  payloads: ReadonlyArray<string>
): Effect.Effect<void, VoiceSessionError> =>
  Effect.forEach(payloads, payload => transport.send(payload), { discard: true })

/**
 * Provider-neutral client voice controller. Wraps a connected transport,
 * forwards provider tool calls to the host server endpoint, submits tool
 * outputs back to the provider, requests one response turn per tool batch,
 * and de-dupes provider tool-call re-emissions by call id.
 *
 * MVP semantics: `ApprovalRequired` outcomes are surfaced as failed tool
 * calls with a model-visible "approval required" output and the tool never
 * executes. Interactive approval pause/resume lands with voice HITL.
 */
export const makeVoiceController = (
  options: VoiceControllerOptions
): Effect.Effect<VoiceControllerApi> =>
  Effect.gen(function* () {
    const handledCallIds = yield* Ref.make<ReadonlySet<string>>(new Set())

    const markHandled = (call: VoiceToolCall) =>
      Ref.modify(handledCallIds, handled => {
        if (handled.has(call.callId)) {
          return [false, handled] as const
        }

        return [true, new Set([...handled, call.callId])] as const
      })

    const send = (payloads: Effect.Effect<ReadonlyArray<string>, VoiceSessionError>) =>
      payloads.pipe(Effect.flatMap(encoded => sendAll(options.transport, encoded)))

    const submitOutput = (callId: string, output: string) =>
      send(options.codec.encodeToolOutput(callId, output))

    const runToolCall = (call: VoiceToolCall): Effect.Effect<VoiceEvent, VoiceSessionError> =>
      options.executeToolCall(call).pipe(
        Effect.flatMap((outcome): Effect.Effect<VoiceEvent, VoiceSessionError> => {
          switch (outcome._tag) {
            case 'Executed':
              return submitOutput(call.callId, outcome.output).pipe(
                Effect.as(
                  VoiceToolCallCompleted.make({ callId: call.callId, output: outcome.output })
                )
              )
            case 'ApprovalRequired': {
              const message = `Tool ${call.name} requires approval and was not executed.`

              return errorOutputJson(message).pipe(
                Effect.flatMap(output => submitOutput(call.callId, output)),
                Effect.as(VoiceToolCallFailed.make({ callId: call.callId, message }))
              )
            }
          }
        }),
        Effect.catchTag('VoiceSessionError', error =>
          errorOutputJson(error.message).pipe(
            Effect.flatMap(output => submitOutput(call.callId, output)),
            Effect.catch(() => Effect.void),
            Effect.as(VoiceToolCallFailed.make({ callId: call.callId, message: error.message }))
          )
        )
      )

    const handleToolBatch = (
      event: VoiceToolCallsRequested
    ): Stream.Stream<VoiceEvent, VoiceSessionError> =>
      Stream.fromEffect(
        Effect.forEach(event.calls, call => markHandled(call)).pipe(
          Effect.map(marks => event.calls.filter((_, index) => marks[index] === true))
        )
      ).pipe(
        Stream.flatMap(calls => {
          if (calls.length === 0) {
            return Stream.empty
          }

          const perCall = calls
            .map(call => {
              const executing: VoiceEvent = VoiceToolCallExecuting.make({ callId: call.callId })

              return Stream.make(executing).pipe(Stream.concat(Stream.fromEffect(runToolCall(call))))
            })
            .reduce<Stream.Stream<VoiceEvent, VoiceSessionError>>(
              (acc, stream) => Stream.concat(acc, stream),
              Stream.empty
            )
          const finishTurn = Stream.fromEffect(send(options.codec.encodeResponseTurn())).pipe(
            Stream.drain
          )
          const head: VoiceEvent = event

          return Stream.make(head).pipe(Stream.concat(perCall), Stream.concat(finishTurn))
        })
      )

    const events = options.transport.events.pipe(
      Stream.flatMap(event =>
        event._tag === 'ToolCallsRequested' ? handleToolBatch(event) : Stream.make(event)
      )
    )

    const sendText = (text: string) =>
      send(options.codec.encodeUserText(text)).pipe(
        Effect.andThen(send(options.codec.encodeResponseTurn()))
      )

    return {
      events,
      sendText,
      seedUserText: text => send(options.codec.encodeUserText(text)),
      seedAssistantText: text => send(options.codec.encodeAssistantText(text))
    }
  })
