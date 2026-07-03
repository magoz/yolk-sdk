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
