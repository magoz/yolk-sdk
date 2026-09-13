import { Effect, Layer, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { makeSubagentRunId, ToolCall, ToolResult } from '@yolk-sdk/agent/protocol'
import { LoopConfig, runToolBatch, ToolExecutor } from '@yolk-sdk/agent/loop'

type AccessorHits = Array<string>

type SubagentParams = {
  description: string
  prompt: string
  subagent_type: string
}

type SubagentAcceptedContent = {
  type: string
  status: string
  subagent_run_id: string
}

const installParamAccessor = (
  target: SubagentParams,
  key: keyof SubagentParams,
  hits: AccessorHits
) => {
  const current = Object.getOwnPropertyDescriptor(target, key)?.value

  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get() {
      hits.push(key)

      return current
    }
  })
}

const installAcceptedAccessor = (
  target: SubagentAcceptedContent,
  key: keyof SubagentAcceptedContent,
  hits: AccessorHits
) => {
  const current = Object.getOwnPropertyDescriptor(target, key)?.value

  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get() {
      hits.push(key)

      return current
    }
  })
}

describe('run objectField getOwnPropertyDescriptor path', () => {
  it.effect('does not invoke structuredContent getters and still emits SubagentCompleted', () =>
    Effect.gen(function* () {
      const getterHits: AccessorHits = []

      const call = ToolCall.make({
        id: 'call_subagent',
        name: 'subagent',
        params: { description: 'inspect bug', prompt: 'inspect', subagent_type: 'general' }
      })

      const executor = Layer.succeed(
        ToolExecutor,
        ToolExecutor.of({
          execute: executed => {
            const structuredContent: SubagentAcceptedContent = {
              type: 'subagent_accepted',
              status: 'accepted',
              subagent_run_id: makeSubagentRunId(executed.id)
            }

            const result = ToolResult.make({
              toolCallId: executed.id,
              content: 'done',
              structuredContent
            })

            installAcceptedAccessor(structuredContent, 'type', getterHits)
            installAcceptedAccessor(structuredContent, 'status', getterHits)
            installAcceptedAccessor(structuredContent, 'subagent_run_id', getterHits)

            return Effect.succeed(result)
          }
        })
      )

      const eventsChunk = yield* runToolBatch({ calls: [call], model: 'gpt-test' }).pipe(
        Stream.runCollect,
        Effect.provide(executor),
        Effect.provide(LoopConfig.defaultLayer)
      )

      const tags = Array.from(eventsChunk).map(event => event._tag)

      expect(tags).toEqual([
        'ToolExecutionStarted',
        'SubagentStarted',
        'ToolExecutionCompleted',
        'SubagentCompleted'
      ])
      expect(getterHits).toEqual([])
    })
  )

  it.effect('does not invoke param getters, so SubagentStarted is omitted', () =>
    Effect.gen(function* () {
      const getterHits: AccessorHits = []

      const params: SubagentParams = {
        description: 'inspect bug',
        prompt: 'inspect',
        subagent_type: 'general'
      }

      const call = ToolCall.make({
        id: 'call_subagent_getters',
        name: 'subagent',
        params
      })

      installParamAccessor(params, 'subagent_type', getterHits)
      installParamAccessor(params, 'description', getterHits)

      const executor = Layer.succeed(
        ToolExecutor,
        ToolExecutor.of({
          execute: executed =>
            Effect.succeed(ToolResult.make({ toolCallId: executed.id, content: 'done' }))
        })
      )

      const eventsChunk = yield* runToolBatch({ calls: [call], model: 'gpt-test' }).pipe(
        Stream.runCollect,
        Effect.provide(executor),
        Effect.provide(LoopConfig.defaultLayer)
      )

      const tags = Array.from(eventsChunk).map(event => event._tag)

      expect(tags).toEqual(['ToolExecutionStarted', 'ToolExecutionCompleted'])
      expect(getterHits).toEqual([])
    })
  )

  it.effect('treats array structuredContent as non-accepted', () =>
    Effect.gen(function* () {
      const call = ToolCall.make({
        id: 'call_subagent_array',
        name: 'subagent',
        params: { description: 'inspect bug', prompt: 'inspect', subagent_type: 'general' }
      })

      const executor = Layer.succeed(
        ToolExecutor,
        ToolExecutor.of({
          execute: executed =>
            Effect.succeed(
              ToolResult.make({
                toolCallId: executed.id,
                content: 'done',
                structuredContent: ['subagent_accepted']
              })
            )
        })
      )

      const eventsChunk = yield* runToolBatch({ calls: [call], model: 'gpt-test' }).pipe(
        Stream.runCollect,
        Effect.provide(executor),
        Effect.provide(LoopConfig.defaultLayer)
      )

      expect(Array.from(eventsChunk).map(event => event._tag)).toContain('SubagentCompleted')
    })
  )
})
