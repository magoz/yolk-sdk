import { Effect, Layer, Predicate, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentContentCapabilities,
  AgentModelCapabilities,
  emptyNestedToolCallRecorder,
  nestedToolCallResultFields,
  recordNestedToolCall,
  ToolCall,
  ToolDef,
  ToolResult,
  UserMessage,
  type AgentEvent
} from '@yolk-sdk/agent/protocol'
import {
  ContextTransformer,
  LoopConfig,
  run,
  runModelTurn,
  runToolBatch,
  ToolExecutor,
  type LLMRequest
} from '../../src/loop'
import { FauxProvider, Reply } from '../../src/loop/testing'

const BaseLayer = Layer.mergeAll(ContextTransformer.identity, LoopConfig.defaultLayer)

const visibleTool = ToolDef.make({
  name: 'visible',
  description: 'Model tool',
  parameters: { type: 'object' }
})

const modelOnlyTool = ToolDef.make({
  name: 'direct',
  description: 'Model-only tool',
  parameters: { type: 'object' },
  callableBy: 'model'
})

const scriptOnlyTool = ToolDef.make({
  name: 'hidden',
  description: 'Code-mode-only tool',
  parameters: { type: 'object' },
  outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
  callableBy: 'codemode',
  discovery: 'search'
})

const tools = [visibleTool, modelOnlyTool, scriptOnlyTool]

const recordingExecutor = (executed: Array<string>) =>
  Layer.succeed(
    ToolExecutor,
    ToolExecutor.of({
      execute: call => {
        executed.push(call.name)

        return Effect.succeed(
          ToolResult.make({
            toolCallId: call.id,
            content: `${call.name} done`,
            ...nestedToolCallResultFields(
              recordNestedToolCall(emptyNestedToolCallRecorder, {
                id: `${call.id}/1`,
                name: 'hidden',
                args: { secret: 'nested-args' },
                status: 'ok'
              })
            )
          })
        )
      }
    })
  )

const completedResults = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap(event =>
    Predicate.isTagged(event, 'ToolExecutionCompleted') ? [event.result] : []
  )

describe('code mode exposure in the loop', () => {
  it.effect('never sends codemode-only tools to providers across turns', () =>
    Effect.gen(function* () {
      const requests: Array<LLMRequest> = []
      const executed: Array<string> = []

      const events = yield* run({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools,
        model: 'faux'
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            FauxProvider.layerWithRequests({
              responses: [
                Reply.toolCall({ id: 'call_1', name: 'visible', params: {} }),
                Reply.text('ok')
              ],
              requests
            }),
            recordingExecutor(executed)
          ).pipe(Layer.provideMerge(BaseLayer))
        )
      )

      expect(requests).toHaveLength(2)

      for (const request of requests) {
        expect(request.tools.map(tool => tool.name)).toEqual(['visible', 'direct'])
      }

      expect(executed).toEqual(['visible'])

      // The nested-call record stays on the lifecycle event, never in the transcript.
      const [completed] = completedResults(Array.from(events))

      expect(completed?.nestedCalls?.calls[0]?.args).toBe('{"secret":"nested-args"}')
      expect(JSON.stringify(requests[1]?.messages)).not.toContain('nested-args')
    })
  )

  it.effect('omits codemode-only tools from single model turns', () =>
    Effect.gen(function* () {
      const requests: Array<LLMRequest> = []

      yield* runModelTurn({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools,
        model: 'faux',
        turn: 1
      }).pipe(
        Stream.runDrain,
        Effect.provide(
          FauxProvider.layerWithRequests({ responses: [Reply.text('ok')], requests }).pipe(
            Layer.provideMerge(BaseLayer)
          )
        )
      )

      expect(requests[0]?.tools.map(tool => tool.name)).toEqual(['visible', 'direct'])
    })
  )

  it.effect('does not reject tool-less models over codemode-only tools', () =>
    Effect.gen(function* () {
      const requests: Array<LLMRequest> = []

      yield* run({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools: [scriptOnlyTool],
        model: 'faux',
        capabilities: AgentModelCapabilities.make({
          input: AgentContentCapabilities.make({
            text: true,
            image: false,
            document: false,
            audio: false
          }),
          tools: false,
          reasoning: false
        })
      }).pipe(
        Stream.runDrain,
        Effect.provide(
          Layer.mergeAll(
            FauxProvider.layerWithRequests({ responses: [Reply.text('ok')], requests }),
            recordingExecutor([])
          ).pipe(Layer.provideMerge(BaseLayer))
        )
      )

      expect(requests[0]?.tools).toEqual([])
    })
  )

  it.effect('fails provider-issued codemode-only calls closed without dispatch', () =>
    Effect.gen(function* () {
      const executed: Array<string> = []

      const events = yield* run({
        messages: [UserMessage.make({ content: 'hello' })],
        systemPrompt: 'Be brief.',
        tools,
        model: 'faux'
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            FauxProvider.layer(
              Reply.toolCall({ id: 'call_1', name: 'hidden', params: {} }),
              Reply.text('ok')
            ),
            recordingExecutor(executed)
          ).pipe(Layer.provideMerge(BaseLayer))
        )
      )

      expect(executed).toEqual([])
      expect(completedResults(Array.from(events))).toMatchObject([
        { toolCallId: 'call_1', content: 'Tool is not configured: hidden', isError: true }
      ])
    })
  )

  it.effect('fails codemode-only calls closed in durable tool batches', () =>
    Effect.gen(function* () {
      const executed: Array<string> = []

      const events = yield* runToolBatch({
        calls: [
          ToolCall.make({ id: 'call_1', name: 'hidden', params: {} }),
          ToolCall.make({ id: 'call_2', name: 'visible', params: {} })
        ],
        tools
      }).pipe(
        Stream.runCollect,
        Effect.provide(recordingExecutor(executed).pipe(Layer.provideMerge(BaseLayer)))
      )

      expect(executed).toEqual(['visible'])
      expect(completedResults(Array.from(events))).toMatchObject([
        { toolCallId: 'call_1', content: 'Tool is not configured: hidden', isError: true },
        { toolCallId: 'call_2', content: 'visible done' }
      ])
    })
  )
})
