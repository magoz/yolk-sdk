import { Effect, Layer, Schema, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolExecutor } from '@yolk-sdk/agent/loop'
import { type AgentEvent, ToolCall, ToolResult } from '@yolk-sdk/agent/protocol'
import { LoopConfig, runToolBatch } from '../../src/loop'
import { ToolError } from '../../src/loop/error.ts'
import { propertyOptions } from './property-options'

const toolName = Schema.Literals(['alpha', 'beta', 'missing'])

const toolCallSpec = Schema.Struct({
  id: Schema.Literals(['call_1', 'call_2', 'call_3']),
  name: toolName
})

const toolBatchCase = Schema.Struct({
  calls: Schema.Array(toolCallSpec)
})

const toolBatchCaseArbitrary = Schema.toArbitrary(toolBatchCase)

const toolCallFromSpec = (spec: typeof toolCallSpec.Type) =>
  ToolCall.make({ id: spec.id, name: spec.name, params: {} })

const successNames = new Set<typeof toolName.Type>(['alpha', 'beta'])

const isSuccessToolName = (name: string): name is typeof toolName.Type =>
  name === 'alpha' || name === 'beta'

const executorLayer = Layer.succeed(
  ToolExecutor,
  ToolExecutor.of({
    execute: call => {
      if (!isSuccessToolName(call.name)) {
        return Effect.fail(
          new ToolError({
            tool: call.name,
            message: `No tool: ${call.name}`,
            cause: 'not_found'
          })
        )
      }

      return Effect.succeed(ToolResult.make({ toolCallId: call.id, content: call.name }))
    }
  })
)

describe('tool batch property tests', () => {
  it.effect.prop(
    'successful tool batches start and complete each call once',
    [toolBatchCaseArbitrary],
    ([input]) =>
      Effect.gen(function* () {
        const calls = input.calls.filter(call => successNames.has(call.name)).map(toolCallFromSpec)
        const events = yield* runToolBatch({ calls }).pipe(
          Stream.runCollect,
          Effect.provide(executorLayer),
          Effect.provide(LoopConfig.defaultLayer)
        )
        const eventArray = Array.from(events)
        const startedIds = eventArray.flatMap(event => event._tag === 'ToolExecutionStarted' ? [event.call.id] : [])
        const completed = eventArray.flatMap(event => event._tag === 'ToolExecutionCompleted' ? [event] : [])

        expect(startedIds).toEqual(calls.map(call => call.id))
        expect(completed.map(event => event.call.id)).toEqual(calls.map(call => call.id))
        expect(completed.map(event => event.result.toolCallId)).toEqual(calls.map(call => call.id))
        expect(completed.map(event => event.result.content)).toEqual(calls.map(call => call.name))
        expect(eventArray.some(event => event._tag === 'ToolExecutionError')).toBe(false)
      }),
    propertyOptions
  )

  it.effect.prop(
    'tool batch execution errors become model-visible error tool results',
    [toolBatchCaseArbitrary],
    ([input]) =>
      Effect.gen(function* () {
        const missing = input.calls.find(call => !successNames.has(call.name))

        if (missing === undefined) {
          return
        }

        const call = toolCallFromSpec(missing)
        const events: Array<AgentEvent> = []
        const result = yield* runToolBatch({ calls: [call] }).pipe(
          Stream.runForEach(event => Effect.sync(() => {
            events.push(event)
          })),
          Effect.provide(executorLayer),
          Effect.provide(LoopConfig.defaultLayer),
          Effect.result
        )

        expect(result).toMatchObject({ _tag: 'Success' })
        expect(events.map(event => event._tag)).toEqual([
          'ToolExecutionStarted',
          'ToolExecutionError',
          'ToolExecutionCompleted'
        ])
        expect(events[0]).toMatchObject({ call })
        expect(events[1]).toMatchObject({ call, code: 'tool_error' })
        expect(events[2]).toMatchObject({
          call,
          result: { toolCallId: call.id, content: `No tool: ${call.name}`, isError: true }
        })
      }),
    propertyOptions
  )
})
