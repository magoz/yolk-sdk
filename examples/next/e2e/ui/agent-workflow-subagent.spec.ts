import { createServer, type ServerResponse } from 'node:http'
import type { Page } from '@playwright/test'
import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { Effect, Predicate } from 'effect'
import {
  AgentEnd,
  AgentStart,
  AssistantAgentMessage,
  AssistantMessageEvent,
  HostToolCallPart,
  LLMStreamEnd,
  LLMStreamStart,
  SubagentStarted,
  ToolCall,
  ToolExecutionCompleted,
  ToolExecutionStarted,
  ToolInputEnd,
  TurnEnd,
  TurnStart,
  makeSubagentRunId,
  zeroAgentUsage,
  type AgentEvent
} from '@yolk-sdk/agent/protocol'
import { makeSubagentToolResult, subagentToolName } from '@yolk-sdk/agent/tools'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { test, expect } from '../fixtures'
import { TestDbLayer } from '../utils/test-db'

const slowParams = {
  description: 'slow task',
  prompt: 'slow',
  subagent_type: 'general'
}

const fastParams = {
  description: 'fast task',
  prompt: 'fast',
  subagent_type: 'general'
}

const slowCall = ToolCall.make({
  id: 'call_slow_subagent',
  name: subagentToolName,
  params: slowParams
})

const fastCall = ToolCall.make({
  id: 'call_fast_subagent',
  name: subagentToolName,
  params: fastParams
})

const result = (
  call: ToolCall,
  params: typeof slowParams,
  startedAtMs: number,
  endedAtMs: number
) =>
  makeSubagentToolResult({
    callId: call.id,
    output: `done ${call.id}`,
    subagentType: params.subagent_type,
    description: params.description,
    subagentRunId: makeSubagentRunId(call.id),
    startedAtMs,
    endedAtMs,
    model: 'e2e-model'
  })

const writeEvent = (response: ServerResponse, event: AgentEvent) => {
  response.write(`${JSON.stringify(event)}\n`)
}

const loginEmail = 'e2e-test@example.com'

const loginOtp = '123456'

const seedLoginOtp = () =>
  Effect.gen(function* () {
    const db = yield* Db
    yield* db
      .delete(schema.verification)
      .where(eq(schema.verification.identifier, `sign-in-otp-${loginEmail}`))
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

  await Promise.all([
    page.waitForURL(url => url.pathname === '/', { timeout: 15_000, waitUntil: 'commit' }),
    page.getByRole('textbox').pressSequentially(loginOtp)
  ])
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
      'x-workflow-run-id': 'e2e-subagent-parallel-run'
    })
    writeEvent(response, AgentStart.make({}))
    writeEvent(response, TurnStart.make({ turn: 1 }))
    writeEvent(response, LLMStreamStart.make({ turn: 1 }))
    writeEvent(response, ToolInputEnd.make({ call: slowCall }))
    writeEvent(response, ToolInputEnd.make({ call: fastCall }))
    writeEvent(response, LLMStreamEnd.make({ turn: 1 }))
    writeEvent(
      response,
      AssistantMessageEvent.make({
        message: AssistantAgentMessage.make({
          parts: [
            HostToolCallPart.make({ call: slowCall }),
            HostToolCallPart.make({ call: fastCall })
          ]
        })
      })
    )
    writeEvent(response, ToolExecutionStarted.make({ call: slowCall, createdAtMs: startedAtMs }))
    writeEvent(
      response,
      SubagentStarted.make({
        parentToolCallId: slowCall.id,
        subagentRunId: makeSubagentRunId(slowCall.id),
        subagentType: 'general',
        description: slowParams.description,
        model: 'e2e-model',
        createdAtMs: startedAtMs
      })
    )
    writeEvent(response, ToolExecutionStarted.make({ call: fastCall, createdAtMs: startedAtMs }))
    writeEvent(
      response,
      SubagentStarted.make({
        parentToolCallId: fastCall.id,
        subagentRunId: makeSubagentRunId(fastCall.id),
        subagentType: 'general',
        description: fastParams.description,
        model: 'e2e-model',
        createdAtMs: startedAtMs
      })
    )

    completionsReleased.then(() => {
      const endedAtMs = Date.now()
      writeEvent(
        response,
        ToolExecutionCompleted.make({
          call: slowCall,
          result: result(slowCall, slowParams, startedAtMs, endedAtMs),
          createdAtMs: endedAtMs
        })
      )
      writeEvent(
        response,
        ToolExecutionCompleted.make({
          call: fastCall,
          result: result(fastCall, fastParams, startedAtMs, endedAtMs),
          createdAtMs: endedAtMs
        })
      )
      writeEvent(response, TurnEnd.make({ turn: 1, reason: 'tool_use' }))
      writeEvent(
        response,
        AgentEnd.make({
          messages: [],
          turns: 1,
          usage: zeroAgentUsage
        })
      )
      response.end()
    })
  })

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()

  if (address === null || Predicate.isString(address)) {
    throw new Error('Expected local stream server port')
  }

  return {
    url: `http://127.0.0.1:${address.port}/workflow`,
    releaseCompletions: () => releaseCompletions?.(),
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  }
}

test('shows same-turn workflow subagents running concurrently', async ({ page }) => {
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

    await expect(
      page.getByRole('button', { name: 'tool Subagent: slow task', exact: true })
    ).toBeVisible({ timeout: 15_000 })
    await expect(
      page.getByRole('button', { name: 'tool Subagent: fast task', exact: true })
    ).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Running 2 tools')).toBeVisible()

    streamServer.releaseCompletions()

    await expect(page.getByRole('button', { name: /Subagent: slow task.*\d+ms/ })).toBeVisible({
      timeout: 15_000
    })
    await expect(page.getByRole('button', { name: /Subagent: fast task.*\d+ms/ })).toBeVisible({
      timeout: 15_000
    })
  } finally {
    await streamServer.close()
  }
})
