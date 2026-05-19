import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { UserMessage } from '@yolk-sdk/agent/protocol'
import { initialAgentClientState } from '@yolk-sdk/agent/client'
import { LoopConfig } from '@yolk-sdk/agent/loop'
import { Reply } from '@yolk-sdk/agent/loop/testing'
import { makeInMemorySessionEventStoreLayer, SessionEventStore } from '@yolk-sdk/agent/runtime'
import { ToolAccess } from '@yolk-sdk/agent/tools'

describe('@yolk-sdk/agent subpaths', () => {
  it('imports every public subpath', async () => {
    const [root, protocol, client, loop, testing, runtime, tools] = await Promise.all([
      import('@yolk-sdk/agent'),
      import('@yolk-sdk/agent/protocol'),
      import('@yolk-sdk/agent/client'),
      import('@yolk-sdk/agent/loop'),
      import('@yolk-sdk/agent/loop/testing'),
      import('@yolk-sdk/agent/runtime'),
      import('@yolk-sdk/agent/tools')
    ])

    expect(root).toBeDefined()
    expect(protocol.UserMessage).toBeDefined()
    expect(client.initialAgentClientState.status).toBe('idle')
    expect(loop.LoopConfig).toBeDefined()
    expect(testing.Reply).toBeDefined()
    expect(runtime.SessionEventStore).toBeDefined()
    expect(tools.ToolAccess).toBeDefined()
  })

  it('exports protocol and client subpaths', () => {
    const message = UserMessage.make({ content: 'hello' })

    expect(message.content).toBe('hello')
    expect(initialAgentClientState.status).toBe('idle')
    expect(Reply.text('ok').events.length).toBeGreaterThan(0)
    expect(ToolAccess).toBeDefined()
  })

  it.effect('exports loop and runtime subpaths', () =>
    Effect.gen(function* () {
      const config = yield* LoopConfig
      const store = yield* SessionEventStore

      expect(config.maxTurns).toBeGreaterThan(0)
      expect(store).toBeDefined()
    }).pipe(
      Effect.provide(
        LoopConfig.layer({
          maxTurns: 10,
          maxRetries: 1,
          retryBaseDelayMs: 10,
          toolConcurrency: 2
        })
      ),
      Effect.provide(makeInMemorySessionEventStoreLayer())
    )
  )
})
