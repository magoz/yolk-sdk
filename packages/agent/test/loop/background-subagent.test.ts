import { Effect, Layer, Predicate, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolApprovalPolicy, ToolCall, ToolDef, ToolResult } from '@yolk-sdk/agent/protocol'
import { LoopConfig, prepareToolBatch, runToolBatch, ToolExecutor } from '../../src/loop/index.ts'
import {
  makeSubagentAcceptedToolResult,
  makeSubagentToolDef,
  makeSubagentToolRegistration,
  subagentUsageFromToolResult
} from '../../src/tools/index.ts'

const child = ToolCall.make({
  id: 'child-call',
  name: 'subagent',
  params: { description: 'Do work', prompt: 'Work', subagent_type: 'general', background: true }
})

describe('background subagent contract', () => {
  it.effect('completes the launch tool without completing the accepted child', () =>
    Effect.gen(function* () {
      const result = makeSubagentAcceptedToolResult({
        callId: child.id,
        workflowRunId: 'physical-child'
      })

      const events = yield* runToolBatch({ calls: [child] }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.merge(
            LoopConfig.defaultLayer,
            Layer.succeed(ToolExecutor, { execute: () => Effect.succeed(result) })
          )
        )
      )

      expect(events.map(event => event._tag)).toEqual([
        'ToolExecutionStarted',
        'SubagentStarted',
        'ToolExecutionCompleted'
      ])
      expect(result.structuredContent).toMatchObject({
        subagent_run_id: 'subagent:child-call',
        workflow_run_id: 'physical-child'
      })
      expect(subagentUsageFromToolResult(result)).toBeUndefined()
    })
  )

  it.effect(
    'treats matching child observations as nonterminal and never charges nested usage',
    () =>
      Effect.gen(function* () {
        for (const runId of ['subagent:child-call', 'subagent:unrelated']) {
          const result = ToolResult.make({
            toolCallId: child.id,
            content: 'Execution outcome is not known',
            isError: true,
            structuredContent: {
              type: 'subagent_observation',
              subagent_run_id: runId,
              done: false,
              result: { usage: { input: { total: 12 }, output: { total: 4 } } }
            }
          })

          const events = yield* runToolBatch({ calls: [child] }).pipe(
            Stream.runCollect,
            Effect.provide(
              Layer.merge(
                LoopConfig.defaultLayer,
                Layer.succeed(ToolExecutor, { execute: () => Effect.succeed(result) })
              )
            )
          )

          expect(
            events.filter(event => Predicate.isTagged(event, 'SubagentCompleted'))
          ).toHaveLength(runId === 'subagent:child-call' ? 0 : 1)
          expect(
            events.filter(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))
          ).toHaveLength(1)
          expect(events.filter(event => Predicate.isTagged(event, 'UsageUpdate'))).toHaveLength(0)
          expect(subagentUsageFromToolResult(result)).toBeUndefined()
        }
      })
  )

  it.effect('advertises background only for opted-in hosts and preserves normalized params', () =>
    Effect.gen(function* () {
      const subagents = [{ name: 'general', description: 'Work' }]
      expect(makeSubagentToolDef(subagents).parameters).not.toHaveProperty('properties.background')
      expect(makeSubagentToolDef(subagents, { background: true }).parameters).toHaveProperty(
        'properties.background'
      )
      let background: boolean | undefined

      const tool = makeSubagentToolRegistration({
        subagents,
        background: true,
        execute: input => {
          background = input.params.background

          return Effect.succeed(ToolResult.make({ toolCallId: input.call.id, content: '' }))
        }
      })

      yield* tool.execute({ call: child, context: {} })
      expect(background).toBe(true)
    })
  )

  it.effect('exports preflight that fences every launch behind a sibling approval', () =>
    Effect.gen(function* () {
      const gated = ToolCall.make({ id: 'gated', name: 'write', params: {} })

      const tools = [
        ToolDef.make({
          name: 'write',
          description: 'Write',
          parameters: {},
          approval: ToolApprovalPolicy.make({ mode: 'manual' })
        })
      ]

      const prepared = yield* prepareToolBatch({ calls: [child, gated], tools, responses: [] })
      expect(prepared.pendingRequests).toHaveLength(1)
      let executed = 0

      const events = yield* runToolBatch({ calls: [child, gated], tools }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.merge(
            LoopConfig.defaultLayer,
            Layer.succeed(ToolExecutor, {
              execute: call => {
                executed++

                return Effect.succeed(ToolResult.make({ toolCallId: call.id, content: '' }))
              }
            })
          )
        )
      )

      expect(executed).toBe(0)
      expect(events.some(event => Predicate.isTagged(event, 'AgentAwaitingInput'))).toBe(true)
      expect(events.some(event => Predicate.isTagged(event, 'SubagentStarted'))).toBe(false)
    })
  )
})
