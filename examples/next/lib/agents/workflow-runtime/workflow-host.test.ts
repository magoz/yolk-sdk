// @vitest-environment node
import { Effect, Layer, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentEvent,
  ToolCall,
  ToolResult,
  UserMessage,
  ToolApprovalPolicy
} from '@yolk-sdk/agent/protocol'
import {
  ContextTransformer,
  LLMDone,
  LLMProvider,
  LLMTextDelta,
  LLMToolCall,
  LoopConfig,
  ToolExecutor,
  type LLMRequest
} from '@yolk-sdk/agent/loop'
import { makeSubagentToolRegistration, makeTool } from '@yolk-sdk/agent/tools'
import { TestWorkflowWorld } from '@yolk-sdk/vercel-workflows/testing'
import { AgentRouteRequest } from '@/lib/agents/route-handler'
import { agentTextCapabilities } from '@/lib/agents/text-agent-config'
import { AgentWorkflowStore, WorkflowRunForbidden } from '@/lib/services/agent-workflow/live-layer'
import {
  emptyWorkflowRegistry,
  transitionWorkflowRegistry,
  type WorkflowRegistry
} from '@/lib/services/agent-workflow/registry'
import { stopAgentWorkflow } from '@/lib/services/agent-workflow/stop'
import { VercelWorkflows } from '@yolk-sdk/vercel-workflows/effect'
import type { makeAgentTextRuntime } from './text-response'
import { agentWorkflowHitlHookToken, runAgentWorkflow } from './run-agent-workflow'

// Exercise the real host entrypoints, loop, serializers, registry transitions and tool dispatch.
// Only provider/runtime construction, persistence and the platform transport are behavioral fakes.
vi.mock('@/lib/layers', async () => ({ AppLayer: (await import('effect')).Layer.empty }))
vi.mock('@/lib/services/telemetry/report-error', async () => {
  const { Effect } = await import('effect')
  return { reportError: () => Effect.void }
})
vi.mock('./text-response', () => ({
  makeAgentTextRuntime: (...args: Parameters<typeof makeAgentTextRuntime>) =>
    runtimeFactory(...args)
}))
vi.mock('workflow', async () => {
  const { testWorkflowModule } = await import('@yolk-sdk/vercel-workflows/testing')
  return {
    ...testWorkflowModule,
    createHook: <T>(input: { token: string }) => {
      const hook = testWorkflowModule.createHook<T>(input)
      hitlEntered.release()
      return hook
    },
    sleep: async () => {
      sleeping.release()
      await new Promise<void>(resolve => sleepers.push(resolve))
    }
  }
})
vi.mock('workflow/api', () => ({
  start: async <A extends unknown[], R>(fn: (...args: A) => Promise<R>, args: A) => {
    if (rejectStart) throw new Error('launch transport failed')
    return await world.sdk.start(fn, args)
  },
  getRun: <R>(runId: string) => world.sdk.getRun<R>(runId),
  resumeHook: async (token: string, payload: unknown) => await world.sdk.resumeHook(token, payload)
}))

const latch = () => {
  let release = () => {}
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, release }
}
let world: TestWorkflowWorld
let sleeping = latch()
let childEntered = latch()
let childGate = latch()
let hitlEntered = latch()
let sleepers: Array<() => void> = []
let rejectStart = false
let background = true
let childModel: string | undefined
let gated = false
let waitAfterFailure = false
let previousParent: string | undefined
let childToolCalls = 0
let requests: LLMRequest[] = []
let registries = new Map<string, { userId: string; state: WorkflowRegistry }>()
const originalStoreLayer = AgentWorkflowStore.layer

const childCall = () =>
  ToolCall.make({
    id: 'child-call',
    name: 'subagent',
    params: {
      description: 'Research',
      prompt: 'Only child context',
      subagent_type: 'general',
      ...(childModel === undefined ? {} : { model: childModel }),
      background
    }
  })
const reply = (calls: ToolCall[]) =>
  Stream.fromIterable([
    ...calls.map(call => LLMToolCall.make({ call })),
    LLMDone.make({ stopReason: 'tool_use' })
  ])
const finished = (text: string) =>
  Stream.fromIterable([LLMTextDelta.make({ text }), LLMDone.make({ stopReason: 'stop' })])

const provider = (child: boolean) =>
  Layer.succeed(LLMProvider, {
    stream: (request: LLMRequest) => {
      requests.push(request)
      const results = request.messages.filter(message => message._tag === 'ToolResult')
      if (child) {
        if (results.length > 0) return finished('Child final answer')
        childEntered.release()
        return Stream.fromEffect(Effect.promise(() => childGate.promise)).pipe(
          Stream.flatMap(() =>
            reply([ToolCall.make({ id: 'child-read', name: 'read', params: {} })])
          )
        )
      }
      if (request.model === 'follow-up') {
        return results.length === 0
          ? reply([
              ToolCall.make({
                id: 'lookup',
                name: 'subagent_status',
                params: { tool_call_id: 'child-call', parent_run_id: previousParent }
              })
            ])
          : finished('Follow-up done')
      }
      if (results.length === 0)
        return reply([
          childCall(),
          ...(gated ? [ToolCall.make({ id: 'gated', name: 'gated', params: {} })] : [])
        ])
      if (waitAfterFailure && !results.some(result => result.toolCallId === 'wait')) {
        return reply([
          ToolCall.make({
            id: 'wait',
            name: 'subagent_wait',
            params: { tool_call_id: 'child-call' }
          })
        ])
      }
      return finished('Parent done')
    }
  })

const runtimeFactory: typeof makeAgentTextRuntime = (request, userId, _route, options = {}) => {
  const child = options.childType !== undefined
  const tool = makeSubagentToolRegistration({
    subagents: [{ name: 'general', description: 'Research' }],
    models: [{ id: 'child-model', description: 'Alternate child model' }],
    background: true,
    execute:
      options.executeSubagent ??
      (() => Effect.succeed(ToolResult.make({ toolCallId: '', content: 'unavailable' })))
  })
  const read = makeTool({
    name: 'read',
    description: 'Read',
    parameters: Schema.Struct({}),
    access: 'read',
    execute: ({ call }) =>
      Effect.sync(() => {
        childToolCalls++
        return ToolResult.make({ toolCallId: call.id, content: 'read result' })
      })
  })
  const approval = makeTool({
    name: 'gated',
    description: 'Write',
    parameters: Schema.Struct({}),
    access: 'write',
    approval: ToolApprovalPolicy.make({ mode: 'manual' }),
    execute: ({ call }) =>
      Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'written' }))
  })
  const tools = child
    ? [read]
    : [tool, read, approval, ...(options.modules ?? []).flatMap(module => module.tools)]
  return Effect.succeed({
    input: request,
    config: {
      model: request.model ?? 'parent',
      reasoningEffort: 'high',
      systemPrompt: child ? 'Child' : 'Parent',
      tools: tools.map(tool => tool.def),
      capabilities: agentTextCapabilities
    },
    layer: Layer.mergeAll(
      ContextTransformer.identity,
      LoopConfig.defaultLayer,
      provider(child),
      Layer.succeed(ToolExecutor, {
        execute: call => {
          const registration = tools.find(tool => tool.def.name === call.name)
          if (registration === undefined)
            return Effect.succeed(
              ToolResult.make({ toolCallId: call.id, content: 'not found', isError: true })
            )
          return registration.execute({
            call,
            context: { userId, surface: 'text', route: '/agent/workflow', subagent: child }
          })
        }
      })
    )
  })
}

beforeEach(() => {
  world = new TestWorkflowWorld()
  registries = new Map()
  sleeping = latch()
  childEntered = latch()
  childGate = latch()
  hitlEntered = latch()
  sleepers = []
  rejectStart = false
  background = true
  childModel = undefined
  gated = false
  waitAfterFailure = false
  previousParent = undefined
  childToolCalls = 0
  requests = []
  const row = (
    runId: string,
    userId: string
  ): Effect.Effect<{ userId: string; state: WorkflowRegistry }, WorkflowRunForbidden> => {
    const value = registries.get(runId)
    return value?.userId === userId
      ? Effect.succeed(value)
      : Effect.fail(new WorkflowRunForbidden({ message: 'Not found' }))
  }
  AgentWorkflowStore.layer = Layer.succeed(AgentWorkflowStore, {
    register: (runId, userId) =>
      Effect.sync(() => {
        if (!registries.has(runId))
          registries.set(runId, { userId, state: emptyWorkflowRegistry() })
        return undefined
      }),
    read: (runId, userId) => row(runId, userId).pipe(Effect.map(row => row.state)),
    change: (runId, userId, command) =>
      row(runId, userId).pipe(
        Effect.map(row => {
          row.state = transitionWorkflowRegistry(row.state, command)
          return row.state
        })
      )
  })
})
afterEach(() => {
  AgentWorkflowStore.layer = originalStoreLayer
})

const launch = async (model: string | null = 'parent') => {
  const request = await Effect.runPromise(
    Schema.encodeEffect(AgentRouteRequest)(
      AgentRouteRequest.make({
        sessionId: 'session',
        messages: [UserMessage.make({ content: 'Parent private context' })],
        model: model ?? undefined
      })
    )
  )
  return world.start(runAgentWorkflow, [{ userId: 'owner', request }]).runId
}
const childId = (parent: string) => {
  const id = registries.get(parent)?.state.children[0]?.workflowRunId
  if (!id) throw new Error('Expected admitted child')
  return id
}
const events = (runId: string) =>
  Effect.runPromise(
    Effect.forEach(world.inspect(runId).chunks, chunk => {
      if (!(chunk instanceof Uint8Array)) throw new Error('Expected encoded chunk')
      return Schema.decodeUnknownEffect(Schema.fromJsonString(AgentEvent))(
        new TextDecoder().decode(chunk)
      )
    })
  )

describe('actual Next Workflow host with fake external boundaries', () => {
  it('continues after background acceptance and can retrieve the result in a later parent run', async () => {
    const parent = await launch()
    await childEntered.promise
    await world.settled(parent)
    expect(world.inspect(parent).status).toBe('completed')
    const id = childId(parent)
    expect(world.inspect(id).status).toBe('running')
    const parentEvents = await events(parent)
    expect(parentEvents.filter(event => event._tag === 'SubagentStarted')).toHaveLength(1)
    expect(parentEvents.some(event => event._tag === 'SubagentCompleted')).toBe(false)
    expect(requests.find(request => request.systemPrompt === 'Child')?.messages).toEqual([
      UserMessage.make({ content: 'Only child context' })
    ])
    childGate.release()
    await world.settled(id)
    expect(childToolCalls).toBe(1)
    previousParent = parent
    const followup = await launch('follow-up')
    await world.settled(followup)
    expect(
      (await events(followup)).find(event => event._tag === 'ToolExecutionCompleted')
    ).toMatchObject({ result: { content: expect.stringContaining('Child final answer') } })
  })

  it.each([
    { parentModel: null, override: undefined, expected: 'parent' },
    { parentModel: 'parent', override: 'child-model', expected: 'child-model' }
  ])(
    'starts with the resolved child model: $expected',
    async ({ parentModel, override, expected }) => {
      childModel = override
      childGate.release()
      const parent = await launch(parentModel)
      await world.settled(parent)
      await world.settled(childId(parent))
      expect((await events(parent)).find(event => event._tag === 'SubagentStarted')).toMatchObject({
        model: expected
      })
    }
  )

  it('emits exactly one foreground start before child completion and one completion afterward', async () => {
    background = false
    const parent = await launch()
    await childEntered.promise
    await sleeping.promise
    const during = await events(parent)
    expect(during.filter(event => event._tag === 'SubagentStarted')).toHaveLength(1)
    expect(during.some(event => event._tag === 'SubagentCompleted')).toBe(false)
    childGate.release()
    await world.settled(childId(parent))
    sleepers.forEach(resume => resume())
    await world.settled(parent)
    const after = await events(parent)
    expect(after.filter(event => event._tag === 'SubagentStarted')).toHaveLength(1)
    expect(after.filter(event => event._tag === 'SubagentCompleted')).toHaveLength(1)
    expect(world.inspect(parent).status).toBe('completed')
  })

  it('does not reserve or launch until every sibling approval is resolved', async () => {
    gated = true
    const parent = await launch()
    await hitlEntered.promise
    expect(registries.get(parent)?.state.children).toHaveLength(0)
    expect((await events(parent)).some(event => event._tag === 'SubagentStarted')).toBe(false)
    await world.sdk.resumeHook(agentWorkflowHitlHookToken({ runId: parent }), {
      _tag: 'ToolApprovalResponse',
      requestId: 'approval:gated',
      toolCallId: 'gated',
      decision: 'denied',
      source: 'user'
    })
    await childEntered.promise
    await world.settled(parent)
    expect(
      (await events(parent))
        .filter(event => event._tag === 'ToolExecutionCompleted')
        .map(event => event.result.toolCallId)
    ).toHaveLength(2)
    childGate.release()
    await world.settled(childId(parent))
  })

  it('failed start leaves an actionable uncertainty result instead of hanging a subsequent wait', async () => {
    rejectStart = true
    waitAfterFailure = true
    const parent = await launch()
    await world.settled(parent)
    expect(world.inspect(parent).status).toBe('completed')
    expect(registries.get(parent)?.state.children[0]).toMatchObject({
      launchUncertain: true,
      workflowRunId: null
    })
    expect(
      (await events(parent)).find(
        event => event._tag === 'ToolExecutionCompleted' && event.result.toolCallId === 'wait'
      )
    ).toMatchObject({ result: { isError: true, content: expect.stringContaining('unconfirmed') } })
  })

  it('Stop after parent completion cancels and fences the live child before further tools', async () => {
    const parent = await launch()
    await childEntered.promise
    await world.settled(parent)
    await Effect.runPromise(
      stopAgentWorkflow(parent, 'owner').pipe(
        Effect.provide(Layer.merge(AgentWorkflowStore.layer, VercelWorkflows.layer))
      )
    )
    expect(world.inspect(childId(parent)).status).toBe('cancelled')
    childGate.release()
    await world.settled(childId(parent))
    expect(childToolCalls).toBe(0)
  })
})
