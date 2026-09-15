// @vitest-environment node
import { Effect, Layer, Predicate, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  AgentError,
  AgentMessage,
  AgentUsage,
  AssistantAgentMessage,
  AssistantTextPart,
  ToolResult,
  ToolCall,
  ToolResultMessage,
  UserMessage
} from '@yolk-sdk/agent/protocol'
import {
  ContextTransformer,
  LLMError,
  LLMProvider,
  LoopConfig,
  ToolExecutor
} from '@yolk-sdk/agent/loop'
import { mergeWorkflowToolResultsStep } from './run-agent-workflow'
import { subagentUsageFromToolResult } from '@yolk-sdk/agent/tools'
import { AgentRouteRequest } from '@/lib/agents/route-handler'
import { agentTextCapabilities } from '@/lib/agents/text-agent-config'
import { AgentWorkflowStore } from '@/lib/services/agent-workflow/live-layer'
import {
  emptyWorkflowRegistry,
  transitionWorkflowRegistry,
  WorkflowChildRecord
} from '@/lib/services/agent-workflow/registry'
import {
  admitChildWorkflow,
  assertChildAdmission,
  attachChildWorkflow,
  childToolResultStep,
  persistChildTerminal,
  planWorkflowCall,
  WorkflowAgentContext
} from './child-control'
import { AgentTextRuntimeFactory, ChildWorkflowIdentity } from './child-runtime-host'

const metadata = { workflowRunId: 'child-a' }

let state = emptyWorkflowRegistry()

const launch = { parentRunId: 'parent', userId: 'owner', callId: 'call' }

const storeLayer = Layer.succeed(AgentWorkflowStore, {
  register: () => Effect.succeed(undefined),
  read: () => Effect.succeed(state),
  change: (_runId, _userId, command) =>
    Effect.sync(() => {
      state = transitionWorkflowRegistry(state, command)

      return state
    })
})

const identityLayer = Layer.succeed(ChildWorkflowIdentity, {
  workflowRunId: () => metadata.workflowRunId
})

const unusedRuntimeFactoryLayer = Layer.succeed(AgentTextRuntimeFactory, {
  make: () => Effect.die(new Error('Control-only operation must not construct a text runtime'))
})

const runControl = <A, E>(
  effect: Effect.Effect<A, E, AgentWorkflowStore | ChildWorkflowIdentity | AgentTextRuntimeFactory>
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(storeLayer),
      Effect.provide(identityLayer),
      Effect.provide(unusedRuntimeFactoryLayer)
    )
  )

const capturingRuntimeFactoryLayer = Layer.succeed(AgentTextRuntimeFactory, {
  make: (request, _userId, _route, options = {}) =>
    Effect.succeed({
      input: request,
      config: {
        model: request.model ?? 'test-model',
        reasoningEffort: request.reasoningEffort ?? 'low',
        systemPrompt: 'test',
        tools: [],
        capabilities: agentTextCapabilities
      },
      layer: Layer.mergeAll(
        ContextTransformer.identity,
        LoopConfig.defaultLayer,
        Layer.succeed(LLMProvider, {
          stream: () =>
            Stream.fail(
              new LLMError({
                message: 'LLMProvider is not used in child-control plan tests',
                cause: 'provider_error',
                retryable: false
              })
            )
        }),
        Layer.succeed(ToolExecutor, {
          execute: call => {
            if (options.executeSubagent === undefined) {
              return Effect.succeed(
                ToolResult.make({ toolCallId: call.id, content: 'not a subagent launch' })
              )
            }

            const params = call.params

            if (
              !Predicate.isObjectOrArray(params) ||
              !('description' in params) ||
              !('prompt' in params) ||
              !('subagent_type' in params) ||
              !Predicate.isString(params.description) ||
              !Predicate.isString(params.prompt) ||
              !Predicate.isString(params.subagent_type)
            ) {
              return Effect.succeed(
                ToolResult.make({
                  toolCallId: call.id,
                  content: 'Invalid child handle',
                  isError: true
                })
              )
            }

            return options.executeSubagent({
              call,
              context: {
                surface: 'text',
                route: '/agent/workflow',
                userId: 'owner'
              },
              params: {
                description: params.description,
                prompt: params.prompt,
                subagent_type: params.subagent_type,
                model:
                  'model' in params && Predicate.isString(params.model) ? params.model : undefined,
                background: 'background' in params && params.background === true ? true : undefined
              }
            })
          }
        })
      )
    })
})

beforeEach(async () => {
  state = emptyWorkflowRegistry()
  metadata.workflowRunId = 'child-a'

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

describe('Next child control steps without DB', () => {
  it('self-admits before work; duplicate physical attempts cannot execute', async () => {
    expect(await runControl(admitChildWorkflow(launch))).toMatchObject({
      context: { parentRunId: 'parent', callId: 'call', childType: 'general' }
    })
    metadata.workflowRunId = 'child-b'
    expect(await runControl(admitChildWorkflow(launch))).toBeNull()
    expect(await runControl(attachChildWorkflow(launch, 'child-b'))).toBe('child-a')
    expect(state.children[0]?.workflowRunId).toBe('child-a')

    const check = await Effect.runPromise(
      assertChildAdmission(
        WorkflowAgentContext.make({ ...launch, childType: 'general' }),
        'child-b'
      ).pipe(Effect.provide(storeLayer), Effect.result)
    )

    expect(check._tag).toBe('Failure')
  })

  it('fences start-response attachment and the next child step after Stop', async () => {
    state = transitionWorkflowRegistry(state, { type: 'stop' })
    expect(await runControl(attachChildWorkflow(launch, 'child-a'))).toBeNull()
    expect(await runControl(admitChildWorkflow(launch))).toBeNull()
    expect(state.children[0]?.workflowRunId).toBeNull()
  })

  it('persists typed child outcomes independently and lookup observations never charge usage twice', async () => {
    await runControl(admitChildWorkflow(launch))

    const message = AssistantAgentMessage.make({
      parts: [AssistantTextPart.make({ content: 'Finished work' })]
    })

    const encodedMessage = await Effect.runPromise(Schema.encodeEffect(AgentMessage)(message))
    const usage = AgentUsage.make({ input: { total: 12 }, output: { total: 4 } })

    const result = await runControl(
      persistChildTerminal(launch, {
        status: 'completed',
        state: {
          request: null,
          createdMessages: [encodedMessage],
          turn: 2,
          usage: await Effect.runPromise(Schema.encodeEffect(AgentUsage)(usage))
        }
      })
    )

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
    await runControl(admitChildWorkflow(launch))

    const outcome = await runControl(
      persistChildTerminal(launch, {
        status: 'error',
        state: { request: null, createdMessages: [], turn: 1 }
      })
    )

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
    expect(Object.hasOwn(committed, 'failure')).toBe(false)
    expect(Object.keys(committed)).toEqual([
      'messages',
      'createdMessages',
      'usage',
      'eventSequence'
    ])
    expect(JSON.stringify(committed)).toBe(
      JSON.stringify({
        messages: committed.messages,
        createdMessages: committed.createdMessages,
        usage: committed.usage,
        eventSequence: 9
      })
    )
    const reversed = await mergeWorkflowToolResultsStep(input, [...results].reverse())
    expect(reversed.failure).toMatchObject(
      AgentError.make({
        code: 'tool_error',
        message: 'Workflow tool batch did not produce one ordered result per call',
        retryable: false
      })
    )
    expect(Object.hasOwn(reversed, 'failure')).toBe(true)
    expect(Object.keys(reversed)).toEqual([
      'messages',
      'createdMessages',
      'usage',
      'eventSequence',
      'failure'
    ])
    expect(JSON.stringify(reversed)).toBe(
      JSON.stringify({
        messages: reversed.messages,
        createdMessages: reversed.createdMessages,
        usage: reversed.usage,
        eventSequence: reversed.eventSequence,
        failure: reversed.failure
      })
    )
    const partial = await mergeWorkflowToolResultsStep(input, results.slice(1))
    expect(partial.failure).toBeDefined()
    expect(Object.hasOwn(partial, 'failure')).toBe(true)
    expect(Object.keys(partial)).toEqual([
      'messages',
      'createdMessages',
      'usage',
      'eventSequence',
      'failure'
    ])
  })

  it('preserves sibling merge failure identity, nullish precedence, and omitted own keys', async () => {
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
    const siblingFailure = { code: 'tool_error', message: 'kept-sibling', retryable: false }

    const withSibling = await mergeWorkflowToolResultsStep(input, [
      { messages: [messages[0]], createdMessages: [messages[0]], failure: siblingFailure },
      { messages: [messages[1]], createdMessages: [messages[1]] }
    ])

    expect(withSibling.failure).toBe(siblingFailure)
    expect(withSibling.messages[0]).toBe(messages[0])
    expect(Object.hasOwn(withSibling, 'failure')).toBe(true)
    expect(Object.keys(withSibling)).toEqual([
      'messages',
      'createdMessages',
      'usage',
      'eventSequence',
      'failure'
    ])

    const zeroFailure = await mergeWorkflowToolResultsStep(input, [
      { messages: [messages[0]], createdMessages: [messages[0]], failure: 0 },
      { messages: [messages[1]], createdMessages: [messages[1]] }
    ])

    expect(zeroFailure.failure).toBe(0)
    expect(Object.hasOwn(zeroFailure, 'failure')).toBe(true)

    const falseFailure = await mergeWorkflowToolResultsStep(input, [
      { messages: [messages[0]], createdMessages: [messages[0]], failure: false },
      { messages: [messages[1]], createdMessages: [messages[1]] }
    ])

    expect(falseFailure.failure).toBe(false)
    expect(Object.hasOwn(falseFailure, 'failure')).toBe(true)

    const nullFailure = await mergeWorkflowToolResultsStep(input, [
      { messages: [messages[0]], createdMessages: [messages[0]], failure: null },
      { messages: [messages[1]], createdMessages: [messages[1]] }
    ])

    expect(Object.hasOwn(nullFailure, 'failure')).toBe(false)
    expect(nullFailure.failure).toBeUndefined()

    const executionFailure = AgentError.make({
      code: 'unknown',
      message: 'execution-owner',
      retryable: false
    })

    const withExecution = await mergeWorkflowToolResultsStep(
      input,
      [
        { messages: [messages[0]], createdMessages: [messages[0]], failure: siblingFailure },
        { messages: [messages[1]], createdMessages: [messages[1]] }
      ],
      executionFailure
    )

    expect(withExecution.failure).not.toBe(siblingFailure)
    expect(withExecution.failure).toMatchObject(executionFailure)
    expect(Object.keys(withExecution)).toEqual([
      'messages',
      'createdMessages',
      'usage',
      'eventSequence',
      'failure'
    ])
  })

  it('plans lookup/wait from an injectable run identity without a text runtime', async () => {
    const context = await Effect.runPromise(
      Schema.encodeEffect(WorkflowAgentContext)(WorkflowAgentContext.make({ userId: 'owner' }))
    )

    const [statusCall, waitCall, invalidCall, otherCall] = await Effect.runPromise(
      Effect.forEach(
        [
          ToolCall.make({
            id: 'status',
            name: 'subagent_status',
            params: { tool_call_id: 'call', parent_run_id: 'original-parent' }
          }),
          ToolCall.make({
            id: 'wait',
            name: 'subagent_wait',
            params: { tool_call_id: 'call' }
          }),
          ToolCall.make({ id: 'bad', name: 'subagent_status', params: {} }),
          ToolCall.make({ id: 'read', name: 'read', params: {} })
        ],
        call => Schema.encodeEffect(ToolCall)(call)
      )
    )

    const status = await runControl(planWorkflowCall({ context, request: null, call: statusCall }))
    expect(status).toEqual({
      type: 'lookup',
      child: { parentRunId: 'original-parent', userId: 'owner', callId: 'call' },
      wait: false
    })

    metadata.workflowRunId = 'live-parent'
    const wait = await runControl(planWorkflowCall({ context, request: null, call: waitCall }))
    expect(wait).toEqual({
      type: 'lookup',
      child: { parentRunId: 'live-parent', userId: 'owner', callId: 'call' },
      wait: true
    })

    const invalid = await runControl(
      planWorkflowCall({ context, request: null, call: invalidCall })
    )

    expect(invalid.type).toBe('result')

    if (invalid.type === 'result') {
      const decoded = await Effect.runPromise(
        Schema.decodeUnknownEffect(ToolResult)(invalid.result)
      )

      expect(decoded.isError).toBe(true)
      expect(decoded.content).toBe('Invalid child handle')
    }

    expect(await runControl(planWorkflowCall({ context, request: null, call: otherCall }))).toEqual(
      { type: 'normal' }
    )
  })

  it('reserves a child launch through an injectable text runtime factory', async () => {
    state = emptyWorkflowRegistry()
    metadata.workflowRunId = 'parent'

    const context = await Effect.runPromise(
      Schema.encodeEffect(WorkflowAgentContext)(WorkflowAgentContext.make({ userId: 'owner' }))
    )

    const request = await Effect.runPromise(
      Schema.encodeEffect(AgentRouteRequest)(
        AgentRouteRequest.make({
          sessionId: 'session',
          messages: [UserMessage.make({ content: 'parent' })],
          model: 'parent-model'
        })
      )
    )

    const call = await Effect.runPromise(
      Schema.encodeEffect(ToolCall)(
        ToolCall.make({
          id: 'call',
          name: 'subagent',
          params: {
            description: 'Work',
            prompt: 'do it',
            subagent_type: 'general',
            background: true
          }
        })
      )
    )

    const plan = await Effect.runPromise(
      planWorkflowCall({ context, request, call }).pipe(
        Effect.provide(storeLayer),
        Effect.provide(identityLayer),
        Effect.provide(capturingRuntimeFactoryLayer)
      )
    )

    expect(plan).toMatchObject({
      type: 'launch',
      child: { parentRunId: 'parent', userId: 'owner', callId: 'call' },
      background: true,
      model: 'parent-model',
      workflowRunId: null
    })
    expect(state.children[0]).toMatchObject({
      callId: 'call',
      subagentType: 'general',
      description: 'Work',
      workflowRunId: null
    })
  })
})
