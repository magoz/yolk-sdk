import { Cause, Deferred, Duration, Effect, Queue, Stream, type Scope } from 'effect'
import * as Socket from 'effect/unstable/socket/Socket'
import {
  VoiceErrorEvent,
  VoiceSessionClosed,
  VoiceSessionError,
  VoiceSessionOpening,
  type VoiceEvent
} from './protocol.ts'
import type { VoiceTransportApi } from './transport.ts'

export type WebSocketVoiceTransportOptions = {
  /** Provider or gateway WebSocket URL; hosts own auth/token query wiring. */
  readonly url: string
  readonly protocols?: string | ReadonlyArray<string>
  /** Provider codec: raw socket string to provider-neutral events. */
  readonly decodeMessage: (raw: string) => ReadonlyArray<VoiceEvent>
  /** Raw payloads to send once the socket opens, e.g. session config. */
  readonly openPayloads?: ReadonlyArray<string>
  readonly readyTimeoutMs?: number
}

const defaultReadyTimeoutMs = 10_000

const socketErrorToVoiceError = (error: Socket.SocketError) =>
  new VoiceSessionError({
    code: 'transport_failed',
    message: `Voice WebSocket failed: ${error.message}`
  })

/**
 * Server/Node voice transport over an Effect WebSocket. Suits providers that
 * expose realtime sessions over WS instead of WebRTC, and non-browser voice
 * runtimes (CLIs, workers, telephony bridges). Hosts provide a
 * `Socket.WebSocketConstructor` layer, e.g.
 * `Socket.layerWebSocketConstructorGlobal`.
 *
 * The transport connects during acquisition, replays decoded provider events
 * on `events`, and ends the stream when the socket closes. Socket failures
 * surface as `Error` voice events followed by stream end, matching the
 * browser WebRTC transport semantics.
 */
export const makeWebSocketVoiceTransport = (
  options: WebSocketVoiceTransportOptions
): Effect.Effect<VoiceTransportApi, VoiceSessionError, Scope.Scope | Socket.WebSocketConstructor> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<VoiceEvent, VoiceSessionError | Cause.Done>()

    yield* Queue.offer(queue, VoiceSessionOpening.make({}))

    const socket = yield* Socket.makeWebSocket(options.url, {
      protocols: options.protocols === undefined ? undefined : [...options.protocols],
      openTimeout: Duration.millis(options.readyTimeoutMs ?? defaultReadyTimeoutMs),
      closeCodeIsError: code => code !== 1000 && code !== 1005
    })
    const write = yield* socket.writer
    const ready = yield* Deferred.make<void, VoiceSessionError>()

    const handleMessage = (raw: string) =>
      Effect.forEach(options.decodeMessage(raw), event => Queue.offer(queue, event), {
        discard: true
      })

    const onOpen = Effect.forEach(options.openPayloads ?? [], payload => write(payload), {
      discard: true
    }).pipe(
      Effect.mapError(socketErrorToVoiceError),
      Effect.andThen(Deferred.succeed(ready, undefined)),
      Effect.catchTag('VoiceSessionError', error => Deferred.fail(ready, error)),
      Effect.asVoid
    )

    yield* socket.runString(handleMessage, { onOpen }).pipe(
      Effect.matchCauseEffect({
        onFailure: cause => {
          const failure = Cause.squash(cause)

          return Effect.gen(function* () {
            const message = Socket.isSocketError(failure)
              ? socketErrorToVoiceError(failure).message
              : 'Voice WebSocket failed'

            Deferred.doneUnsafe(
              ready,
              Effect.fail(new VoiceSessionError({ code: 'transport_failed', message }))
            )
            yield* Queue.offer(queue, VoiceErrorEvent.make({ code: 'transport_failed', message }))
            yield* Queue.end(queue)
          })
        },
        onSuccess: () =>
          Effect.gen(function* () {
            Deferred.doneUnsafe(
              ready,
              Effect.fail(
                new VoiceSessionError({
                  code: 'transport_failed',
                  message: 'Voice WebSocket closed before ready'
                })
              )
            )
            yield* Queue.offer(queue, VoiceSessionClosed.make({ reason: 'socket_closed' }))
            yield* Queue.end(queue)
          })
      }),
      Effect.forkScoped
    )

    yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(options.readyTimeoutMs ?? defaultReadyTimeoutMs),
        orElse: () =>
          Effect.fail(
            new VoiceSessionError({
              code: 'session_setup_failed',
              message: 'Voice WebSocket timed out before ready'
            })
          )
      })
    )

    const send = (data: string) => write(data).pipe(Effect.mapError(socketErrorToVoiceError))

    return {
      send,
      events: Stream.fromQueue(queue)
    }
  })
