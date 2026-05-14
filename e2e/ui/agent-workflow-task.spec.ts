import { createServer, type ServerResponse } from 'node:http'
import type { Page } from '@playwright/test'
import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { test, expect } from '../fixtures'
import { TestDbLayer } from '../utils/test-db'

const slowCall = {
  id: 'call_slow_task',
  name: 'task',
  params: { description: 'slow task', prompt: 'slow', subagent_type: 'general' }
}

const fastCall = {
  id: 'call_fast_task',
  name: 'task',
  params: { description: 'fast task', prompt: 'fast', subagent_type: 'general' }
}

const result = (call: typeof slowCall, startedAtMs: number, endedAtMs: number) => ({
  toolCallId: call.id,
  content: `<task_result>done ${call.id}</task_result>`,
  structuredContent: {
    subagent_run_id: `subagent:${call.id}`,
    subagent_type: 'general',
    description: call.params.description,
    started_at_ms: startedAtMs,
    ended_at_ms: endedAtMs,
    duration_ms: endedAtMs - startedAtMs,
    status: 'completed',
    model: 'e2e-model'
  }
})

const writeEvent = (response: ServerResponse, event: unknown) => {
  response.write(`${JSON.stringify(event)}\n`)
}

const loginEmail = 'e2e-test@example.com'
const loginOtp = '123456'

const seedLoginOtp = () =>
  Effect.gen(function* () {
    const db = yield* Db
    yield* db.delete(schema.verification).where(eq(schema.verification.identifier, `sign-in-otp-${loginEmail}`))
    yield* db.insert(schema.verification).values({
      id: createId(),
      identifier: `sign-in-otp-${loginEmail}`,
      value: `${loginOtp}:0`,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000)
    })
  }).pipe(Effect.provide(TestDbLayer), Effect.scoped, Effect.runPromise)

const login = async (page: Page) => {
  await seedLoginOtp()
  await page.goto(`/login/otp?email=${encodeURIComponent(loginEmail)}`)
  await page.getByRole('textbox').fill(loginOtp)
  await page.waitForURL(url => url.pathname === '/', { timeout: 15_000 })
}

const startWorkflowStreamServer = async () => {
  let releaseCompletions: (() => void) | undefined
  const completionsReleased = new Promise<void>(resolve => {
    releaseCompletions = resolve
  })
  const server = createServer((_request, response) => {
    const startedAtMs = Date.now()
    response.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'x-workflow-run-id': 'e2e-task-parallel-run'
    })
    writeEvent(response, { _tag: 'AgentStart' })
    writeEvent(response, { _tag: 'TurnStart', turn: 1 })
    writeEvent(response, { _tag: 'LLMStreamStart', turn: 1 })
    writeEvent(response, { _tag: 'ToolInputEnd', call: slowCall })
    writeEvent(response, { _tag: 'ToolInputEnd', call: fastCall })
    writeEvent(response, { _tag: 'LLMStreamEnd', turn: 1 })
    writeEvent(response, {
      _tag: 'AssistantMessage',
      message: {
        _tag: 'Assistant',
        parts: [
          { _tag: 'HostToolCall', call: slowCall },
          { _tag: 'HostToolCall', call: fastCall }
        ]
      }
    })
    writeEvent(response, { _tag: 'ToolExecutionStarted', call: slowCall, createdAtMs: startedAtMs })
    writeEvent(response, {
      _tag: 'SubagentStarted',
      parentToolCallId: slowCall.id,
      subagentRunId: `subagent:${slowCall.id}`,
      subagentType: 'general',
      description: slowCall.params.description,
      model: 'e2e-model',
      createdAtMs: startedAtMs
    })
    writeEvent(response, { _tag: 'ToolExecutionStarted', call: fastCall, createdAtMs: startedAtMs })
    writeEvent(response, {
      _tag: 'SubagentStarted',
      parentToolCallId: fastCall.id,
      subagentRunId: `subagent:${fastCall.id}`,
      subagentType: 'general',
      description: fastCall.params.description,
      model: 'e2e-model',
      createdAtMs: startedAtMs
    })

    completionsReleased.then(() => {
      const endedAtMs = Date.now()
      writeEvent(response, { _tag: 'ToolExecutionCompleted', call: slowCall, result: result(slowCall, startedAtMs, endedAtMs), createdAtMs: endedAtMs })
      writeEvent(response, { _tag: 'ToolExecutionCompleted', call: fastCall, result: result(fastCall, startedAtMs, endedAtMs), createdAtMs: endedAtMs })
      writeEvent(response, { _tag: 'TurnEnd', turn: 1, reason: 'tool_use' })
      writeEvent(response, {
        _tag: 'AgentEnd',
        messages: [],
        turns: 1,
        usage: { input: { total: 0 }, output: { total: 0 } }
      })
      response.end()
    })
  })

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()

  if (address === null || typeof address === 'string') {
    throw new Error('Expected local stream server port')
  }

  return {
    url: `http://127.0.0.1:${address.port}/workflow`,
    releaseCompletions: () => releaseCompletions?.(),
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  }
}

test('shows same-turn workflow task subagents running concurrently', async ({ page }) => {
  const streamServer = await startWorkflowStreamServer()

  try {
    await login(page)

    await page.route('**/api/agent/workflow', async route => {
      await route.continue({ url: streamServer.url })
    })

    await page.goto('/agent/workflow')
    await expect(page.getByLabel('Agent prompt')).toHaveCount(1, { timeout: 15_000 })

    await page.getByLabel('Agent prompt').fill('run two subagents')
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(page.getByRole('button', { name: 'tool Task: slow task', exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('button', { name: 'tool Task: fast task', exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Running 3 tools')).toBeVisible()

    streamServer.releaseCompletions()

    await expect(page.getByRole('button', { name: /Task: slow task.*\d+ms/ })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('button', { name: /Task: fast task.*\d+ms/ })).toBeVisible({ timeout: 15_000 })
  } finally {
    await streamServer.close()
  }
})
