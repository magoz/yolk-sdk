import path from 'node:path'
import { test, expect } from '../fixtures'

const fakeMicAudioPath = path.join(process.cwd(), 'e2e/assets/voice-alpha-beta-gamma-delayed.wav')

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${fakeMicAudioPath}`
    ]
  }
})

const mockRealtimeBrowserApis = `
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
    window.setTimeout(() => this.channel?.open(), 0)
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
  await authedPage.getByRole('button', { name: 'Start voice mode' }).click()

  await expect(authedPage.getByText('Voice session opened')).toBeVisible({ timeout: 15_000 })
  await expect(authedPage.getByText('voice connecting')).toHaveCount(2)

  await authedPage.evaluate(() => window.dispatchEvent(new Event('yolk-voice-test-connect')))

  await expect(authedPage.getByText('Voice transport ready')).toBeVisible({ timeout: 15_000 })
  await expect(authedPage.getByText('voice live')).toHaveCount(2)
})

test('voice mode transcribes first fake microphone words', async ({ authedPage }) => {
  test.setTimeout(90_000)
  test.skip(
    process.env.OPENAI_API_KEY === undefined || process.env.OPENAI_API_KEY === '',
    'OPENAI_API_KEY required for live Realtime voice E2E'
  )

  await authedPage.goto('/agent/next')
  await expect(authedPage.getByLabel('Agent prompt')).toHaveCount(1, { timeout: 15_000 })
  await authedPage.getByRole('button', { name: 'Activity' }).click()
  await authedPage.getByRole('button', { name: 'Start voice mode' }).click()

  await expect(authedPage.getByText('Voice transport ready')).toBeVisible({ timeout: 30_000 })
  await expect(authedPage.getByText(/alpha beta gamma/i)).toBeVisible({ timeout: 60_000 })

  await authedPage.getByRole('button', { name: 'Stop voice mode' }).click()
})
