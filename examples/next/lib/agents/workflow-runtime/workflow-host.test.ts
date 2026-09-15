// @vitest-environment node
import { Effect, Layer, Predicate, Result, Stream, type LogLevel, type References } from 'effect'
import { EffectDrizzleQueryError } from 'drizzle-orm/effect-core/errors'
import { getWorkflowMetadata, type sleep as workflowSleep } from 'workflow'
import { WorkflowRunNotFoundError } from 'workflow/errors'
import * as Schema from 'effect/Schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentEvent,
  AgentUsage,
  AssistantAgentMessage,
  AssistantTextPart,
  HostToolCallPart,
  ToolCall,
  ToolResult,
  ToolResultMessage,
  UserMessage,
  ToolApprovalPolicy,
  ToolApprovalResponse
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
import { AppLayer } from '@/lib/layers'
import { reportError } from '@/lib/services/telemetry/report-error'
import { reportWarning } from '@/lib/services/telemetry/report-warning'
import { admitTelemetryLogContext } from '@/lib/services/telemetry/telemetry-context'
import type { makeAgentTextRuntime } from './text-response'
import { agentWorkflowHitlHookToken, runAgentWorkflow } from './run-agent-workflow'
import { readChildWorkflowStep } from './workflow-child-steps'

type CapturedLogEntry = {
  readonly message: unknown
  readonly logLevel: LogLevel.LogLevel
  readonly annotations: ReturnType<typeof References.CurrentLogAnnotations.defaultValue>
}

const capturedLogs = vi.hoisted(() => {
  const entries: Array<CapturedLogEntry> = []

  return {
    entries,
    record(entry: CapturedLogEntry) {
      entries.push(entry)
    },
    clear() {
      entries.length = 0
    }
  }
})

const reportedLogs = () =>
  capturedLogs.entries.filter(
    entry =>
      entry.annotations.error_type !== undefined || entry.annotations.warning_type !== undefined
  )

// Exercise the real host entrypoints, loop, serializers, registry transitions and tool dispatch.
// Only provider/runtime construction, persistence and the platform transport are behavioral fakes.
// AppLayer is still a test Layer (no Auth/Db/OTel); it owns a capturing Effect Logger so
// real reportError emission is observed without mocking the reporter.
vi.mock('@/lib/layers', async () => {
  const { Logger } = await import('effect')
  const { CurrentLogAnnotations } = await import('effect/References')

  return {
    AppLayer: Logger.layer([
      Logger.make(options => {
        capturedLogs.record({
          message: options.message,
          logLevel: options.logLevel,
          annotations: { ...options.fiber.getRef(CurrentLogAnnotations) }
        })
      })
    ])
  }
})

vi.mock('./text-response', () => ({
  makeAgentTextRuntime: (...args: Parameters<typeof makeAgentTextRuntime>) =>
    runtimeFactory(...args)
}))

vi.mock('workflow', async () => {
  const { testWorkflowModule } = await import('@yolk-sdk/vercel-workflows/testing')

  const sleep: typeof workflowSleep = async duration => {
    sleepDurations.push(duration)

    // Test-harness runaway guard, not a claim about platform quotas.
    if (autoSleep) {
      if (advanceSleepClock && Predicate.isNumber(duration)) vi.setSystemTime(Date.now() + duration)

      if (sleepDurations.length > 40) throw new Error('Unbounded observation')

      return
    }

    sleeping.release()
    await new Promise<void>(resolve => sleepers.push(resolve))
  }

  return {
    ...testWorkflowModule,
    createHook: <T>(input: { token: string }) => {
      const hook = testWorkflowModule.createHook<T>(input)
      hitlEntered.release()

      return hook
    },
    sleep
  }
})

vi.mock('workflow/api', () => ({
  start: async <A extends unknown[], R>(fn: (...args: A) => Promise<R>, args: A) => {
    workflowStarts++

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

let workflowStarts = 0

let requests: LLMRequest[] = []

let parentStream:
  | ((request: LLMRequest) => Stream.Stream<LLMTextDelta | LLMToolCall | LLMUsage | LLMDone>)
  | undefined

let registries = new Map<string, { userId: string; state: WorkflowRegistry }>()

const originalStoreLayer = AgentWorkflowStore.layer

const childCall = () => {
  const params = {
    description: 'Research',
    prompt: 'Only child context',
    subagent_type: 'general'
  }

  const modelParams = childModel === undefined ? params : { ...params, model: childModel }

  return ToolCall.make({
    id: 'child-call',
    name: 'subagent',
    params: { ...modelParams, background }
  })
}

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

      if (!child && parentStream !== undefined) return parentStream(request)

      const results = request.messages.filter(message => Predicate.isTagged(message, 'ToolResult'))

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
  capturedLogs.clear()
  background = true
  childModel = undefined
  gated = false
  waitAfterFailure = false
  previousParent = undefined
  childToolCalls = 0
  workflowStarts = 0
  requests = []
  parentStream = undefined

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
    expect(workflowStarts).toBe(1)
    expect(world.inspect(parent).status).toBe('completed')
    const id = childId(parent)
    expect(world.inspect(id).status).toBe('running')
    const parentEvents = await events(parent)
    expect(parentEvents.filter(event => Predicate.isTagged(event, 'SubagentStarted'))).toHaveLength(
      1
    )
    expect(parentEvents.some(event => Predicate.isTagged(event, 'SubagentCompleted'))).toBe(false)
    expect(parentEvents.find(event => Predicate.isTagged(event, 'AgentEnd'))).toMatchObject({
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
      (await events(followup)).find(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))
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
      expect(
        (await events(parent)).find(event => Predicate.isTagged(event, 'SubagentStarted'))
      ).toMatchObject({
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
    expect(during.filter(event => Predicate.isTagged(event, 'SubagentStarted'))).toHaveLength(1)
    expect(during.some(event => Predicate.isTagged(event, 'SubagentCompleted'))).toBe(false)
    childGate.release()
    await world.settled(childId(parent))
    sleepers.forEach(resume => resume())
    await world.settled(parent)
    const after = await events(parent)
    expect(after.filter(event => Predicate.isTagged(event, 'SubagentStarted'))).toHaveLength(1)
    expect(after.filter(event => Predicate.isTagged(event, 'SubagentCompleted'))).toHaveLength(1)
    expect(after.find(event => Predicate.isTagged(event, 'AgentEnd'))).toMatchObject({
      usage: childUsage
    })
    expect(world.inspect(parent).status).toBe('completed')
  })

  it('does not reserve or launch until every sibling approval is resolved', async () => {
    gated = true
    const parent = await launch()
    await hitlEntered.promise
    expect(registries.get(parent)?.state.children).toHaveLength(0)
    expect((await events(parent)).some(event => Predicate.isTagged(event, 'SubagentStarted'))).toBe(
      false
    )
    await world.sdk.resumeHook(
      agentWorkflowHitlHookToken({ runId: parent }),
      ToolApprovalResponse.make({
        requestId: 'approval:gated',
        toolCallId: 'gated',
        decision: 'denied',
        source: 'user'
      })
    )
    await childEntered.promise
    await world.settled(parent)
    expect(
      (await events(parent))
        .filter(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))
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
    expect(output.some(event => Predicate.isTagged(event, 'SubagentCompleted'))).toBe(false)
    expect(
      output.find(
        event =>
          Predicate.isTagged(event, 'ToolExecutionCompleted') && event.result.toolCallId === 'wait'
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
      (await events(parent)).find(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))
    ).toMatchObject({ result: { isError: true } })
  })

  it('reports recovered preparation failure once without leaking error messages or request data', async () => {
    preparationFailure = new WorkflowRegistryError({
      message: 'Sensitive SQL parameters and credentials'
    })
    const parent = await launch()
    await world.settled(parent)
    expect(world.inspect(parent).status).toBe('completed')
    expect(reportedLogs()).toEqual([
      {
        message: ['Child launch preparation failed'],
        logLevel: 'Error',
        annotations: {
          error_type: 'WorkflowChildPreparationError',
          operation: 'agent.workflow.child.prepare',
          runId: parent,
          toolCallId: 'child-call',
          cause_type: 'WorkflowRegistryError'
        }
      }
    ])
    expect(JSON.stringify(capturedLogs.entries)).not.toContain(
      'Sensitive SQL parameters and credentials'
    )
    expect(
      (await events(parent)).find(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))
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
    expect(reportedLogs()).toEqual([])
    expect(
      (await events(parent)).find(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))
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
    expect(output.find(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))).toMatchObject(
      {
        result: {
          isError: true,
          content: 'Child handle not found',
          structuredContent: { workflow_run_id: null }
        }
      }
    )
    expect(JSON.stringify(output)).not.toContain(childId(parent))
    expect(reportedLogs()).toEqual([])

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
    expect(output.find(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))).toMatchObject(
      {
        result: {
          structuredContent: { type: 'subagent_accepted', workflow_run_id: childId(parent) }
        }
      }
    )
    expect(statusReads).toBe(0)
    expect(output.some(event => Predicate.isTagged(event, 'SubagentCompleted'))).toBe(false)
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
      expect(output.filter(event => Predicate.isTagged(event, 'SubagentCompleted'))).toHaveLength(0)
      expect(output.find(event => Predicate.isTagged(event, 'AgentEnd'))).toMatchObject({
        usage: { input: { total: 0 }, output: { total: 0 } }
      })
      expect(
        output.find(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))
      ).toMatchObject({
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
        (await events(followup)).find(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))
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
        event =>
          Predicate.isTagged(event, 'ToolExecutionCompleted') && event.result.toolCallId === 'wait'
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
    expect(output.find(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))).toMatchObject(
      {
        result: {
          content: expect.stringContaining('unconfirmed'),
          structuredContent: { done: false, workflow_run_id: childId(parent) }
        }
      }
    )
    expect(output.some(event => Predicate.isTagged(event, 'SubagentCompleted'))).toBe(false)
    expect(sleepDurations).toEqual([1000, 5000, 15000, 30000, 30000])
    expect(registries.get(parent)?.state.children[0]?.result).toBeNull()
    missingStatus = false
    childGate.release()
    await world.settled(childId(parent))
    previousParent = parent
    const followup = await launch('follow-up')
    await world.settled(followup)
    expect(
      (await events(followup)).find(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))
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
          event =>
            Predicate.isTagged(event, 'ToolExecutionCompleted') &&
            event.result.toolCallId === callId
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
      expect(output.find(event => Predicate.isTagged(event, 'AgentEnd'))).toMatchObject({
        usage: { input: { total: 0 }, output: { total: 0 } }
      })

      const parentObservation = requests
        .filter(request => request.systemPrompt === 'Parent')
        .at(-1)
        ?.messages.find(
          (message): message is ToolResultMessage =>
            Predicate.isTagged(message, 'ToolResult') && message.toolCallId === callId
        )

      expect(parentObservation?.content).toEqual(
        expect.stringContaining(`tool_call_id=child-call parent_run_id=${parent}`)
      )
      expect(sleepDurations).toHaveLength(31)
      expect(sleepDurations.slice(0, 5)).toEqual([1000, 5000, 15000, 30000, 30000])
      expect(output.some(event => Predicate.isTagged(event, 'SubagentCompleted'))).toBe(false)
      childGate.release()
      await world.settled(childId(parent))
      previousParent = parent
      waitAfterFailure = false
      const followup = await launch('follow-up')
      await world.settled(followup)
      const followupEvents = await events(followup)
      expect(
        followupEvents.find(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))
      ).toMatchObject({
        result: { content: expect.stringContaining('Child final answer') }
      })
      expect(followupEvents.find(event => Predicate.isTagged(event, 'AgentEnd'))).toMatchObject({
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
        event =>
          Predicate.isTagged(event, 'QuestionRequested') ||
          Predicate.isTagged(event, 'AgentAwaitingInput')
      )
    ).toBe(false)
    expect(world.inspect(id).status).toBe('completed')

    const childQuestionResult = requests
      .filter(request => request.systemPrompt === 'Child')
      .at(-1)
      ?.messages.find(
        message =>
          Predicate.isTagged(message, 'ToolResult') && message.toolCallId === 'child-question'
      )

    expect(childQuestionResult).toMatchObject({
      isError: true,
      content: 'Question tool is unavailable'
    })
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
    expect(output.filter(event => Predicate.isTagged(event, 'SubagentCompleted'))).toMatchObject([
      { status: 'error' }
    ])
    expect(output.find(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))).toMatchObject(
      {
        result: { isError: true, content: expect.stringContaining('Child workflow failed') }
      }
    )
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
      expect((await events(id)).some(event => Predicate.isTagged(event, 'AgentRetry'))).toBe(true)
    })
    await Effect.runPromise(
      stopAgentWorkflow(parent, 'owner').pipe(
        Effect.provide(Layer.merge(AgentWorkflowStore.layer, VercelWorkflows.layer))
      )
    )
    await vi.advanceTimersByTimeAsync(20_000)
    await world.settled(id)
    expect(requests.filter(request => request.systemPrompt === 'Child')).toHaveLength(1)
    expect(
      (await events(id)).filter(event => Predicate.isTagged(event, 'AgentRetry'))
    ).toHaveLength(1)
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

  it('fails a partial text stream with missing Done without continuing or retrying the provider', async () => {
    parentStream = () => Stream.fromIterable([LLMTextDelta.make({ text: 'partial' })])
    const parent = await launch()
    await world.settled(parent)
    const inspection = world.inspect(parent)
    const output = await events(parent)
    const result = await world.sdk.getRun(parent).returnValue

    expect(inspection.status).toBe('completed')
    expect(inspection.streamClosed).toBe(true)
    expect(Predicate.isTagged(result, 'ModelStepFailed')).toBe(true)
    expect(result).toMatchObject({ turn: 1 })
    expect(requests).toHaveLength(1)
    expect(workflowStarts).toBe(0)
    expect(childToolCalls).toBe(0)
    expect(output.some(event => Predicate.isTagged(event, 'AgentEnd'))).toBe(false)
    expect(output.some(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))).toBe(false)
    expect(output.some(event => Predicate.isTagged(event, 'AssistantMessage'))).toBe(false)
    expect(output.filter(event => Predicate.isTagged(event, 'TurnStart'))).toHaveLength(1)
    expect(output.find(event => Predicate.isTagged(event, 'LLMTextDelta'))).toMatchObject({
      text: 'partial'
    })
    expect(output.find(event => Predicate.isTagged(event, 'AgentError'))).toMatchObject({
      code: 'invalid_response',
      retryable: false,
      message: 'Expected exactly one LLM done event, received 0'
    })
  })

  it('does not dispatch a completed tool call when Done is missing', async () => {
    parentStream = () => Stream.fromIterable([LLMToolCall.make({ call: childCall() })])
    const parent = await launch()
    await world.settled(parent)
    const output = await events(parent)
    const result = await world.sdk.getRun(parent).returnValue

    expect(world.inspect(parent).status).toBe('completed')
    expect(Predicate.isTagged(result, 'ModelStepFailed')).toBe(true)
    expect(result).toMatchObject({ turn: 1 })
    expect(requests).toHaveLength(1)
    expect(workflowStarts).toBe(0)
    expect(childToolCalls).toBe(0)
    expect(output.find(event => Predicate.isTagged(event, 'ToolInputEnd'))).toMatchObject({
      call: { id: 'child-call', name: 'subagent' }
    })
    expect(output.some(event => Predicate.isTagged(event, 'ToolExecutionStarted'))).toBe(false)
    expect(output.some(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))).toBe(false)
    expect(output.some(event => Predicate.isTagged(event, 'SubagentStarted'))).toBe(false)
    expect(output.some(event => Predicate.isTagged(event, 'AgentEnd'))).toBe(false)
    expect(output.find(event => Predicate.isTagged(event, 'AgentError'))).toMatchObject({
      code: 'invalid_response',
      retryable: false,
      message: 'Expected exactly one LLM done event, received 0'
    })
  })

  it('preserves transcript, cumulative usage, and unique durable event ids on a successful tool turn', async () => {
    const firstUsage = AgentUsage.make({ input: { total: 3 }, output: { total: 1 } })
    const secondUsage = AgentUsage.make({ input: { total: 5 }, output: { total: 2 } })
    const readCall = ToolCall.make({ id: 'read-call', name: 'read', params: {} })
    const hostToolCallPart = HostToolCallPart.make({ call: readCall })
    const toolTurnAssistant = AssistantAgentMessage.make({ parts: [hostToolCallPart] })

    const readToolResult = ToolResultMessage.make({
      toolCallId: 'read-call',
      content: 'read result'
    })

    const finalAssistant = AssistantAgentMessage.make({
      parts: [AssistantTextPart.make({ content: 'Parent done' })]
    })

    parentStream = request => {
      const results = request.messages.filter(message => Predicate.isTagged(message, 'ToolResult'))

      return results.length === 0
        ? Stream.fromIterable([
            LLMToolCall.make({
              call: ToolCall.make({ id: 'read-call', name: 'read', params: {} })
            }),
            LLMUsage.make({ usage: firstUsage }),
            LLMDone.make({ stopReason: 'tool_use' })
          ])
        : Stream.fromIterable([
            LLMTextDelta.make({ text: 'Parent done' }),
            LLMUsage.make({ usage: secondUsage }),
            LLMDone.make({ stopReason: 'stop' })
          ])
    }

    const parent = await launch()
    await world.settled(parent)
    const inspection = world.inspect(parent)
    const output = await events(parent)
    const result = await world.sdk.getRun(parent).returnValue
    const eventIds = output.map(event => event.eventId)
    const end = output.find(event => Predicate.isTagged(event, 'AgentEnd'))

    expect(inspection.status).toBe('completed')
    expect(inspection.streamClosed).toBe(true)
    expect(Predicate.isTagged(result, 'Completed')).toBe(true)
    expect(result).toMatchObject({
      turns: 2,
      state: {
        messages: [
          UserMessage.make({ content: 'Parent private context' }),
          toolTurnAssistant,
          readToolResult,
          finalAssistant
        ],
        createdMessages: [toolTurnAssistant, readToolResult, finalAssistant],
        usage: { input: { total: 8 }, output: { total: 3 } }
      }
    })
    expect(requests).toHaveLength(2)
    expect(childToolCalls).toBe(1)
    expect(workflowStarts).toBe(0)
    expect(requests[1]?.messages).toEqual([
      UserMessage.make({ content: 'Parent private context' }),
      expect.objectContaining(toolTurnAssistant),
      expect.objectContaining(readToolResult)
    ])
    expect(output.find(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))).toMatchObject(
      {
        result: { toolCallId: 'read-call', content: 'read result' }
      }
    )
    expect(end).toMatchObject({
      turns: 2,
      usage: { input: { total: 8 }, output: { total: 3 } }
    })
    expect(end?.messages).toEqual([
      expect.objectContaining(toolTurnAssistant),
      expect.objectContaining(readToolResult),
      expect.objectContaining(finalAssistant)
    ])
    // Keep literal tag oracles independent of the expected-message constructors.
    expect(end?.messages.map(message => message._tag)).toEqual([
      'Assistant',
      'ToolResult',
      'Assistant'
    ])
    expect(
      end?.messages.flatMap(message =>
        Predicate.isTagged(message, 'Assistant') ? message.parts.map(part => part._tag) : []
      )
    ).toEqual(['HostToolCall', 'Text'])
    const tags = output.map(event => event._tag)
    expect(tags.indexOf('ToolInputEnd')).toBeGreaterThan(-1)
    expect(tags.indexOf('ToolExecutionCompleted')).toBeGreaterThan(tags.indexOf('ToolInputEnd'))
    expect(tags.lastIndexOf('LLMTextDelta')).toBeGreaterThan(tags.indexOf('ToolExecutionCompleted'))
    expect(tags.indexOf('AgentEnd')).toBeGreaterThan(tags.lastIndexOf('LLMTextDelta'))
    expect(output.some(event => Predicate.isTagged(event, 'AgentError'))).toBe(false)
    expect(
      eventIds.every(eventId => eventId !== undefined && eventId.startsWith(`workflow:${parent}:`))
    ).toBe(true)
    expect(new Set(eventIds).size).toBe(eventIds.length)

    const sequenced = eventIds.flatMap(eventId => {
      if (eventId === undefined) return []
      const rest = eventId.slice(`workflow:${parent}:`.length)
      const [turn, sequence] = rest.split(':')
      const parsedTurn = Number(turn)
      const parsedSequence = Number(sequence)

      return Number.isInteger(parsedTurn) && Number.isInteger(parsedSequence)
        ? [{ turn: parsedTurn, sequence: parsedSequence }]
        : []
    })

    const firstTurn = sequenced.filter(event => event.turn === 1).map(event => event.sequence)
    const secondTurn = sequenced.filter(event => event.turn === 2).map(event => event.sequence)
    expect(firstTurn.length).toBeGreaterThan(0)
    expect(secondTurn.length).toBeGreaterThan(0)
    expect(Math.max(...firstTurn)).toBeLessThan(Math.min(...secondTurn))
  })
})

describe('telemetry context admission', () => {
  beforeEach(() => {
    capturedLogs.clear()
  })

  it('projects allowlisted fields and drops unknown, sensitive, symbol, and invalid values', async () => {
    const secret = Symbol('secret')

    const context = {
      operation: 'agent.workflow.step',
      status: 500,
      runId: 'run_1',
      toolCallId: 'call_1',
      cause_type: 'WorkflowRegistryError',
      entityId: 'entity_1',
      userId: 'user_1',
      retries: 3,
      error_type: 'spoofed',
      warning_type: 'spoofed',
      password: 'hunter2',
      token: 'abc',
      prompt: 'SYSTEM PROMPT',
      [secret]: 'symbol-leak',
      statusCode: 500
    }

    await Effect.runPromise(
      reportError(
        new LLMError({
          cause: 'provider_error',
          retryable: false,
          message: 'visible message token=caller-owned'
        }),
        context
      ).pipe(Effect.provide(AppLayer))
    )

    expect(capturedLogs.entries).toEqual([
      {
        message: ['visible message token=caller-owned'],
        logLevel: 'Error',
        annotations: {
          operation: 'agent.workflow.step',
          status: 500,
          runId: 'run_1',
          toolCallId: 'call_1',
          cause_type: 'WorkflowRegistryError',
          entityId: 'entity_1',
          userId: 'user_1',
          retries: 3,
          error_type: 'LLMError'
        }
      }
    ])
    expect(JSON.stringify(capturedLogs.entries)).not.toContain('spoofed')
    expect(JSON.stringify(capturedLogs.entries)).not.toContain('hunter2')
    expect(JSON.stringify(capturedLogs.entries)).not.toContain('SYSTEM PROMPT')
    expect(JSON.stringify(capturedLogs.entries)).not.toContain('symbol-leak')
    expect(JSON.stringify(capturedLogs.entries)).toContain('token=caller-owned')
  })

  it('keeps valid fields when some context values are nonfinite or mistyped', async () => {
    const context = {
      operation: 'agent.workflow.child.prepare',
      status: Number.POSITIVE_INFINITY,
      retries: Number.NaN,
      runId: 12,
      toolCallId: null,
      cause_type: { tag: 'nested' }
    }

    const admitted = await Effect.runPromise(admitTelemetryLogContext(context))
    expect(admitted).toEqual({ operation: 'agent.workflow.child.prepare' })

    await Effect.runPromise(
      reportError(
        new LLMError({ cause: 'provider_error', retryable: false, message: 'still reported' }),
        admitted
      ).pipe(Effect.provide(AppLayer))
    )

    expect(capturedLogs.entries).toEqual([
      {
        message: ['still reported'],
        logLevel: 'Error',
        annotations: {
          operation: 'agent.workflow.child.prepare',
          error_type: 'LLMError'
        }
      }
    ])
  })

  it('does not let invalid context mask the original tapError failure', async () => {
    const decoded = Schema.decodeUnknownResult(Schema.String)(42)

    if (Result.isSuccess(decoded)) throw new Error('Expected invalid string fixture')

    const business = decoded.failure

    expect(business).not.toBeInstanceOf(Error)

    const exploding = {
      get operation(): never {
        throw new Error('context exploded')
      },
      password: 'hunter2'
    }

    const result = await Effect.runPromise(
      Effect.fail(business).pipe(
        Effect.tapError(error => reportError(error, exploding)),
        Effect.catch(error => Effect.succeed(error)),
        Effect.provide(AppLayer)
      )
    )

    expect(result).toBe(business)
    expect(capturedLogs.entries).toEqual([
      {
        message: [business.message],
        logLevel: 'Error',
        annotations: { error_type: 'SchemaError' }
      }
    ])
    expect(JSON.stringify(capturedLogs.entries)).not.toContain('hunter2')
    expect(JSON.stringify(capturedLogs.entries)).not.toContain('context exploded')
  })

  it('ignores non-object context and still logs the warning type', async () => {
    expect(await Effect.runPromise(admitTelemetryLogContext(['operation', 'secret']))).toEqual({})
    expect(await Effect.runPromise(admitTelemetryLogContext(null))).toEqual({})

    const arrayWithContext = Object.assign([], { operation: 'not a context record' })

    const functionWithContext = Object.assign(() => undefined, {
      operation: 'not a context record'
    })

    expect(await Effect.runPromise(admitTelemetryLogContext(arrayWithContext))).toEqual({})
    expect(await Effect.runPromise(admitTelemetryLogContext(functionWithContext))).toEqual({})

    await Effect.runPromise(
      reportWarning(
        new LLMError({ cause: 'provider_error', retryable: false, message: 'fallback used' })
      ).pipe(Effect.provide(AppLayer))
    )

    expect(capturedLogs.entries).toEqual([
      {
        message: ['fallback used'],
        logLevel: 'Warn',
        annotations: { warning_type: 'LLMError' }
      }
    ])
  })
})
