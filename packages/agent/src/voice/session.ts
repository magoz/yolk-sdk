import { Context, Effect, Layer, Queue, Stream, type Cause } from 'effect'
import type { ToolApprovalResponse } from '@yolk-sdk/agent/protocol'
import {
  VoiceController,
  type VoiceControllerApi,
  type VoiceControllerOptions
} from './controller.ts'
import { VoiceEventOutbox, type VoiceEventOutboxOptions } from './outbox.ts'
import type { VoiceSeedText } from './projection.ts'
import type {
  VoiceEvent,
  VoiceSessionError,
  VoiceToolCall,
  VoiceToolCallOutcome
} from './protocol.ts'
import type { VoiceTransport } from './transport.ts'

/**
 * One voice session's resource graph: a connected transport, the client
 * controller that pumps it, and an optional durable event outbox **when
 * `eventLog` is configured on this layer**. Closing the surrounding `Scope`
 * releases resources this layer acquired, drains a configured outbox, and
 * ends the event stream. Reconnect is a new session layer; sessions do not
 * resume or share transports.
 *
 * Ownership follows the supplied layers. `webRtcVoiceTransportLayer` /
 * `VoiceEventOutbox.layer` acquire and finalize their resources in this
 * scope. `Layer.succeed` only injects a caller-owned value: this session
 * does not allocate, uniquely own, or finalize that value.
 *
 * An omitted `eventLog` never reads `VoiceEventOutbox` from ambient
 * context, so an unrelated provided outbox cannot be captured.
 */
export type VoiceSessionApi = VoiceControllerApi

export type VoiceSessionOptions<E = never, R = never> = {
  /**
   * Transport layer for this session only. Acquisition/finalization are
   * those of the layer itself, not of `VoiceSession` wrapping it.
   */
  readonly transport: Layer.Layer<VoiceTransport, E, R>
  readonly codec: VoiceControllerOptions['codec']
  readonly executeToolCall: (
    call: VoiceToolCall,
    approval?: ToolApprovalResponse
  ) => Effect.Effect<VoiceToolCallOutcome, VoiceSessionError>
  /**
   * Optional durable outbox **owned by this session layer**. When set, the
   * session forks a consumer of controller events so logging does not depend
   * on an external `events` pull. When omitted, no outbox is required or
   * read.
   */
  readonly eventLog?: VoiceEventOutboxOptions
  /** Conversation seeds replayed into the provider session on acquire. */
  readonly seeds?: ReadonlyArray<VoiceSeedText>
}

const seedSession = (
  controller: VoiceControllerApi,
  seeds: ReadonlyArray<VoiceSeedText>
): Effect.Effect<void, VoiceSessionError> =>
  Effect.forEach(
    seeds,
    seed =>
      seed.role === 'user'
        ? controller.seedUserText(seed.text)
        : controller.seedAssistantText(seed.text),
    { discard: true }
  )

const sessionApi = (controller: VoiceControllerApi, events: VoiceControllerApi['events']) =>
  VoiceSession.of({
    events,
    sendText: controller.sendText,
    seedUserText: controller.seedUserText,
    seedAssistantText: controller.seedAssistantText,
    submitHitlResponse: controller.submitHitlResponse
  })

const acquirePlainSession = (seeds: ReadonlyArray<VoiceSeedText>) =>
  Effect.gen(function* () {
    const controller = yield* VoiceController
    yield* seedSession(controller, seeds)

    return sessionApi(controller, controller.events)
  })

const acquireLoggedSession = (seeds: ReadonlyArray<VoiceSeedText>) =>
  Effect.gen(function* () {
    const controller = yield* VoiceController
    const outbox = yield* VoiceEventOutbox
    const published = yield* Queue.unbounded<VoiceEvent, VoiceSessionError | Cause.Done>()

    yield* Effect.forkScoped(
      Stream.runForEach(controller.events, event =>
        outbox.offer(event).pipe(Effect.andThen(Queue.offer(published, event).pipe(Effect.asVoid)))
      ).pipe(
        Effect.matchCauseEffect({
          onFailure: cause => Queue.failCause(published, cause).pipe(Effect.asVoid),
          onSuccess: () => Queue.end(published).pipe(Effect.asVoid)
        })
      )
    )

    yield* seedSession(controller, seeds)

    return sessionApi(controller, Stream.fromQueue(published))
  })

/**
 * Framework-independent owner for one voice session. Provide a transport
 * layer (WebRTC, WebSocket, or a test `Layer.succeed` of a caller-owned
 * transport) plus codec/tool endpoint options; yield `VoiceSession` inside
 * a `Scope`.
 */
export class VoiceSession extends Context.Service<VoiceSession, VoiceSessionApi>()(
  '@yolk-sdk/agent/voice/VoiceSession'
) {
  static layer = <E = never, R = never>(
    options: VoiceSessionOptions<E, R>
  ): Layer.Layer<VoiceSession, E | VoiceSessionError, R> => {
    const controller = VoiceController.layer({
      codec: options.codec,
      executeToolCall: options.executeToolCall
    })

    const seeds = options.seeds ?? []

    const session =
      options.eventLog === undefined
        ? Layer.effect(this, acquirePlainSession(seeds))
        : Layer.effect(this, acquireLoggedSession(seeds)).pipe(
            Layer.provide(VoiceEventOutbox.layer(options.eventLog))
          )

    return session.pipe(Layer.provide(controller), Layer.provide(options.transport))
  }
}
