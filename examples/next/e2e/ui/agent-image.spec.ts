import { Buffer } from 'node:buffer'
import { Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import {
  AgentEnd,
  AgentStart,
  UserMessage,
  contentParts,
  zeroAgentUsage
} from '@yolk-sdk/agent/protocol'
import { test, expect } from '../fixtures'

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

const agentResponse = [
  JSON.stringify(AgentStart.make({})),
  JSON.stringify(AgentEnd.make({ messages: [], turns: 1, usage: zeroAgentUsage }))
].join('\n')

const capturedImageParts = (body: string) => {
  const parsed: unknown = JSON.parse(body)

  if (!Predicate.hasProperty(parsed, 'messages') || !Array.isArray(parsed.messages)) {
    return []
  }

  return parsed.messages.flatMap(message =>
    Option.match(Schema.decodeUnknownOption(UserMessage)(message), {
      onNone: () => [],
      onSome: user => contentParts(user.content).filter(part => Predicate.isTagged(part, 'Image'))
    })
  )
}

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
  await authedPage.getByRole('button', { name: 'Attach files' }).click()
  await (await fileChooser).setFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: tinyPng })

  await expect(authedPage.getByRole('img', { name: 'Attached image preview' })).toBeVisible()
  await authedPage.getByLabel('Agent prompt').fill('Describe this image')
  await authedPage.getByRole('button', { name: 'Send' }).click()

  await expect(authedPage.getByRole('img', { name: 'Uploaded image' })).toBeVisible()
  await expect.poll(() => capturedBody).toContain('Describe this image')

  const images = capturedImageParts(capturedBody)
  expect(images).toHaveLength(1)
  expect(images[0]?.mimeType).toBe('image/png')
})
