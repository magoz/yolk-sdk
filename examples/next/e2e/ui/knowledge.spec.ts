import { and, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { test, expect } from '../fixtures'
import { TEST_USER_ID } from '../test-ids'
import { TestDbLayer } from '../utils/test-db'
import * as schema from '@/lib/services/db/schema'
import { Db } from '@/lib/services/db/live-layer'

const title = 'E2E knowledge note alpha'
const content = 'E2E durable knowledge alpha marker for search and policy smoke.'

test.describe('knowledge UI', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(120_000)
  test.skip(
    process.env.OPENAI_API_KEY === undefined || process.env.OPENAI_API_KEY.length === 0,
    'OPENAI_API_KEY required for knowledge embeddings'
  )

  test.beforeAll(async () => {
    await Effect.gen(function* () {
      const db = yield* Db
      yield* db
        .delete(schema.knowledgeRecord)
        .where(
          and(
            eq(schema.knowledgeRecord.userId, TEST_USER_ID),
            eq(schema.knowledgeRecord.title, title)
          )
        )
    }).pipe(Effect.provide(TestDbLayer), Effect.scoped, Effect.runPromise)
  })

  test('creates, searches, updates policy, and deletes text knowledge', async ({ authedPage }) => {
    await authedPage.goto('/knowledge', { waitUntil: 'domcontentloaded' })
    await expect(authedPage.getByRole('heading', { name: 'Knowledge', level: 1 })).toBeVisible({
      timeout: 15_000
    })
    await expect(authedPage.getByLabel('Title')).toHaveCount(1, { timeout: 15_000 })

    await authedPage.getByLabel('Title').fill(title)
    await authedPage.getByLabel('Content').fill(content)
    await authedPage.getByRole('button', { name: 'Save knowledge' }).click()

    const objects = authedPage.getByRole('list').filter({
      has: authedPage.getByRole('button', { name: `Delete ${title}` })
    })
    const item = objects.getByRole('listitem').filter({ hasText: title })
    await expect(item).toBeVisible({ timeout: 15_000 })
    await expect(item).toContainText(content)

    await authedPage.getByLabel('Query').fill('alpha marker')
    await authedPage.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(authedPage.getByText('matches')).toBeVisible({ timeout: 15_000 })
    const searchResults = authedPage.getByRole('list').filter({
      has: authedPage.getByText('score')
    })
    await expect(searchResults.getByText(title)).toBeVisible()

    await item.getByLabel(`Set context policy for ${title}`).selectOption('archived')
    await expect(item.getByText('archived', { exact: true }).filter({ visible: true })).toHaveCount(
      1,
      {
        timeout: 15_000
      }
    )

    await item.getByRole('button', { name: `Delete ${title}` }).click()
    await expect(item).toHaveCount(0, { timeout: 15_000 })
  })
})
