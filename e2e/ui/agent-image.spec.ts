import { Buffer } from 'node:buffer'
import { test, expect } from '../fixtures'

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

const agentResponse = [
  JSON.stringify({ _tag: 'AgentStart' }),
  JSON.stringify({
    _tag: 'AgentEnd',
    messages: [],
    turns: 1,
    usage: { input: { total: 0 }, output: { total: 0 } }
  })
].join('\n')

test('uploads image prompt and shows provider capabilities', async ({ authedPage }) => {
  let capturedBody = ''

  await authedPage.route('**/api/agent', async route => {
    capturedBody = route.request().postData() ?? ''
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson; charset=utf-8',
      body: `${agentResponse}\n`
    })
  })

  await authedPage.goto('/agent/next')
  await expect(authedPage.getByLabel('Agent prompt')).toHaveCount(1, { timeout: 15_000 })

  await authedPage.getByRole('button', { name: 'Console' }).click()
  await expect(authedPage.getByText('Inputs')).toBeVisible()
  await expect(authedPage.getByText('image', { exact: true })).toBeVisible()
  await authedPage.getByRole('button', { name: 'Close agent console' }).click()

  const fileChooser = authedPage.waitForEvent('filechooser')
  await authedPage.getByRole('button', { name: 'Attach image' }).click()
  await (await fileChooser).setFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: tinyPng })

  await expect(authedPage.getByRole('img', { name: 'Attached image preview' })).toBeVisible()
  await authedPage.getByLabel('Agent prompt').fill('Describe this image')
  await authedPage.getByRole('button', { name: 'Send' }).click()

  await expect(authedPage.getByRole('img', { name: 'Uploaded image' })).toBeVisible()
  await expect.poll(() => capturedBody).toContain('Describe this image')
  expect(capturedBody).toContain('"_tag":"Image"')
  expect(capturedBody).toContain('"mimeType":"image/png"')
})
