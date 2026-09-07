// @vitest-environment node
import { Effect, Layer } from 'effect'
import * as Schema from 'effect/Schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentMessage,
  AgentUsage,
  AssistantAgentMessage,
  AssistantTextPart,
  ToolResult,
  ToolCall,
  ToolResultMessage,
  UserMessage
} from '@yolk-sdk/agent/protocol'
import { mergeWorkflowToolResultsStep } from './run-agent-workflow'
import { subagentUsageFromToolResult } from '@yolk-sdk/agent/tools'
import { AgentRouteRequest } from '@/lib/agents/route-handler'
import { AgentWorkflowStore } from '@/lib/services/agent-workflow/live-layer'
import {
  emptyWorkflowRegistry,
  transitionWorkflowRegistry,
  WorkflowChildRecord
} from '@/lib/services/agent-workflow/registry'
import {
  admitChildWorkflowStep,
  assertChildAdmission,
  attachChildWorkflowStep,
  childToolResultStep,
  persistChildTerminalStep,
  WorkflowAgentContext
} from './child-control'

const metadata = vi.hoisted(() => ({ workflowRunId: 'child-a' }))
vi.mock('workflow', () => ({ getWorkflowMetadata: () => metadata }))
vi.mock('@/lib/layers', async () => ({ AppLayer: (await import('effect')).Layer.empty }))
vi.mock('./text-response', () => ({
  makeAgentTextRuntime: () => {
    throw new Error('Runtime not used in control tests')
  }
}))

const originalLayer = AgentWorkflowStore.layer
let state = emptyWorkflowRegistry()
const launch = { parentRunId: 'parent', userId: 'owner', callId: 'call' }

beforeEach(async () => {
  state = emptyWorkflowRegistry()
  metadata.workflowRunId = 'child-a'
  AgentWorkflowStore.layer = Layer.succeed(AgentWorkflowStore, {
    register: () => Effect.succeed(undefined),
    read: () => Effect.succeed(state),
    change: (_runId, _userId, command) =>
      Effect.sync(() => {
        state = transitionWorkflowRegistry(state, command)
        return state
      })
  })
  const request = await Effect.runPromise(
    Schema.encodeEffect(AgentRouteRequest)(
      AgentRouteRequest.make({
        sessionId: 'session',
        messages: [UserMessage.make({ content: 'work' })],
        model: 'test-model'
      })
    )
  )
  state = transitionWorkflowRegistry(state, {
    type: 'reserve',
    child: WorkflowChildRecord.make({
      callId: 'call',
      request,
      description: 'Work',
      subagentType: 'general',
      startedAtMs: 1,
      workflowRunId: null,
      result: null
    })
  })
})
afterEach(() => {
  AgentWorkflowStore.layer = originalLayer
})

describe('Next child control steps without DB', () => {
  it('self-admits before work; duplicate physical attempts cannot execute', async () => {
    expect(await admitChildWorkflowStep(launch)).toMatchObject({
      context: { parentRunId: 'parent', callId: 'call', childType: 'general' }
    })
    metadata.workflowRunId = 'child-b'
    expect(await admitChildWorkflowStep(launch)).toBeNull()
    await attachChildWorkflowStep(launch, 'child-b')
    expect(state.children[0]?.workflowRunId).toBe('child-a')
    const check = await Effect.runPromise(
      assertChildAdmission(
        WorkflowAgentContext.make({ ...launch, childType: 'general' }),
        'child-b'
      ).pipe(Effect.provide(AgentWorkflowStore.layer), Effect.result)
    )
    expect(check._tag).toBe('Failure')
  })

  it('fences start-response attachment and the next child step after Stop', async () => {
    state = transitionWorkflowRegistry(state, { type: 'stop' })
    await attachChildWorkflowStep(launch, 'child-a')
    expect(await admitChildWorkflowStep(launch)).toBeNull()
    expect(state.children[0]?.workflowRunId).toBeNull()
  })

  it('persists typed child outcomes independently and lookup observations never charge usage twice', async () => {
    await admitChildWorkflowStep(launch)
    const message = AssistantAgentMessage.make({
      parts: [AssistantTextPart.make({ content: 'Finished work' })]
    })
    const encodedMessage = await Effect.runPromise(Schema.encodeEffect(AgentMessage)(message))
    const usage = AgentUsage.make({ input: { total: 12 }, output: { total: 4 } })
    const result = await persistChildTerminalStep(launch, {
      status: 'completed',
      state: {
        request: null,
        createdMessages: [encodedMessage],
        turn: 2,
        usage: await Effect.runPromise(Schema.encodeEffect(AgentUsage)(usage))
      }
    })
    expect(result.status).toBe('completed')
    expect(state.children[0]?.result).toEqual(result.result)
    const original = await Effect.runPromise(Schema.decodeUnknownEffect(ToolResult)(result.result))
    expect(subagentUsageFromToolResult(original)).toEqual(usage)
    for (const callId of ['status-call', 'wait-call', 'status-again']) {
      const observation = await childToolResultStep({
        callId,
        lookup: true,
        child: { done: true, workflowRunId: 'child-a', result: result.result }
      })
      const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(ToolResult)(observation))
      expect(decoded.content).toContain('Finished work')
      expect(decoded.toolCallId).toBe(callId)
      expect(subagentUsageFromToolResult(decoded)).toBeUndefined()
    }
  })

  it('background acceptance is independent of fast completion and retains the original parent handle', async () => {
    const terminal = await Effect.runPromise(
      Schema.encodeEffect(ToolResult)(ToolResult.make({ toolCallId: 'call', content: 'done' }))
    )
    for (const done of [false, true]) {
      const result = await childToolResultStep({
        callId: 'call',
        lookup: false,
        background: true,
        parentRunId: 'original-parent',
        child: { done, workflowRunId: 'child-a', result: done ? terminal : null }
      })
      const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(ToolResult)(result))
      expect(decoded.structuredContent).toMatchObject({
        type: 'subagent_accepted',
        parent_run_id: 'original-parent'
      })
      expect(decoded.content).toContain('parent_run_id=original-parent')
      expect(subagentUsageFromToolResult(decoded)).toBeUndefined()
    }
  })

  it('stores application failure instead of inferring success from a completed platform wrapper', async () => {
    await admitChildWorkflowStep(launch)
    const outcome = await persistChildTerminalStep(launch, {
      status: 'error',
      state: { request: null, createdMessages: [], turn: 1 }
    })
    const result = await Effect.runPromise(Schema.decodeUnknownEffect(ToolResult)(outcome.result))
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      status: 'error',
      subagent_run_id: 'subagent:call'
    })
  })
  it('commits exactly one result per original call in order and rejects partial/reordered batches', async () => {
    const calls = await Effect.runPromise(
      Effect.forEach(['a', 'b'], id =>
        Schema.encodeEffect(ToolCall)(ToolCall.make({ id, name: 'tool', params: {} }))
      )
    )
    const messages = await Effect.runPromise(
      Effect.forEach(['a', 'b'], toolCallId =>
        Schema.encodeEffect(ToolResultMessage)(
          ToolResultMessage.make({ toolCallId, content: toolCallId })
        )
      )
    )
    const input = { context: null, request: null, calls, createdMessages: [], eventSequence: 9 }
    const results = messages.map(message => ({ messages: [message], createdMessages: [message] }))
    const committed = await mergeWorkflowToolResultsStep(input, results)
    expect(committed.messages).toEqual(messages)
    expect(committed.eventSequence).toBe(9)
    expect(committed.failure).toBeUndefined()
    expect(
      (await mergeWorkflowToolResultsStep(input, [...results].reverse())).failure
    ).toMatchObject({ _tag: 'AgentError', code: 'tool_error' })
    expect((await mergeWorkflowToolResultsStep(input, results.slice(1))).failure).toBeDefined()
  })
})
