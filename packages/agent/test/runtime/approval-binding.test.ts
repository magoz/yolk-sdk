import { Effect, Layer, Predicate, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  ToolApprovalPolicy,
  ToolApprovalResponse,
  ToolCall,
  ToolDef,
  UserMessage,
  type AgentEvent
} from '@yolk-sdk/agent/protocol'
import { ContextTransformer, LLMDone, LLMToolCall, LoopConfig } from '@yolk-sdk/agent/loop'
import { FauxProvider, Reply, TestToolExecutor } from '@yolk-sdk/agent/loop/testing'
import {
  makeInMemorySessionEventStoreLayer,
  runRuntime,
  SessionEventStore,
  type RuntimeConfig
} from '../../src/runtime/index.ts'
import { RuntimeRequest } from '../../src/runtime/run-runtime.ts'

const gatedTool = ToolDef.make({
  name: 'delete_file',
  description: 'Delete a file.',
  parameters: {},
  approval: ToolApprovalPolicy.make({ mode: 'manual' })
})

/** The same tool after the host flipped its policy to automatic. */
const autoTool = ToolDef.make({
  name: 'delete_file',
  description: 'Delete a file.',
  parameters: {}
})

const toolDef = (gated: boolean) => (gated ? gatedTool : autoTool)

const config = (gated: boolean): RuntimeConfig => ({
  systemPrompt: 'Use tools.',
  tools: [toolDef(gated)],
  model: 'faux'
})

const twoCalls = {
  events: [
    LLMToolCall.make({ call: ToolCall.make({ id: 'call_1', name: 'delete_file', params: {} }) }),
    LLMToolCall.make({ call: ToolCall.make({ id: 'call_2', name: 'delete_file', params: {} }) }),
    LLMDone.make({ stopReason: 'tool_use' })
  ]
}

const started = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap(event =>
    Predicate.isTagged(event, 'ToolExecutionStarted') ? [event.call.id] : []
  )

describe('runtime approval binding', () => {
  it.effect('a resumed pause keeps its unanswered approval pending after a policy flip', () =>
    Effect.gen(function* () {
      const paused = Array.from(
        yield* runRuntime(
          RuntimeRequest.AppendInput({
            sessionId: 'session_1',
            input: UserMessage.make({ content: 'delete both' }),
            runId: 'run_1'
          }),
          config(true)
        ).pipe(Stream.runCollect)
      )

      expect(started(paused)).toEqual([])

      const store = yield* SessionEventStore
      const pausedLog = yield* store.load('session_1')

      const resumed = Array.from(
        yield* runRuntime(
          RuntimeRequest.AppendHitlResponse({
            sessionId: 'session_1',
            response: ToolApprovalResponse.make({
              requestId: 'approval:call_1',
              toolCallId: 'call_1',
              decision: 'approved',
              source: 'user'
            }),
            runId: 'run_2',
            expectedRevision: pausedLog.revision
          }),
          // The host re-read policy: the tool no longer requires approval.
          config(false)
        ).pipe(Stream.runCollect)
      )

      expect(started(resumed)).toEqual([])
      expect(resumed.find(event => Predicate.isTagged(event, 'AgentAwaitingInput'))).toMatchObject({
        requests: [{ requestId: 'approval:call_2' }]
      })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ContextTransformer.identity,
          LoopConfig.defaultLayer,
          FauxProvider.layer(twoCalls, Reply.text('done')),
          TestToolExecutor.layer({ delete_file: 'deleted' }),
          makeInMemorySessionEventStoreLayer()
        )
      )
    )
  )
})
