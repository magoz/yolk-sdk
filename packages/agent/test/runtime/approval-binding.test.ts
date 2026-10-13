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
import {
  ContextTransformer,
  LLMDone,
  LLMToolCall,
  LoopConfig,
  type LLMEvent
} from '@yolk-sdk/agent/loop'
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

const approval = (toolCallId: string, decision: 'approved' | 'denied') =>
  ToolApprovalResponse.make({
    requestId: `approval:${toolCallId}`,
    toolCallId,
    decision,
    source: 'user'
  })

const toolCalls = (...calls: ReadonlyArray<ToolCall>) => ({
  events: [
    ...calls.map(call => LLMToolCall.make({ call })),
    LLMDone.make({ stopReason: 'tool_use' })
  ]
})

const runtimeLayer = (...replies: ReadonlyArray<{ readonly events: ReadonlyArray<LLMEvent> }>) =>
  Layer.mergeAll(
    ContextTransformer.identity,
    LoopConfig.defaultLayer,
    FauxProvider.layer(...replies),
    TestToolExecutor.layer({ delete_file: 'deleted', read_file: 'read' }),
    makeInMemorySessionEventStoreLayer()
  )

const appendResponse = (response: ToolApprovalResponse, runId: string, runtime: RuntimeConfig) =>
  Effect.gen(function* () {
    const store = yield* SessionEventStore
    const log = yield* store.load('session_1')

    return Array.from(
      yield* runRuntime(
        RuntimeRequest.AppendHitlResponse({
          sessionId: 'session_1',
          response,
          runId,
          expectedRevision: log.revision
        }),
        runtime
      ).pipe(Stream.runCollect)
    )
  })

const appendInput = (content: string, runId: string, runtime: RuntimeConfig) =>
  runRuntime(
    RuntimeRequest.AppendInput({
      sessionId: 'session_1',
      input: UserMessage.make({ content }),
      runId
    }),
    runtime
  ).pipe(
    Stream.runCollect,
    Effect.map(chunk => Array.from(chunk))
  )

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

  it.effect('the resume keeps answers to earlier siblings of the same batch', () =>
    Effect.gen(function* () {
      const first = ToolCall.make({ id: 'call_1', name: 'delete_file', params: {} })
      const second = ToolCall.make({ id: 'call_2', name: 'delete_file', params: {} })

      expect(started(yield* appendInput('delete both', 'run_1', config(true)))).toEqual([])
      expect(
        started(yield* appendResponse(approval('call_1', 'approved'), 'run_2', config(true)))
      ).toEqual([])

      // The last answer resumes with both: call_1's approval came in an earlier resume.
      const settled = yield* appendResponse(approval('call_2', 'approved'), 'run_3', config(true))

      expect(started(settled)).toEqual([first.id, second.id])
    }).pipe(
      Effect.provide(
        runtimeLayer(
          toolCalls(
            ToolCall.make({ id: 'call_1', name: 'delete_file', params: {} }),
            ToolCall.make({ id: 'call_2', name: 'delete_file', params: {} })
          ),
          Reply.text('done')
        )
      )
    )
  )

  it.effect('an old denial of a reused call id does not reach a later resume', () =>
    Effect.gen(function* () {
      const tools: RuntimeConfig = {
        systemPrompt: 'Use tools.',
        tools: [
          toolDef(true),
          ToolDef.make({ name: 'read_file', description: 'Read.', parameters: {} })
        ],
        model: 'faux'
      }

      // First batch: call_1 (gated) is denied; the run completes.
      yield* appendInput('delete a', 'run_1', tools)
      const deniedRun = yield* appendResponse(approval('call_1', 'denied'), 'run_2', tools)

      expect(started(deniedRun)).toEqual([])
      expect(deniedRun.map(event => event._tag)).toContain('AgentEnd')

      // Second batch: the provider reuses call_1 for an automatic tool, beside a gated call_2.
      expect(started(yield* appendInput('read a, delete b', 'run_3', tools))).toEqual([])

      const resumed = yield* appendResponse(approval('call_2', 'approved'), 'run_4', tools)

      expect(started(resumed)).toEqual(['call_1', 'call_2'])
      expect(resumed.map(event => event._tag)).not.toContain('ToolApprovalDenied')
    }).pipe(
      Effect.provide(
        runtimeLayer(
          toolCalls(ToolCall.make({ id: 'call_1', name: 'delete_file', params: {} })),
          Reply.text('kept'),
          toolCalls(
            ToolCall.make({ id: 'call_1', name: 'read_file', params: {} }),
            ToolCall.make({ id: 'call_2', name: 'delete_file', params: {} })
          ),
          Reply.text('done')
        )
      )
    )
  )
})
