import { test, expect } from '../fixtures'

declare global {
  interface Window {
    yolkVoiceTestChannelOpen: Promise<void>
    yolkVoiceTestPeerConnectionState: () => string
  }
}

const mockRealtimeBrowserApis = `
let settleChannelOpen
window.yolkVoiceTestChannelOpen = new Promise(resolve => {
  settleChannelOpen = resolve
})

class FakeDataChannel extends EventTarget {
  readyState = 'connecting'
  sent = []

  send(value) {
    this.sent.push(value)
  }

  close() {
    this.readyState = 'closed'
    this.dispatchEvent(new Event('close'))
  }

  open() {
    this.readyState = 'open'
    this.dispatchEvent(new Event('open'))
    settleChannelOpen()
  }
}

class FakePeerConnection extends EventTarget {
  connectionState = 'connecting'
  channel = null

  createDataChannel() {
    const channel = new FakeDataChannel()
    this.channel = channel
    return channel
  }

  addTrack() {}

  async createOffer() {
    return { type: 'offer', sdp: 'v=0\\r\\n' }
  }

  async setLocalDescription() {}

  async setRemoteDescription() {
    this.channel?.open()
  }

  close() {
    this.connectionState = 'closed'
    this.dispatchEvent(new Event('connectionstatechange'))
  }

  connect() {
    this.connectionState = 'connected'
    this.dispatchEvent(new Event('connectionstatechange'))
  }
}

const sessions = []

window.yolkVoiceTestPeerConnectionState = () => sessions.at(-1)?.connectionState ?? 'absent'

Object.defineProperty(navigator, 'mediaDevices', {
  configurable: true,
  value: {
    getUserMedia: async () => ({
      getAudioTracks: () => [{ stop() {} }],
      getTracks: () => [{ stop() {} }]
    })
  }
})

Object.defineProperty(window, 'RTCPeerConnection', {
  configurable: true,
  value: class extends FakePeerConnection {
    constructor() {
      super()
      sessions.push(this)
    }
  }
})

window.addEventListener('yolk-voice-test-connect', () => {
  sessions.at(-1)?.connect()
})
`

test('voice mode waits for connected WebRTC transport before live', async ({ authedPage }) => {
  await authedPage.addInitScript({ content: mockRealtimeBrowserApis })
  await authedPage.route('**/api/agent/realtime/call?*', async route => {
    await route.fulfill({ status: 200, contentType: 'application/sdp', body: 'v=0\r\n' })
  })

  await authedPage.goto('/agent/next')
  await expect(authedPage.getByLabel('Agent prompt')).toHaveCount(1, { timeout: 15_000 })
  await authedPage.getByRole('button', { name: 'Activity' }).click()
  await authedPage.getByRole('button', { name: 'Start realtime voice' }).click()

  await authedPage.evaluate(() => window.yolkVoiceTestChannelOpen)

  await expect(authedPage.getByText('voice connecting')).toHaveCount(2, { timeout: 15_000 })
  expect(await authedPage.evaluate(() => window.yolkVoiceTestPeerConnectionState())).not.toBe(
    'connected'
  )

  await authedPage.evaluate(() => window.dispatchEvent(new Event('yolk-voice-test-connect')))

  await expect(authedPage.getByText('voice live')).toHaveCount(2, { timeout: 15_000 })
})
