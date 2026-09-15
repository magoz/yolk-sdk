import { Cause, Effect, Exit, Layer, Stream } from 'effect'
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

  it.effect('treats non-string own structuredContent fields as non-accepted', () =>
    Effect.gen(function* () {
      const call = ToolCall.make({
        id: 'call_subagent_non_string',
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
                structuredContent: {
                  type: 1,
                  status: true,
                  subagent_run_id: { id: makeSubagentRunId(executed.id) }
                }
              })
            )
        })
      )

      const eventsChunk = yield* runToolBatch({ calls: [call], model: 'gpt-test' }).pipe(
        Stream.runCollect,
        Effect.provide(executor),
        Effect.provide(LoopConfig.defaultLayer)
      )

      expect(Array.from(eventsChunk).map(event => event._tag)).toEqual([
        'ToolExecutionStarted',
        'SubagentStarted',
        'ToolExecutionCompleted',
        'SubagentCompleted'
      ])
    })
  )

  it.effect('ignores inherited structuredContent fields and still emits SubagentCompleted', () =>
    Effect.gen(function* () {
      const call = ToolCall.make({
        id: 'call_subagent_inherited',
        name: 'subagent',
        params: { description: 'inspect bug', prompt: 'inspect', subagent_type: 'general' }
      })

      const executor = Layer.succeed(
        ToolExecutor,
        ToolExecutor.of({
          execute: executed => {
            const structuredContent = {}

            const result = ToolResult.make({
              toolCallId: executed.id,
              content: 'done',
              structuredContent
            })

            Object.setPrototypeOf(structuredContent, {
              type: 'subagent_accepted',
              status: 'accepted',
              subagent_run_id: makeSubagentRunId(executed.id)
            })

            return Effect.succeed(result)
          }
        })
      )

      const eventsChunk = yield* runToolBatch({ calls: [call], model: 'gpt-test' }).pipe(
        Stream.runCollect,
        Effect.provide(executor),
        Effect.provide(LoopConfig.defaultLayer)
      )

      expect(Array.from(eventsChunk).map(event => event._tag)).toEqual([
        'ToolExecutionStarted',
        'SubagentStarted',
        'ToolExecutionCompleted',
        'SubagentCompleted'
      ])
    })
  )

  it.effect('suppresses SubagentCompleted for own-data accepted strings', () =>
    Effect.gen(function* () {
      const call = ToolCall.make({
        id: 'call_subagent_accepted',
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
                structuredContent: {
                  type: 'subagent_accepted',
                  status: 'accepted',
                  subagent_run_id: makeSubagentRunId(executed.id)
                }
              })
            )
        })
      )

      const eventsChunk = yield* runToolBatch({ calls: [call], model: 'gpt-test' }).pipe(
        Stream.runCollect,
        Effect.provide(executor),
        Effect.provide(LoopConfig.defaultLayer)
      )

      expect(Array.from(eventsChunk).map(event => event._tag)).toEqual([
        'ToolExecutionStarted',
        'SubagentStarted',
        'ToolExecutionCompleted'
      ])
    })
  )

  it.effect('suppresses SubagentCompleted for own-data observation strings', () =>
    Effect.gen(function* () {
      const call = ToolCall.make({
        id: 'call_subagent_observation',
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
                structuredContent: {
                  type: 'subagent_observation',
                  subagent_run_id: makeSubagentRunId(executed.id)
                }
              })
            )
        })
      )

      const eventsChunk = yield* runToolBatch({ calls: [call], model: 'gpt-test' }).pipe(
        Stream.runCollect,
        Effect.provide(executor),
        Effect.provide(LoopConfig.defaultLayer)
      )

      expect(Array.from(eventsChunk).map(event => event._tag)).toEqual([
        'ToolExecutionStarted',
        'SubagentStarted',
        'ToolExecutionCompleted'
      ])
    })
  )

  it.effect('ignores inherited param strings, so SubagentStarted is omitted', () =>
    Effect.gen(function* () {
      const params = { prompt: 'inspect' }

      const call = ToolCall.make({
        id: 'call_subagent_inherited_params',
        name: 'subagent',
        params
      })

      Object.setPrototypeOf(params, {
        description: 'inspect bug',
        subagent_type: 'general'
      })

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

      expect(Array.from(eventsChunk).map(event => event._tag)).toEqual([
        'ToolExecutionStarted',
        'ToolExecutionCompleted'
      ])
    })
  )

  it.effect('preserves description whitespace and rejects padded subagent types', () =>
    Effect.gen(function* () {
      const call = ToolCall.make({
        id: 'call_subagent_padded_params',
        name: 'subagent',
        params: {
          description: '  inspect bug  ',
          prompt: 'inspect',
          subagent_type: 'general'
        }
      })

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

      const events = Array.from(eventsChunk)

      expect(events.map(event => event._tag)).toEqual([
        'ToolExecutionStarted',
        'SubagentStarted',
        'ToolExecutionCompleted',
        'SubagentCompleted'
      ])
      expect(events[1]).toMatchObject({
        subagentType: 'general',
        description: '  inspect bug  '
      })

      const paddedCall = ToolCall.make({
        id: 'call_subagent_padded_type',
        name: 'subagent',
        params: { description: 'inspect bug', prompt: 'inspect', subagent_type: '  general  ' }
      })

      const paddedExit = yield* runToolBatch({ calls: [paddedCall], model: 'gpt-test' }).pipe(
        Stream.runCollect,
        Effect.provide(executor),
        Effect.provide(LoopConfig.defaultLayer),
        Effect.exit
      )

      expect(Exit.isFailure(paddedExit)).toBe(true)

      if (Exit.isFailure(paddedExit)) {
        expect(Cause.hasDies(paddedExit.cause)).toBe(true)

        const failure = Cause.squash(paddedExit.cause)

        expect(failure).toBeInstanceOf(Error)

        if (failure instanceof Error) {
          expect(failure.message).toContain('subagentType')
          expect(failure.message).toContain('  general  ')
        }
      }
    })
  )

  it.effect('does not trim structuredContent strings before strict accepted equality', () =>
    Effect.gen(function* () {
      const call = ToolCall.make({
        id: 'call_subagent_padded_accepted',
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
                structuredContent: {
                  type: ' subagent_accepted',
                  status: ' accepted',
                  subagent_run_id: ` ${makeSubagentRunId(executed.id)}`
                }
              })
            )
        })
      )

      const eventsChunk = yield* runToolBatch({ calls: [call], model: 'gpt-test' }).pipe(
        Stream.runCollect,
        Effect.provide(executor),
        Effect.provide(LoopConfig.defaultLayer)
      )

      expect(Array.from(eventsChunk).map(event => event._tag)).toEqual([
        'ToolExecutionStarted',
        'SubagentStarted',
        'ToolExecutionCompleted',
        'SubagentCompleted'
      ])
    })
  )

  it.effect('admits arrays with matching own string fields through the public loop seam', () =>
    Effect.gen(function* () {
      const acceptedCall = ToolCall.make({
        id: 'call_subagent_array_accepted',
        name: 'subagent',
        params: { description: 'inspect bug', prompt: 'inspect', subagent_type: 'general' }
      })

      const acceptedExecutor = Layer.succeed(
        ToolExecutor,
        ToolExecutor.of({
          execute: executed => {
            const structuredContent = ['subagent_accepted']

            const result = ToolResult.make({
              toolCallId: executed.id,
              content: 'done',
              structuredContent
            })

            Object.defineProperty(structuredContent, 'type', {
              configurable: true,
              enumerable: true,
              value: 'subagent_accepted'
            })
            Object.defineProperty(structuredContent, 'status', {
              configurable: true,
              enumerable: true,
              value: 'accepted'
            })
            Object.defineProperty(structuredContent, 'subagent_run_id', {
              configurable: true,
              enumerable: true,
              value: makeSubagentRunId(executed.id)
            })

            return Effect.succeed(result)
          }
        })
      )

      const acceptedEvents = yield* runToolBatch({
        calls: [acceptedCall],
        model: 'gpt-test'
      }).pipe(
        Stream.runCollect,
        Effect.provide(acceptedExecutor),
        Effect.provide(LoopConfig.defaultLayer)
      )

      expect(Array.from(acceptedEvents).map(event => event._tag)).toEqual([
        'ToolExecutionStarted',
        'SubagentStarted',
        'ToolExecutionCompleted'
      ])

      const observationCall = ToolCall.make({
        id: 'call_subagent_array_observation',
        name: 'subagent',
        params: { description: 'inspect bug', prompt: 'inspect', subagent_type: 'general' }
      })

      const observationExecutor = Layer.succeed(
        ToolExecutor,
        ToolExecutor.of({
          execute: executed => {
            const structuredContent = ['subagent_observation']

            const result = ToolResult.make({
              toolCallId: executed.id,
              content: 'done',
              structuredContent
            })

            Object.defineProperty(structuredContent, 'type', {
              configurable: true,
              enumerable: true,
              value: 'subagent_observation'
            })
            Object.defineProperty(structuredContent, 'subagent_run_id', {
              configurable: true,
              enumerable: true,
              value: makeSubagentRunId(executed.id)
            })

            return Effect.succeed(result)
          }
        })
      )

      const observationEvents = yield* runToolBatch({
        calls: [observationCall],
        model: 'gpt-test'
      }).pipe(
        Stream.runCollect,
        Effect.provide(observationExecutor),
        Effect.provide(LoopConfig.defaultLayer)
      )

      expect(Array.from(observationEvents).map(event => event._tag)).toEqual([
        'ToolExecutionStarted',
        'SubagentStarted',
        'ToolExecutionCompleted'
      ])
    })
  )

  it.effect('does not invoke accessors on wrong-typed own structuredContent fields', () =>
    Effect.gen(function* () {
      const getterHits: AccessorHits = []

      const call = ToolCall.make({
        id: 'call_subagent_wrong_typed_accessors',
        name: 'subagent',
        params: { description: 'inspect bug', prompt: 'inspect', subagent_type: 'general' }
      })

      const executor = Layer.succeed(
        ToolExecutor,
        ToolExecutor.of({
          execute: executed => {
            const structuredContent = {
              type: 1,
              status: true,
              subagent_run_id: { id: makeSubagentRunId(executed.id) }
            }

            const result = ToolResult.make({
              toolCallId: executed.id,
              content: 'done',
              structuredContent
            })

            const typeValue = structuredContent.type
            const statusValue = structuredContent.status
            const runIdValue = structuredContent.subagent_run_id

            Object.defineProperty(structuredContent, 'type', {
              configurable: true,
              enumerable: true,
              get() {
                getterHits.push('type')

                return typeValue
              }
            })
            Object.defineProperty(structuredContent, 'status', {
              configurable: true,
              enumerable: true,
              get() {
                getterHits.push('status')

                return statusValue
              }
            })
            Object.defineProperty(structuredContent, 'subagent_run_id', {
              configurable: true,
              enumerable: true,
              get() {
                getterHits.push('subagent_run_id')

                return runIdValue
              }
            })

            return Effect.succeed(result)
          }
        })
      )

      const eventsChunk = yield* runToolBatch({ calls: [call], model: 'gpt-test' }).pipe(
        Stream.runCollect,
        Effect.provide(executor),
        Effect.provide(LoopConfig.defaultLayer)
      )

      expect(Array.from(eventsChunk).map(event => event._tag)).toEqual([
        'ToolExecutionStarted',
        'SubagentStarted',
        'ToolExecutionCompleted',
        'SubagentCompleted'
      ])
      expect(getterHits).toEqual([])
    })
  )
})
