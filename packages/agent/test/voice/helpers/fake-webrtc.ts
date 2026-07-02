import type {
  WebRtcDataChannelLike,
  WebRtcMediaStreamLike,
  WebRtcMessageEventLike,
  WebRtcPeerConnectionLike,
  WebRtcTrackEventLike,
  WebRtcVoiceRuntime
} from '../../../src/voice/browser/index.ts'

type FakeListenerEvent = WebRtcMessageEventLike & WebRtcTrackEventLike

export type FakeListeners = Map<string, Array<(event: FakeListenerEvent) => void>>

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

export const listenerCount = (listeners: FakeListeners) =>
  [...listeners.values()].reduce((total, group) => total + group.length, 0)

export type FakeWorldState = {
  stoppedTracks: number
  peerClosed: boolean
  channelClosed: boolean
  sent: Array<string>
  connectOnRemoteDescription: boolean
  getUserMediaError: Error | undefined
  remoteDescriptions: Array<string>
}

export type FakeWorld = {
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

export const makeFakeWorld = (): FakeWorld => {
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
