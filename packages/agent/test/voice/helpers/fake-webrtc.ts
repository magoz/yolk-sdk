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

const fire = (
  listeners: FakeListeners,
  type: string,
  event: FakeListenerEvent = { data: undefined, streams: [] }
) => {
  for (const listener of listeners.get(type) ?? []) {
    listener(event)
  }
}

const channelMessageEvent = (data: string): FakeListenerEvent => ({
  data,
  streams: []
})

export const listenerCount = (listeners: FakeListeners) =>
  [...listeners.values()].reduce((total, group) => total + group.length, 0)

export type FakeWorldState = {
  stoppedTracks: number
  peerClosed: boolean
  channelClosed: boolean
  peerCreateCount: number
  sent: Array<string>
  connectOnRemoteDescription: boolean
  getUserMediaError: Error | undefined
  remoteDescriptions: Array<string>
}

export type FakePeerConnection = {
  readonly peer: WebRtcPeerConnectionLike
  readonly channel: WebRtcDataChannelLike
  readonly peerListeners: FakeListeners
  readonly channelListeners: FakeListeners
  readonly isPeerClosed: () => boolean
  readonly isChannelClosed: () => boolean
  readonly openConnection: () => void
  readonly failConnection: () => void
  readonly closeChannel: () => void
  readonly setChannelReadyState: (readyState: string) => void
}

export type FakeWorld = {
  readonly runtime: WebRtcVoiceRuntime
  readonly state: FakeWorldState
  readonly connections: Array<FakePeerConnection>
  readonly peerListeners: FakeListeners
  readonly channelListeners: FakeListeners
  readonly fireChannelMessage: (data: string) => void
  readonly fireChannelMessageOn: (connection: FakePeerConnection, data: string) => void
  readonly fireChannelMessageEvent: (event: WebRtcMessageEventLike) => void
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
    peerCreateCount: 0,
    sent: [],
    connectOnRemoteDescription: true,
    getUserMediaError: undefined,
    remoteDescriptions: []
  }

  const connections: Array<FakePeerConnection> = []
  const idlePeerListeners: FakeListeners = new Map()
  const idleChannelListeners: FakeListeners = new Map()

  const current = () => connections.at(-1)

  const makeMediaStream = (): WebRtcMediaStreamLike => ({
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
  })

  const makeConnection = (): FakePeerConnection => {
    const peerListeners: FakeListeners = new Map()
    const channelListeners: FakeListeners = new Map()
    let connectionState = 'new'
    let channelReadyState = 'connecting'
    let peerClosed = false
    let channelClosed = false

    const openConnection = () => {
      connectionState = 'connected'
      channelReadyState = 'open'
      fire(peerListeners, 'connectionstatechange')
      fire(channelListeners, 'open')
    }

    const channel: WebRtcDataChannelLike = {
      get readyState() {
        return channelReadyState
      },
      send(data) {
        state.sent.push(data)
      },
      close() {
        channelClosed = true
        channelReadyState = 'closed'

        if (current()?.channel === channel) {
          state.channelClosed = true
        }
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
      addTrack: () => {},
      createOffer: () => Promise.resolve({ sdp: 'offer-sdp' }),
      setLocalDescription: () => Promise.resolve(),
      setRemoteDescription: description => {
        state.remoteDescriptions.push(description.sdp)

        if (state.connectOnRemoteDescription) {
          openConnection()
        }

        return Promise.resolve()
      },
      close() {
        peerClosed = true
        connectionState = 'closed'

        if (current()?.peer === peerConnection) {
          state.peerClosed = true
        }
      },
      addEventListener(type, listener) {
        addListener(peerListeners, type, listener)
      },
      removeEventListener(type, listener) {
        removeListener(peerListeners, type, listener)
      }
    }

    return {
      peer: peerConnection,
      channel,
      peerListeners,
      channelListeners,
      isPeerClosed: () => peerClosed,
      isChannelClosed: () => channelClosed,
      openConnection,
      failConnection: () => {
        connectionState = 'failed'
        fire(peerListeners, 'connectionstatechange')
      },
      closeChannel: () => {
        channelReadyState = 'closed'
        fire(channelListeners, 'close')
      },
      setChannelReadyState: readyState => {
        channelReadyState = readyState
      }
    }
  }

  const runtime: WebRtcVoiceRuntime = {
    makePeerConnection: () => {
      state.peerCreateCount += 1
      const connection = makeConnection()
      connections.push(connection)
      state.peerClosed = false
      state.channelClosed = false

      return connection.peer
    },
    getUserMedia: () =>
      state.getUserMediaError === undefined
        ? Promise.resolve(makeMediaStream())
        : Promise.reject(state.getUserMediaError)
  }

  return {
    runtime,
    state,
    connections,
    get peerListeners() {
      return current()?.peerListeners ?? idlePeerListeners
    },
    get channelListeners() {
      return current()?.channelListeners ?? idleChannelListeners
    },
    fireChannelMessage: data => {
      const connection = current()

      if (connection !== undefined) {
        fire(connection.channelListeners, 'message', channelMessageEvent(data))
      }
    },
    fireChannelMessageOn: (connection, data) => {
      fire(connection.channelListeners, 'message', channelMessageEvent(data))
    },
    fireChannelMessageEvent: event => {
      const connection = current()

      if (connection !== undefined) {
        fire(connection.channelListeners, 'message', { data: event.data, streams: [] })
      }
    },
    openConnection: () => {
      current()?.openConnection()
    },
    failConnection: () => {
      current()?.failConnection()
    },
    closeChannel: () => {
      current()?.closeChannel()
    },
    setChannelReadyState: readyState => {
      current()?.setChannelReadyState(readyState)
    }
  }
}
