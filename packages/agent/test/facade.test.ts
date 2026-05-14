import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { UserMessage } from '@yolk/agent/protocol'
import { initialAgentClientState } from '@yolk/agent/client'
import { LoopConfig } from '@yolk/agent/loop'
import { makeInMemorySessionEventStoreLayer, SessionEventStore } from '@yolk/agent/runtime'

describe('@yolk/agent subpaths', () => {
  it('exports protocol and client subpaths', () => {
    const message = UserMessage.make({ content: 'hello' })

    expect(message.content).toBe('hello')
    expect(initialAgentClientState.status).toBe('idle')
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
