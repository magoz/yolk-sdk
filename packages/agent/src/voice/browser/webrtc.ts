import { Deferred, Duration, Effect, Queue, Stream, type Cause, type Scope } from 'effect'
import {
  VoiceErrorEvent,
  VoiceSessionClosed,
  VoiceSessionError,
  VoiceSessionOpening,
  type VoiceEvent
} from '../protocol.ts'
import type { VoiceTransportApi } from '../transport.ts'

// Minimal structural WebRTC types. Real DOM objects satisfy these shapes, and
// tests can provide plain fakes without jsdom WebRTC support.

export type WebRtcTrackLike = {
  stop(): void
}

export type WebRtcMediaStreamLike = {
  getAudioTracks(): Array<WebRtcTrackLike>
  getTracks(): Array<WebRtcTrackLike>
}

export type WebRtcMessageEventLike = {
  readonly data: unknown
}

export type WebRtcTrackEventLike = {
  readonly streams: ReadonlyArray<WebRtcMediaStreamLike>
}

export type WebRtcDataChannelLike = {
  readonly readyState: string
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: (event: WebRtcMessageEventLike) => void): void
  removeEventListener(type: string, listener: (event: WebRtcMessageEventLike) => void): void
}

export type WebRtcSessionDescriptionLike = {
  readonly sdp?: string
}

export type WebRtcPeerConnectionLike = {
  readonly connectionState: string
  createDataChannel(label: string): WebRtcDataChannelLike
  addTrack(track: WebRtcTrackLike, stream: WebRtcMediaStreamLike): unknown
  createOffer(): Promise<WebRtcSessionDescriptionLike>
  setLocalDescription(description: WebRtcSessionDescriptionLike): Promise<void>
  setRemoteDescription(description: { readonly type: 'answer'; readonly sdp: string }): Promise<void>
  close(): void
  addEventListener(type: string, listener: (event: WebRtcTrackEventLike) => void): void
  removeEventListener(type: string, listener: (event: WebRtcTrackEventLike) => void): void
}

/** Seam for browser globals so unit tests can inject fakes. */
export type WebRtcVoiceRuntime = {
  readonly makePeerConnection: () => WebRtcPeerConnectionLike
  readonly getUserMedia: () => Promise<WebRtcMediaStreamLike>
}

export type WebRtcVoiceTransportOptions = {
  /** Host-owned SDP exchange, e.g. POST offer SDP to an app route. */
  readonly negotiate: (offerSdp: string) => Effect.Effect<string, VoiceSessionError>
  /** Provider codec: raw data-channel string to provider-neutral events. */
  readonly decodeMessage: (raw: string) => ReadonlyArray<VoiceEvent>
  /** Provider data channel label, e.g. `oai-events` for OpenAI Realtime. */
  readonly dataChannelLabel: string
  /** Host hook to attach the remote audio stream to an audio element. */
  readonly onRemoteAudioStream?: (stream: WebRtcMediaStreamLike) => void
  readonly readyTimeoutMs?: number
  readonly runtime?: WebRtcVoiceRuntime
}

const defaultReadyTimeoutMs = 10_000

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const setupError = (message: string) => (error: unknown) =>
  new VoiceSessionError({
    code: 'session_setup_failed',
    message: `${message}: ${unknownToMessage(error)}`
  })

/**
 * Default browser runtime. Fails with a typed error outside browsers or when
 * WebRTC/microphone APIs are unavailable. No top-level DOM access; globals
 * are only touched when a transport is created.
 */
export const defaultWebRtcVoiceRuntime: Effect.Effect<WebRtcVoiceRuntime, VoiceSessionError> =
  Effect.suspend(() => {
    if (
      typeof RTCPeerConnection === 'undefined' ||
      typeof navigator === 'undefined' ||
      navigator.mediaDevices === undefined
    ) {
      return Effect.fail(
        new VoiceSessionError({
          code: 'transport_failed',
          message: 'WebRTC voice is not available in this environment'
        })
      )
    }

    return Effect.succeed({
      makePeerConnection: (): WebRtcPeerConnectionLike => new RTCPeerConnection(),
      getUserMedia: (): Promise<WebRtcMediaStreamLike> =>
        navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true
          }
        })
    })
  })

/**
 * Browser WebRTC voice transport. Connects during acquisition: microphone,
 * peer connection, provider data channel, SDP negotiation, and readiness.
 * Closing the surrounding `Scope` releases every resource and ends the event
 * stream. Reconnect is a new transport; provider sessions do not resume.
 */
export const makeWebRtcVoiceTransport = (
  options: WebRtcVoiceTransportOptions
): Effect.Effect<VoiceTransportApi, VoiceSessionError, Scope.Scope> =>
  Effect.gen(function* () {
    const runtime = options.runtime ?? (yield* defaultWebRtcVoiceRuntime)
    const queue = yield* Queue.unbounded<VoiceEvent, VoiceSessionError | Cause.Done>()

    yield* Queue.offer(queue, VoiceSessionOpening.make({}))

    const mediaStream = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => runtime.getUserMedia(),
        catch: error =>
          new VoiceSessionError({
            code: 'permission_denied',
            message: `Microphone access failed: ${unknownToMessage(error)}`
          })
      }),
      stream =>
        Effect.sync(() => {
          for (const track of stream.getTracks()) {
            track.stop()
          }
        })
    )
    const audioTrack = mediaStream.getAudioTracks()[0]

    if (audioTrack === undefined) {
      return yield* Effect.fail(
        new VoiceSessionError({
          code: 'session_setup_failed',
          message: 'No microphone track available'
        })
      )
    }

    const peerConnection = yield* Effect.acquireRelease(
      Effect.sync(() => runtime.makePeerConnection()),
      connection => Effect.sync(() => connection.close())
    )
    const dataChannel = peerConnection.createDataChannel(options.dataChannelLabel)
    yield* Effect.addFinalizer(() => Effect.sync(() => dataChannel.close()))
    peerConnection.addTrack(audioTrack, mediaStream)

    const ready = yield* Deferred.make<void, VoiceSessionError>()
    const failReadyUnsafe = (message: string) => {
      Deferred.doneUnsafe(
        ready,
        Effect.fail(new VoiceSessionError({ code: 'transport_failed', message }))
      )
    }
    const checkReadyUnsafe = () => {
      if (peerConnection.connectionState === 'connected' && dataChannel.readyState === 'open') {
        Deferred.doneUnsafe(ready, Effect.void)
      }
    }
    const handleTrack = (event: WebRtcTrackEventLike) => {
      const stream = event.streams[0]

      if (stream !== undefined) {
        options.onRemoteAudioStream?.(stream)
      }
    }
    const handleConnectionStateChange = () => {
      if (
        peerConnection.connectionState === 'failed' ||
        peerConnection.connectionState === 'closed'
      ) {
        failReadyUnsafe('WebRTC connection failed')
        Queue.offerUnsafe(
          queue,
          VoiceErrorEvent.make({ code: 'transport_failed', message: 'Voice connection failed' })
        )
        Queue.endUnsafe(queue)
        return
      }

      checkReadyUnsafe()
    }
    const handleChannelOpen = () => {
      checkReadyUnsafe()
    }
    const handleChannelClose = () => {
      failReadyUnsafe('Voice data channel closed before ready')
      Queue.offerUnsafe(queue, VoiceSessionClosed.make({ reason: 'data_channel_closed' }))
      Queue.endUnsafe(queue)
    }
    const handleChannelError = () => {
      failReadyUnsafe('Voice data channel failed')
      Queue.offerUnsafe(
        queue,
        VoiceErrorEvent.make({ code: 'transport_failed', message: 'Voice data channel failed' })
      )
      Queue.endUnsafe(queue)
    }
    const handleChannelMessage = (event: WebRtcMessageEventLike) => {
      if (typeof event.data !== 'string') {
        return
      }

      for (const voiceEvent of options.decodeMessage(event.data)) {
        Queue.offerUnsafe(queue, voiceEvent)
      }
    }

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        peerConnection.addEventListener('track', handleTrack)
        peerConnection.addEventListener('connectionstatechange', handleConnectionStateChange)
        dataChannel.addEventListener('open', handleChannelOpen)
        dataChannel.addEventListener('close', handleChannelClose)
        dataChannel.addEventListener('error', handleChannelError)
        dataChannel.addEventListener('message', handleChannelMessage)
      }),
      () =>
        Effect.sync(() => {
          peerConnection.removeEventListener('track', handleTrack)
          peerConnection.removeEventListener('connectionstatechange', handleConnectionStateChange)
          dataChannel.removeEventListener('open', handleChannelOpen)
          dataChannel.removeEventListener('close', handleChannelClose)
          dataChannel.removeEventListener('error', handleChannelError)
          dataChannel.removeEventListener('message', handleChannelMessage)
        }).pipe(Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)))
    )

    const offer = yield* Effect.tryPromise({
      try: () => peerConnection.createOffer(),
      catch: setupError('Could not create WebRTC offer')
    })
    yield* Effect.tryPromise({
      try: () => peerConnection.setLocalDescription(offer),
      catch: setupError('Could not set local WebRTC description')
    })

    if (offer.sdp === undefined) {
      return yield* Effect.fail(
        new VoiceSessionError({
          code: 'session_setup_failed',
          message: 'WebRTC offer SDP missing'
        })
      )
    }

    const answerSdp = yield* options.negotiate(offer.sdp)
    yield* Effect.tryPromise({
      try: () => peerConnection.setRemoteDescription({ type: 'answer', sdp: answerSdp }),
      catch: setupError('Could not set remote WebRTC description')
    })
    yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(options.readyTimeoutMs ?? defaultReadyTimeoutMs),
        orElse: () =>
          Effect.fail(
            new VoiceSessionError({
              code: 'session_setup_failed',
              message: 'Voice session timed out before ready'
            })
          )
      })
    )

    const send = (data: string) =>
      Effect.suspend(() =>
        dataChannel.readyState === 'open'
          ? Effect.sync(() => dataChannel.send(data))
          : Effect.fail(
              new VoiceSessionError({
                code: 'transport_failed',
                message: 'Voice data channel is not open'
              })
            )
      )

    return {
      send,
      events: Stream.fromQueue(queue)
    }
  })
