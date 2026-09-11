// @vitest-environment node
import { Effect, Layer, Stream } from 'effect'
import { EffectDrizzleQueryError } from 'drizzle-orm/effect-core/errors'
import { getWorkflowMetadata } from 'workflow'
import { WorkflowRunNotFoundError } from 'workflow/errors'
import * as Schema from 'effect/Schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentEvent,
  AgentUsage,
  ToolCall,
  ToolResult,
  UserMessage,
  ToolApprovalPolicy
} from '@yolk-sdk/agent/protocol'
import {
  ContextTransformer,
  LLMDone,
  LLMError,
  LLMUsage,
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
  WorkflowRegistryError,
  type WorkflowRegistry
} from '@/lib/services/agent-workflow/registry'
import { stopAgentWorkflow } from '@/lib/services/agent-workflow/stop'
import { VercelWorkflows } from '@yolk-sdk/vercel-workflows/effect'
import type { makeAgentTextRuntime } from './text-response'
import { agentWorkflowHitlHookToken, runAgentWorkflow } from './run-agent-workflow'
import { readChildWorkflowStep } from './workflow-child-steps'

const reports = vi.hoisted(() => vi.fn())

// Exercise the real host entrypoints, loop, serializers, registry transitions and tool dispatch.
// Only provider/runtime construction, persistence and the platform transport are behavioral fakes.
vi.mock('@/lib/layers', async () => ({ AppLayer: (await import('effect')).Layer.empty }))
vi.mock('@/lib/services/telemetry/report-error', async () => {
  const { Effect } = await import('effect')
  return {
    reportError: (error: unknown, context?: Record<string, unknown>) =>
      Effect.sync(() => {
        reports(error, context)
      })
  }
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
    sleep: async (duration: unknown) => {
      sleepDurations.push(duration)
      // Test-harness runaway guard, not a claim about platform quotas.
      if (autoSleep) {
        if (advanceSleepClock && typeof duration === 'number')
          vi.setSystemTime(Date.now() + duration)
        if (sleepDurations.length > 40) throw new Error('Unbounded observation')
        return
      }
      sleeping.release()
      await new Promise<void>(resolve => sleepers.push(resolve))
    }
  }
})
vi.mock('workflow/api', () => ({
  start: async <A extends unknown[], R>(fn: (...args: A) => Promise<R>, args: A) => {
    if (rejectStart) throw new Error('launch transport failed')
    const run = await world.sdk.start(fn, args)
    if (loseStartResponse) throw new Error('start response lost')
    return run
  },
  getRun: <R>(runId: string) => {
    const run = world.sdk.getRun<R>(runId)
    return {
      runId,
      getReadable: run.getReadable,
      cancel: run.cancel,
      get returnValue() {
        return run.returnValue
      },
      get status() {
        statusReads++
        return missingStatus
          ? Promise.reject(new WorkflowRunNotFoundError(runId))
          : failStatus
            ? Promise.reject(new Error('platform unavailable'))
            : run.status
      }
    }
  },
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
let sleepDurations: unknown[] = []
let autoSleep = false
let advanceSleepClock = false
let missingStatus = false
let rejectStart = false
let loseStartResponse = false
let retryChild = false
let childQuestion = false
let failStatus = false
let failAttachment = false
let loseReservationResponse = false
let failRead = false
let failReadArmed = false
let failChild = false
let statusReads = 0
let preparationFailure: WorkflowRegistryError | WorkflowRunForbidden | undefined
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
const childUsage = AgentUsage.make({ input: { total: 12 }, output: { total: 4 } })
const finished = (text: string) =>
  Stream.fromIterable([
    LLMTextDelta.make({ text }),
    ...(text === 'Child final answer' ? [LLMUsage.make({ usage: childUsage })] : []),
    LLMDone.make({ stopReason: 'stop' })
  ])

const provider = (child: boolean) =>
  Layer.succeed(LLMProvider, {
    stream: (request: LLMRequest) => {
      requests.push(request)
      const results = request.messages.filter(message => message._tag === 'ToolResult')
      if (child) {
        if (results.length > 0) return finished('Child final answer')
        childEntered.release()
        if (retryChild || failChild)
          return Stream.fail(
            new LLMError({ cause: 'rate_limit', message: 'Retry later', retryable: retryChild })
          )
        return Stream.fromEffect(Effect.promise(() => childGate.promise)).pipe(
          Stream.flatMap(() =>
            reply([
              childQuestion
                ? ToolCall.make({
                    id: 'child-question',
                    name: 'question',
                    params: {
                      questions: [
                        {
                          id: 'choice',
                          prompt: 'Pick one',
                          options: [{ id: 'a', label: 'A' }],
                          allowCustom: true
                        }
                      ]
                    }
                  })
                : ToolCall.make({ id: 'child-read', name: 'read', params: {} })
            ])
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
  sleepDurations = []
  autoSleep = false
  advanceSleepClock = false
  missingStatus = false
  rejectStart = false
  loseStartResponse = false
  retryChild = false
  childQuestion = false
  failStatus = false
  failAttachment = false
  loseReservationResponse = false
  failRead = false
  failReadArmed = false
  failChild = false
  statusReads = 0
  preparationFailure = undefined
  reports.mockClear()
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
    read: (runId, userId) =>
      row(runId, userId).pipe(
        Effect.flatMap(row => {
          if (failReadArmed && getWorkflowMetadata().workflowRunId === runId) {
            failReadArmed = false
            return Effect.fail(
              new EffectDrizzleQueryError({
                query: 'read owned registry',
                params: [],
                cause: 'Storage unavailable'
              })
            )
          }
          return Effect.succeed(row.state)
        })
      ),
    change: (runId, userId, command) =>
      Effect.gen(function* () {
        const value = yield* row(runId, userId)
        if (
          command.type === 'admit' &&
          failAttachment &&
          getWorkflowMetadata().workflowRunId === runId
        )
          return yield* Effect.fail(
            new WorkflowRegistryError({ message: 'Attachment response unavailable' })
          )
        if (command.type === 'reserve' && preparationFailure !== undefined) {
          return yield* Effect.fail(preparationFailure)
        }
        value.state = transitionWorkflowRegistry(value.state, command)
        if (command.type === 'reserve' && loseReservationResponse)
          return yield* Effect.fail(new WorkflowRegistryError({ message: 'Commit response lost' }))
        if (command.type === 'admit' && failRead && getWorkflowMetadata().workflowRunId === runId)
          failReadArmed = true
        return value.state
      })
  })
})
afterEach(() => {
  vi.useRealTimers()
  AgentWorkflowStore.layer = originalStoreLayer
})

const launch = async (model: string | null = 'parent', userId = 'owner') => {
  const request = await Effect.runPromise(
    Schema.encodeEffect(AgentRouteRequest)(
      AgentRouteRequest.make({
        sessionId: 'session',
        messages: [UserMessage.make({ content: 'Parent private context' })],
        model: model ?? undefined
      })
    )
  )
  return world.start(runAgentWorkflow, [{ userId, request }]).runId
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
    expect(parentEvents.find(event => event._tag === 'AgentEnd')).toMatchObject({
      usage: { input: { total: 0 }, output: { total: 0 } }
    })
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
    expect(after.find(event => event._tag === 'AgentEnd')).toMatchObject({ usage: childUsage })
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

  it('keeps a lost reservation response recoverably uncertain without releasing the logical slot', async () => {
    loseReservationResponse = true
    waitAfterFailure = true
    autoSleep = true
    const parent = await launch()
    await world.settled(parent)
    const output = await events(parent)
    expect(registries.get(parent)?.state.children).toHaveLength(1)
    expect(registries.get(parent)?.state.children[0]).toMatchObject({
      launchUncertain: true,
      workflowRunId: null,
      result: null
    })
    expect(output.some(event => event._tag === 'SubagentCompleted')).toBe(false)
    expect(
      output.find(
        event => event._tag === 'ToolExecutionCompleted' && event.result.toolCallId === 'wait'
      )
    ).toMatchObject({
      result: {
        content: expect.stringContaining('unconfirmed'),
        structuredContent: { done: false }
      }
    })
    expect(sleepDurations).toHaveLength(0)
    expect(requests.some(request => request.systemPrompt === 'Child')).toBe(false)
  })

  it('rejects invalid child preparation before committing any reservation', async () => {
    childModel = 'not-enabled'
    const parent = await launch()
    await world.settled(parent)
    expect(registries.get(parent)?.state.children).toHaveLength(0)
    expect(requests.some(request => request.systemPrompt === 'Child')).toBe(false)
    expect(
      (await events(parent)).find(event => event._tag === 'ToolExecutionCompleted')
    ).toMatchObject({ result: { isError: true } })
  })

  it('reports recovered preparation failure once without leaking error messages or request data', async () => {
    preparationFailure = new WorkflowRegistryError({
      message: 'Sensitive SQL parameters and credentials'
    })
    const parent = await launch()
    await world.settled(parent)
    expect(world.inspect(parent).status).toBe('completed')
    expect(reports).toHaveBeenCalledExactlyOnceWith(
      { _tag: 'WorkflowChildPreparationError', message: 'Child launch preparation failed' },
      {
        operation: 'agent.workflow.child.prepare',
        runId: parent,
        toolCallId: 'child-call',
        cause_type: 'WorkflowRegistryError'
      }
    )
    expect(
      (await events(parent)).find(event => event._tag === 'ToolExecutionCompleted')
    ).toMatchObject({
      result: {
        isError: true,
        content: expect.stringContaining('Child launch preparation failed'),
        structuredContent: { type: 'subagent_observation', done: false }
      }
    })
    expect(registries.get(parent)?.state.children).toHaveLength(0)
  })

  it('keeps expected preparation authorization failures quiet and model-visible', async () => {
    preparationFailure = new WorkflowRunForbidden({ message: 'Not found' })
    const parent = await launch()
    await world.settled(parent)
    expect(world.inspect(parent).status).toBe('completed')
    expect(reports).not.toHaveBeenCalled()
    expect(
      (await events(parent)).find(event => event._tag === 'ToolExecutionCompleted')
    ).toMatchObject({ result: { isError: true, content: 'Child launch preparation failed' } })
    expect(registries.get(parent)?.state.children).toHaveLength(0)
  })

  it("makes another owner's handle unavailable without leaking the child identity", async () => {
    const parent = await launch()
    await childEntered.promise
    await world.settled(parent)
    previousParent = parent
    const other = await launch('follow-up', 'intruder')
    await world.settled(other)
    const output = await events(other)
    expect(output.find(event => event._tag === 'ToolExecutionCompleted')).toMatchObject({
      result: {
        isError: true,
        content: 'Child handle not found',
        structuredContent: { workflow_run_id: null }
      }
    })
    expect(JSON.stringify(output)).not.toContain(childId(parent))
    expect(reports).not.toHaveBeenCalled()
    const probe = world.start(
      async () =>
        world.runStep(readChildWorkflowStep, [
          { parentRunId: parent, userId: 'intruder', callId: 'child-call' }
        ]),
      []
    )
    await world.settled(probe.runId)
    expect(world.inspect(probe.runId).status).toBe('completed')
    expect(world.inspect(probe.runId).stepAttempts.get('readChildWorkflowStep')).toBe(1)
    expect(await world.sdk.getRun(probe.runId).returnValue).toMatchObject({
      done: true,
      workflowRunId: null,
      result: { content: 'Child handle not found' }
    })
    childGate.release()
    await world.settled(childId(parent))
  })

  it('acknowledges confirmed background attachment without a platform status read', async () => {
    failStatus = true
    const parent = await launch()
    await childEntered.promise
    await world.settled(parent)
    const output = await events(parent)
    expect(output.find(event => event._tag === 'ToolExecutionCompleted')).toMatchObject({
      result: { structuredContent: { type: 'subagent_accepted', workflow_run_id: childId(parent) } }
    })
    expect(statusReads).toBe(0)
    expect(output.some(event => event._tag === 'SubagentCompleted')).toBe(false)
    childGate.release()
    await world.settled(childId(parent))
  })

  it.each(['lost-start', 'attachment', 'status', 'read'])(
    'does not declare a child terminal after %s uncertainty and recovers its result',
    async failure => {
      loseStartResponse = failure === 'lost-start'
      failAttachment = failure === 'attachment'
      failStatus = failure === 'status'
      failRead = failure === 'read'
      background = failure === 'lost-start' || failure === 'attachment'
      const parent = await launch()
      await childEntered.promise
      await world.settled(parent)
      const output = await events(parent)
      expect(output.filter(event => event._tag === 'SubagentCompleted')).toHaveLength(0)
      expect(output.find(event => event._tag === 'AgentEnd')).toMatchObject({
        usage: { input: { total: 0 }, output: { total: 0 } }
      })
      expect(output.find(event => event._tag === 'ToolExecutionCompleted')).toMatchObject({
        result: {
          structuredContent: { type: 'subagent_observation', done: false, parent_run_id: parent }
        }
      })
      childGate.release()
      await world.settled(childId(parent))
      failStatus = false
      failRead = false
      previousParent = parent
      const followup = await launch('follow-up')
      await world.settled(followup)
      expect(
        (await events(followup)).find(event => event._tag === 'ToolExecutionCompleted')
      ).toMatchObject({
        result: { content: expect.stringContaining('Child final answer') }
      })
    }
  )

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

  it('ends a resilient-start grace as nonterminal uncertainty and still recovers the child outcome', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(10_000)
    background = false
    autoSleep = true
    advanceSleepClock = true
    missingStatus = true
    const parent = await launch()
    await childEntered.promise
    await world.settled(parent)
    const output = await events(parent)
    expect(output.find(event => event._tag === 'ToolExecutionCompleted')).toMatchObject({
      result: {
        content: expect.stringContaining('unconfirmed'),
        structuredContent: { done: false, workflow_run_id: childId(parent) }
      }
    })
    expect(output.some(event => event._tag === 'SubagentCompleted')).toBe(false)
    expect(sleepDurations).toEqual([1000, 5000, 15000, 30000, 30000])
    expect(registries.get(parent)?.state.children[0]?.result).toBeNull()
    missingStatus = false
    childGate.release()
    await world.settled(childId(parent))
    previousParent = parent
    const followup = await launch('follow-up')
    await world.settled(followup)
    expect(
      (await events(followup)).find(event => event._tag === 'ToolExecutionCompleted')
    ).toMatchObject({ result: { content: expect.stringContaining('Child final answer') } })
  })

  it.each([false, true])(
    'bounds %s background/foreground waiting and preserves later retrieval',
    async backgroundMode => {
      background = backgroundMode
      waitAfterFailure = backgroundMode
      autoSleep = true
      const parent = await launch()
      await childEntered.promise
      await world.settled(parent)
      const output = await events(parent)
      const callId = backgroundMode ? 'wait' : 'child-call'
      expect(
        output.find(
          event => event._tag === 'ToolExecutionCompleted' && event.result.toolCallId === callId
        )
      ).toMatchObject({
        result: {
          content: expect.stringContaining(`tool_call_id=child-call parent_run_id=${parent}`),
          structuredContent: {
            type: 'subagent_observation',
            done: false,
            workflow_run_id: childId(parent),
            parent_run_id: parent,
            tool_call_id: 'child-call'
          }
        }
      })
      expect(output.find(event => event._tag === 'AgentEnd')).toMatchObject({
        usage: { input: { total: 0 }, output: { total: 0 } }
      })
      expect(
        requests.filter(request => request.systemPrompt === 'Parent').at(-1)?.messages
      ).toContainEqual(
        expect.objectContaining({
          _tag: 'ToolResult',
          toolCallId: callId,
          content: expect.stringContaining(`tool_call_id=child-call parent_run_id=${parent}`)
        })
      )
      expect(sleepDurations).toHaveLength(31)
      expect(sleepDurations.slice(0, 5)).toEqual([1000, 5000, 15000, 30000, 30000])
      expect(output.some(event => event._tag === 'SubagentCompleted')).toBe(false)
      childGate.release()
      await world.settled(childId(parent))
      previousParent = parent
      waitAfterFailure = false
      const followup = await launch('follow-up')
      await world.settled(followup)
      const followupEvents = await events(followup)
      expect(followupEvents.find(event => event._tag === 'ToolExecutionCompleted')).toMatchObject({
        result: { content: expect.stringContaining('Child final answer') }
      })
      expect(followupEvents.find(event => event._tag === 'AgentEnd')).toMatchObject({
        usage: { input: { total: 0 }, output: { total: 0 } }
      })
    }
  )

  it('rejects an unadvertised child question without HITL and continues the model', async () => {
    childQuestion = true
    childGate.release()
    const parent = await launch()
    await world.settled(parent)
    const id = childId(parent)
    await world.settled(id)
    const output = await events(id)
    expect(
      output.some(
        event => event._tag === 'QuestionRequested' || event._tag === 'AgentAwaitingInput'
      )
    ).toBe(false)
    expect(world.inspect(id).status).toBe('completed')
    expect(
      requests.filter(request => request.systemPrompt === 'Child').at(-1)?.messages
    ).toContainEqual(
      expect.objectContaining({
        _tag: 'ToolResult',
        toolCallId: 'child-question',
        isError: true,
        content: 'Question tool is unavailable'
      })
    )
    expect(childToolCalls).toBe(0)
  })

  it('retains a real failed child boundary and emits one truthful foreground failure', async () => {
    background = false
    failChild = true
    const parent = await launch()
    await childEntered.promise
    const id = childId(parent)
    await world.settled(id)
    sleepers.forEach(resume => resume())
    await world.settled(parent)
    expect(world.inspect(id).status).toBe('failed')
    const output = await events(parent)
    expect(output.filter(event => event._tag === 'SubagentCompleted')).toMatchObject([
      { status: 'error' }
    ])
    expect(output.find(event => event._tag === 'ToolExecutionCompleted')).toMatchObject({
      result: { isError: true, content: expect.stringContaining('Child workflow failed') }
    })
  })

  it('Stop while foreground waiting fences both later provider and child tool work', async () => {
    background = false
    const parent = await launch()
    await childEntered.promise
    await sleeping.promise
    await Effect.runPromise(
      stopAgentWorkflow(parent, 'owner').pipe(
        Effect.provide(Layer.merge(AgentWorkflowStore.layer, VercelWorkflows.layer))
      )
    )
    childGate.release()
    sleepers.forEach(resume => resume())
    await world.settled(childId(parent))
    await world.settled(parent)
    expect(world.inspect(parent).status).toBe('cancelled')
    expect(world.inspect(childId(parent)).status).toBe('cancelled')
    expect(requests.filter(request => request.systemPrompt === 'Parent')).toHaveLength(1)
    expect(childToolCalls).toBe(0)
  })

  it('fences provider retries when Stop lands during the retry delay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    retryChild = true
    const parent = await launch()
    await childEntered.promise
    await world.settled(parent)
    const id = childId(parent)
    await vi.waitFor(async () => {
      expect((await events(id)).some(event => event._tag === 'AgentRetry')).toBe(true)
    })
    await Effect.runPromise(
      stopAgentWorkflow(parent, 'owner').pipe(
        Effect.provide(Layer.merge(AgentWorkflowStore.layer, VercelWorkflows.layer))
      )
    )
    await vi.advanceTimersByTimeAsync(20_000)
    await world.settled(id)
    expect(requests.filter(request => request.systemPrompt === 'Child')).toHaveLength(1)
    expect((await events(id)).filter(event => event._tag === 'AgentRetry')).toHaveLength(1)
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
