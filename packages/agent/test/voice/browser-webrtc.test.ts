import { Effect, Exit, Fiber, Scope, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  makeWebRtcVoiceTransport,
  type WebRtcDataChannelLike,
  type WebRtcMediaStreamLike,
  type WebRtcMessageEventLike,
  type WebRtcPeerConnectionLike,
  type WebRtcTrackEventLike,
  type WebRtcVoiceRuntime
} from '../../src/voice/browser/index.ts'
import { VoiceSessionError, VoiceUserTranscriptFinal, type VoiceEvent } from '../../src/voice/index.ts'

type FakeListenerEvent = WebRtcMessageEventLike & WebRtcTrackEventLike

type FakeListeners = Map<string, Array<(event: FakeListenerEvent) => void>>

const addListener = (
  listeners: FakeListeners,
  type: string,
  listener: (event: FakeListenerEvent) => void
) => {
  listeners.set(type, [...(listeners.get(type) ?? []), listener])
}

const removeListener = (
  listeners: FakeListeners,
  type: string,
  listener: (event: FakeListenerEvent) => void
) => {
  listeners.set(
    type,
    (listeners.get(type) ?? []).filter(existing => existing !== listener)
  )
}

const fire = (listeners: FakeListeners, type: string, data?: unknown) => {
  const event: FakeListenerEvent = { data, streams: [] }

  for (const listener of listeners.get(type) ?? []) {
    listener(event)
  }
}

const listenerCount = (listeners: FakeListeners) =>
  [...listeners.values()].reduce((total, group) => total + group.length, 0)

type FakeWorld = {
  readonly runtime: WebRtcVoiceRuntime
  readonly state: FakeWorldState
  readonly peerListeners: FakeListeners
  readonly channelListeners: FakeListeners
  readonly fireChannelMessage: (data: unknown) => void
  readonly openConnection: () => void
  readonly failConnection: () => void
  readonly closeChannel: () => void
  readonly setChannelReadyState: (readyState: string) => void
}

type FakeWorldState = {
  stoppedTracks: number
  peerClosed: boolean
  channelClosed: boolean
  sent: Array<string>
  connectOnRemoteDescription: boolean
  getUserMediaError: Error | undefined
  remoteDescriptions: Array<string>
}

const makeFakeWorld = (): FakeWorld => {
  const state: FakeWorldState = {
    stoppedTracks: 0,
    peerClosed: false,
    channelClosed: false,
    sent: [],
    connectOnRemoteDescription: true,
    getUserMediaError: undefined,
    remoteDescriptions: []
  }
  const peerListeners: FakeListeners = new Map()
  const channelListeners: FakeListeners = new Map()
  let connectionState = 'new'
  let channelReadyState = 'connecting'

  const channel: WebRtcDataChannelLike = {
    get readyState() {
      return channelReadyState
    },
    send(data) {
      state.sent.push(data)
    },
    close() {
      state.channelClosed = true
      channelReadyState = 'closed'
    },
    addEventListener(type, listener) {
      addListener(channelListeners, type, listener)
    },
    removeEventListener(type, listener) {
      removeListener(channelListeners, type, listener)
    }
  }

  const peerConnection: WebRtcPeerConnectionLike = {
    get connectionState() {
      return connectionState
    },
    createDataChannel: () => channel,
    addTrack: () => undefined,
    createOffer: () => Promise.resolve({ sdp: 'offer-sdp' }),
    setLocalDescription: () => Promise.resolve(),
    setRemoteDescription: description => {
      state.remoteDescriptions.push(description.sdp)

      if (state.connectOnRemoteDescription) {
        connectionState = 'connected'
        channelReadyState = 'open'
        fire(peerListeners, 'connectionstatechange', undefined)
        fire(channelListeners, 'open', undefined)
      }

      return Promise.resolve()
    },
    close() {
      state.peerClosed = true
      connectionState = 'closed'
    },
    addEventListener(type, listener) {
      addListener(peerListeners, type, listener)
    },
    removeEventListener(type, listener) {
      removeListener(peerListeners, type, listener)
    }
  }

  const mediaStream: WebRtcMediaStreamLike = {
    getAudioTracks: () => [
      {
        stop() {
          state.stoppedTracks += 1
        }
      }
    ],
    getTracks: () => [
      {
        stop() {
          state.stoppedTracks += 1
        }
      }
    ]
  }

  const runtime: WebRtcVoiceRuntime = {
    makePeerConnection: () => peerConnection,
    getUserMedia: () =>
      state.getUserMediaError === undefined
        ? Promise.resolve(mediaStream)
        : Promise.reject(state.getUserMediaError)
  }

  return {
    runtime,
    state,
    peerListeners,
    channelListeners,
    fireChannelMessage: data => fire(channelListeners, 'message', data),
    openConnection: () => {
      connectionState = 'connected'
      channelReadyState = 'open'
      fire(peerListeners, 'connectionstatechange', undefined)
      fire(channelListeners, 'open', undefined)
    },
    failConnection: () => {
      connectionState = 'failed'
      fire(peerListeners, 'connectionstatechange', undefined)
    },
    closeChannel: () => {
      channelReadyState = 'closed'
      fire(channelListeners, 'close', undefined)
    },
    setChannelReadyState: readyState => {
      channelReadyState = readyState
    }
  }
}

const decodeMessage = (raw: string): ReadonlyArray<VoiceEvent> => [
  VoiceUserTranscriptFinal.make({ itemId: null, text: raw })
]

const makeTransportOptions = (world: FakeWorld) => ({
  negotiate: (offerSdp: string) =>
    offerSdp === 'offer-sdp'
      ? Effect.succeed('answer-sdp')
      : Effect.fail(
          new VoiceSessionError({ code: 'session_setup_failed', message: 'Unexpected offer' })
        ),
  decodeMessage,
  dataChannelLabel: 'oai-events',
  runtime: world.runtime
})

describe('makeWebRtcVoiceTransport', () => {
  it.effect('connects, decodes messages, and sends over the data channel', () =>
    Effect.gen(function* () {
      const world = makeFakeWorld()

      yield* Effect.scoped(
        Effect.gen(function* () {
          const transport = yield* makeWebRtcVoiceTransport(makeTransportOptions(world))

          world.fireChannelMessage('hello-from-provider')

          const events = yield* transport.events.pipe(Stream.take(2), Stream.runCollect)

          expect([...events].map(event => event._tag)).toEqual([
            'SessionOpening',
            'UserTranscriptFinal'
          ])
          yield* transport.send('client-event')
        })
      )

      expect(world.state.remoteDescriptions).toEqual(['answer-sdp'])
      expect(world.state.sent).toEqual(['client-event'])
    })
  )

  it.effect('releases microphone, peer connection, channel, and listeners on scope close', () =>
    Effect.gen(function* () {
      const world = makeFakeWorld()
      const scope = yield* Scope.make()
      const transport = yield* Scope.provide(
        makeWebRtcVoiceTransport(makeTransportOptions(world)),
        scope
      )
      const collected = yield* Effect.forkChild(Stream.runCollect(transport.events))

      yield* Scope.close(scope, Exit.void)

      const events = yield* Fiber.join(collected)

      expect([...events].map(event => event._tag)).toEqual(['SessionOpening'])
      expect(world.state.stoppedTracks).toBeGreaterThan(0)
      expect(world.state.peerClosed).toBe(true)
      expect(world.state.channelClosed).toBe(true)
      expect(listenerCount(world.peerListeners)).toBe(0)
      expect(listenerCount(world.channelListeners)).toBe(0)
    })
  )

  it.effect('fails with permission_denied when microphone access is rejected', () =>
    Effect.gen(function* () {
      const world = makeFakeWorld()
      world.state.getUserMediaError = new Error('denied by user')

      const error = yield* Effect.scoped(
        makeWebRtcVoiceTransport(makeTransportOptions(world))
      ).pipe(Effect.flip)

      expect(error.code).toBe('permission_denied')
      expect(error.message).toContain('denied by user')
    })
  )

  it.effect('cleans up when negotiation fails', () =>
    Effect.gen(function* () {
      const world = makeFakeWorld()
      const error = yield* Effect.scoped(
        makeWebRtcVoiceTransport({
          ...makeTransportOptions(world),
          negotiate: () =>
            Effect.fail(
              new VoiceSessionError({ code: 'session_setup_failed', message: 'SDP exchange failed' })
            )
        })
      ).pipe(Effect.flip)

      expect(error.code).toBe('session_setup_failed')
      expect(world.state.peerClosed).toBe(true)
      expect(world.state.channelClosed).toBe(true)
      expect(world.state.stoppedTracks).toBeGreaterThan(0)
    })
  )

  it.live('fails when the session never becomes ready before the timeout', () =>
    Effect.gen(function* () {
      const world = makeFakeWorld()
      world.state.connectOnRemoteDescription = false

      const error = yield* Effect.scoped(
        makeWebRtcVoiceTransport({ ...makeTransportOptions(world), readyTimeoutMs: 25 })
      ).pipe(Effect.flip)

      expect(error.code).toBe('session_setup_failed')
      expect(error.message).toContain('timed out')
    })
  )

  it.live('fails setup when the data channel closes before ready', () =>
    Effect.gen(function* () {
      const world = makeFakeWorld()
      world.state.connectOnRemoteDescription = false

      const transportFiber = yield* Effect.forkChild(
        Effect.scoped(makeWebRtcVoiceTransport(makeTransportOptions(world))).pipe(Effect.flip)
      )

      yield* Effect.sleep('10 millis')
      world.closeChannel()

      const error = yield* Fiber.join(transportFiber)

      expect(error.code).toBe('transport_failed')
      expect(error.message).toContain('closed before ready')
    })
  )

  it.effect('ends the event stream when the connection fails after ready', () =>
    Effect.gen(function* () {
      const world = makeFakeWorld()

      yield* Effect.scoped(
        Effect.gen(function* () {
          const transport = yield* makeWebRtcVoiceTransport(makeTransportOptions(world))
          const collected = yield* Effect.forkChild(Stream.runCollect(transport.events))

          world.failConnection()

          const events = yield* Fiber.join(collected)

          expect([...events].map(event => event._tag)).toEqual(['SessionOpening', 'Error'])
        })
      )
    })
  )

  it.effect('fails send when the data channel is not open', () =>
    Effect.gen(function* () {
      const world = makeFakeWorld()

      yield* Effect.scoped(
        Effect.gen(function* () {
          const transport = yield* makeWebRtcVoiceTransport(makeTransportOptions(world))

          world.setChannelReadyState('closed')

          const error = yield* transport.send('late-event').pipe(Effect.flip)

          expect(error.code).toBe('transport_failed')
          expect(error.message).toContain('not open')
        })
      )
    })
  )
})
