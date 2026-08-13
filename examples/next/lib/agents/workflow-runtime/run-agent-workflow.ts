import { createHook, getWorkflowMetadata, getWritable } from 'workflow'
import { Effect, Ref, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import {
  makeDurableAgentEventSequencerState,
  runVercelAgentWorkflow,
  writeDurableAgentEvent,
  type SerializableWorkflowState,
  type VercelAgentWorkflowModelStepResult,
  type VercelAgentWorkflowToolBatchStepResult
} from '@yolk-sdk/vercel-workflows'
import {
  addAgentUsage,
  AgentEnd,
  AgentUsage,
  AssistantMessageEvent,
  AgentMessage,
  AgentAwaitingInput,
  ToolCall,
  HitlRequest,
  HitlResponse,
  ToolInputEnd,
  ToolResultMessage,
  TurnEnd,
  UsageUpdate,
  type AgentEvent,
  zeroAgentUsage
} from '@yolk-sdk/agent/protocol'
import { runModelTurn, runToolBatch } from '@yolk-sdk/agent/loop'
import { AppLayer } from '@/lib/layers'
import { reportError } from '@/lib/services/telemetry/report-error'
import {
  AgentRouteRequest,
  validateAgentRouteDocuments,
  validateAgentRouteImages
} from '@/lib/agents/route-handler'
import { makeAgentTextRuntime } from './text-response'
import { addWorkflowToolResultUsage } from './workflow-tool-usage'
import { AgentWorkflowStepError, workflowErrorEvent, workflowStepError } from './workflow-error'

export type AgentWorkflowInput = {
  readonly userId: string
  readonly request: unknown
}

type IndexedToolResultMessage = {
  readonly index: number
  readonly message: AgentMessage
}

const workflowEventStreamId = (workflowRunId: string) => `workflow:${workflowRunId}`
const workflowErrorEventStreamId = (workflowRunId: string) => `workflow:${workflowRunId}:error`

// App-owned token strategy, not an SDK transport contract. The client only posts
// `{ hitlResponses }` to the run endpoint; this route authorizes run access, and
// the agent loop validates `requestId`/`toolCallId` before executing anything.
export const agentWorkflowHitlHookToken = (input: { readonly runId: string }) =>
  `agent-hitl:${input.runId}`

const writeSequencedWorkflowEvent = (input: {
  readonly writer: WritableStreamDefaultWriter<Uint8Array>
  readonly event: AgentEvent
  readonly workflowRunId: string
  readonly turn: number
  readonly eventSequence: Ref.Ref<number>
}) =>
  Effect.gen(function* () {
    const sequence = yield* Ref.get(input.eventSequence)
    const result = yield* writeDurableAgentEvent({
      writer: input.writer,
      event: input.event,
      streamId: workflowEventStreamId(input.workflowRunId),
      turn: input.turn,
      state: makeDurableAgentEventSequencerState(sequence)
    })

    yield* Ref.set(input.eventSequence, result.nextEventSequence)
  })

const closeWorkflowWriter = (writer: WritableStreamDefaultWriter<Uint8Array>) =>
  Effect.promise(() => writer.close())

const releaseWorkflowWriter = (writer: WritableStreamDefaultWriter<Uint8Array>) =>
  Effect.sync(() => writer.releaseLock())

const decodeMessages = (messages: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(AgentMessage))(messages)

const decodeNonEmptyMessages = (messages: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.NonEmptyArray(AgentMessage))(messages)

const encodeMessage = Schema.encodeUnknownEffect(AgentMessage)
const encodeToolCall = Schema.encodeUnknownEffect(ToolCall)
const encodeHitlRequest = Schema.encodeUnknownEffect(HitlRequest)
const encodeUsage = Schema.encodeUnknownEffect(AgentUsage)

const decodeUsageOrZero = (usage: unknown | undefined) =>
  usage === undefined
    ? Effect.succeed(zeroAgentUsage)
    : Schema.decodeUnknownEffect(AgentUsage)(usage)

const decodeHitlResponses = (responses: ReadonlyArray<unknown> | undefined) =>
  responses === undefined
    ? Effect.succeed<ReadonlyArray<HitlResponse>>([])
    : Schema.decodeUnknownEffect(Schema.Array(HitlResponse))(responses)

const decodeStepRequest = (state: SerializableWorkflowState) =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(AgentRouteRequest)(state.request)
    const messages = yield* state.messages === undefined
      ? Effect.succeed(request.messages)
      : decodeNonEmptyMessages(state.messages)

    return new AgentRouteRequest({ ...request, messages })
  })

const collectModelEvent = (input: {
  readonly event: AgentEvent
  readonly workflowRunId: string
  readonly writer: WritableStreamDefaultWriter<Uint8Array>
  readonly assistantMessage: Ref.Ref<AgentMessage | undefined>
  readonly toolCalls: Ref.Ref<ReadonlyArray<ToolCall>>
  readonly usage: Ref.Ref<AgentUsage>
  readonly reason: Ref.Ref<'stop' | 'tool_use'>
  readonly eventSequence: Ref.Ref<number>
  readonly turn: number
}) =>
  writeSequencedWorkflowEvent({
    writer: input.writer,
    event: input.event,
    workflowRunId: input.workflowRunId,
    turn: input.turn,
    eventSequence: input.eventSequence
  }).pipe(
    Effect.flatMap(() => {
      if (Schema.is(AssistantMessageEvent)(input.event)) {
        return Schema.decodeUnknownEffect(AssistantMessageEvent)(input.event).pipe(
          Effect.flatMap(event => Ref.set(input.assistantMessage, event.message))
        )
      }

      if (Schema.is(ToolInputEnd)(input.event)) {
        return Schema.decodeUnknownEffect(ToolInputEnd)(input.event).pipe(
          Effect.flatMap(event => Ref.update(input.toolCalls, calls => [...calls, event.call]))
        )
      }

      if (Schema.is(TurnEnd)(input.event)) {
        return Schema.decodeUnknownEffect(TurnEnd)(input.event).pipe(
          Effect.flatMap(event => Ref.set(input.reason, event.reason))
        )
      }

      if (Schema.is(UsageUpdate)(input.event)) {
        return Schema.decodeUnknownEffect(UsageUpdate)(input.event).pipe(
          Effect.flatMap(event =>
            Ref.update(input.usage, usage => addAgentUsage(usage, event.usage))
          )
        )
      }

      return Effect.void
    })
  )

const orderedToolResultMessages = (results: ReadonlyArray<IndexedToolResultMessage>) =>
  [...results].sort((left, right) => left.index - right.index).map(result => result.message)

const workflowAwaitingInput = (input: {
  readonly runId: string
  readonly event: AgentAwaitingInput
  readonly eventSequence: number
}) =>
  Effect.gen(function* () {
    const firstRequest = input.event.requests[0]

    if (firstRequest === undefined) {
      return yield* Effect.fail(
        new AgentWorkflowStepError({ message: 'Workflow HITL pause has no requests' })
      )
    }

    return {
      hookToken: agentWorkflowHitlHookToken({
        runId: input.runId
      }),
      requests: yield* Effect.forEach(input.event.requests, request => encodeHitlRequest(request)),
      messages: yield* Effect.forEach(input.event.messages, message => encodeMessage(message)),
      usage: yield* encodeUsage(input.event.usage),
      turns: input.event.turns,
      eventSequence: input.eventSequence
    }
  })

export async function runAgentWorkflowModelStep(input: {
  readonly context: unknown
  readonly state: SerializableWorkflowState
}): Promise<VercelAgentWorkflowModelStepResult> {
  'use step'

  const writable = getWritable<Uint8Array>()
  const writer = writable.getWriter()
  const workflowRunId = getWorkflowMetadata().workflowRunId

  return await Effect.runPromise(
    Effect.gen(function* () {
      const request = yield* decodeStepRequest(input.state)
      yield* validateAgentRouteImages(request)
      yield* validateAgentRouteDocuments(request)
      const createdMessages = yield* decodeMessages(input.state.createdMessages)
      const initialUsage = yield* decodeUsageOrZero(input.state.usage)
      const userId = yield* decodeWorkflowUserId(input.context)
      const runtime = yield* makeAgentTextRuntime(request, userId, '/agent/workflow')
      const assistantMessage = yield* Ref.make<AgentMessage | undefined>(undefined)
      const toolCalls = yield* Ref.make<ReadonlyArray<ToolCall>>([])
      const usage = yield* Ref.make(initialUsage)
      const reason = yield* Ref.make<'stop' | 'tool_use'>('stop')
      const eventSequence = yield* Ref.make(input.state.eventSequence ?? 0)

      yield* runModelTurn({
        messages: runtime.input.messages,
        systemPrompt: runtime.config.systemPrompt,
        tools: runtime.config.tools,
        reasoningEffort: runtime.input.reasoningEffort ?? runtime.config.reasoningEffort,
        capabilities: runtime.config.capabilities,
        model: runtime.config.model,
        turn: input.state.turn
      }).pipe(
        Stream.runForEach(event =>
          collectModelEvent({
            event,
            workflowRunId,
            writer,
            assistantMessage,
            toolCalls,
            usage,
            reason,
            eventSequence,
            turn: input.state.turn
          })
        ),
        Effect.provide(runtime.layer)
      )

      const currentAssistantMessage = yield* Ref.get(assistantMessage)
      const currentToolCalls = yield* Ref.get(toolCalls)
      const currentUsage = yield* Ref.get(usage)
      const currentReason = yield* Ref.get(reason)
      const nextCreatedMessages =
        currentAssistantMessage === undefined
          ? createdMessages
          : [...createdMessages, currentAssistantMessage]
      const nextMessages =
        currentAssistantMessage === undefined
          ? runtime.input.messages
          : [...runtime.input.messages, currentAssistantMessage]

      if (currentReason === 'stop') {
        yield* writeSequencedWorkflowEvent({
          writer,
          event: AgentEnd.make({
            messages: nextCreatedMessages,
            turns: input.state.turn,
            usage: currentUsage
          }),
          workflowRunId,
          turn: input.state.turn,
          eventSequence
        })
      }
      const nextEventSequence = yield* Ref.get(eventSequence)

      return {
        done: currentReason === 'stop',
        messages: yield* Effect.forEach(nextMessages, message => encodeMessage(message)),
        createdMessages: yield* Effect.forEach(nextCreatedMessages, message =>
          encodeMessage(message)
        ),
        toolCalls: yield* Effect.forEach(currentToolCalls, call => encodeToolCall(call)),
        usage: yield* encodeUsage(currentUsage),
        turn: input.state.turn,
        eventSequence: nextEventSequence
      }
    }).pipe(Effect.ensuring(releaseWorkflowWriter(writer)), Effect.provide(AppLayer), Effect.scoped)
  )
}

export async function runAgentWorkflowToolBatchStep(input: {
  readonly context: unknown
  readonly request: unknown
  readonly calls: ReadonlyArray<unknown>
  readonly createdMessages: ReadonlyArray<unknown>
  readonly hitlResponses?: ReadonlyArray<unknown>
  readonly usage?: unknown
  readonly turn?: number
  readonly eventSequence?: number
}): Promise<VercelAgentWorkflowToolBatchStepResult> {
  'use step'

  const writable = getWritable<Uint8Array>()
  const writer = writable.getWriter()
  const workflowRunId = getWorkflowMetadata().workflowRunId

  return await Effect.runPromise(
    Effect.gen(function* () {
      const request = yield* Schema.decodeUnknownEffect(AgentRouteRequest)(input.request)
      const calls = yield* Schema.decodeUnknownEffect(Schema.Array(ToolCall))(input.calls)
      const createdMessages = yield* decodeMessages(input.createdMessages)
      const hitlResponses = yield* decodeHitlResponses(input.hitlResponses)
      const usage = yield* decodeUsageOrZero(input.usage)
      const userId = yield* decodeWorkflowUserId(input.context)
      const runtime = yield* makeAgentTextRuntime(request, userId, '/agent/workflow')
      const toolResultMessages = yield* Ref.make<ReadonlyArray<IndexedToolResultMessage>>([])
      const cumulativeUsage = yield* Ref.make(usage)
      const awaitingInput = yield* Ref.make<AgentAwaitingInput | undefined>(undefined)
      const eventSequence = yield* Ref.make(input.eventSequence ?? 0)

      yield* runToolBatch({
        calls,
        tools: runtime.config.tools,
        hitlResponses,
        model: runtime.config.model,
        createdMessages,
        turn: input.turn,
        usage
      }).pipe(
        Stream.runForEach(event =>
          writeSequencedWorkflowEvent({
            writer,
            event,
            workflowRunId,
            turn: input.turn ?? 0,
            eventSequence
          }).pipe(
            Effect.flatMap(() => {
              if (Schema.is(AgentAwaitingInput)(event)) {
                return Schema.decodeUnknownEffect(AgentAwaitingInput)(event).pipe(
                  Effect.flatMap(decoded => Ref.set(awaitingInput, decoded))
                )
              }

              if (event._tag !== 'ToolExecutionCompleted') {
                return Effect.void
              }

              return Effect.gen(function* () {
                yield* Ref.update(cumulativeUsage, current =>
                  addWorkflowToolResultUsage(current, event.result)
                )
                yield* Ref.update(toolResultMessages, messages => {
                  const callIndex = calls.findIndex(call => call.id === event.result.toolCallId)

                  return [
                    ...messages,
                    {
                      index: callIndex < 0 ? calls.length : callIndex,
                      message: ToolResultMessage.make({
                        toolCallId: event.result.toolCallId,
                        content: event.result.content,
                        isError: event.result.isError,
                        structuredContent: event.result.structuredContent
                      })
                    }
                  ]
                })
              })
            })
          )
        ),
        Effect.provide(runtime.layer)
      )

      const messages = orderedToolResultMessages(yield* Ref.get(toolResultMessages))
      const nextCreatedMessages = [...createdMessages, ...messages]
      const currentAwaitingInput = yield* Ref.get(awaitingInput)
      const currentUsage = yield* Ref.get(cumulativeUsage)
      const nextEventSequence = yield* Ref.get(eventSequence)

      return {
        messages: yield* Effect.forEach(messages, message => encodeMessage(message)),
        createdMessages: yield* Effect.forEach(nextCreatedMessages, message =>
          encodeMessage(message)
        ),
        usage: yield* encodeUsage(currentUsage),
        awaitingInput:
          currentAwaitingInput === undefined
            ? undefined
            : yield* workflowAwaitingInput({
                runId: workflowRunId,
                event: currentAwaitingInput,
                eventSequence: nextEventSequence
              }),
        eventSequence: nextEventSequence
      }
    }).pipe(Effect.ensuring(releaseWorkflowWriter(writer)), Effect.provide(AppLayer), Effect.scoped)
  )
}

export async function closeAgentWorkflowStream() {
  'use step'

  const writable = getWritable<Uint8Array>()
  const writer = writable.getWriter()

  await Effect.runPromise(closeWorkflowWriter(writer).pipe(Effect.catch(() => Effect.void)))
}

export async function writeAgentWorkflowError(error: unknown) {
  'use step'

  const writable = getWritable<Uint8Array>()
  const writer = writable.getWriter()
  const workflowRunId = getWorkflowMetadata().workflowRunId

  await Effect.runPromise(
    writeDurableAgentEvent({
      writer,
      event: workflowErrorEvent(error),
      streamId: workflowErrorEventStreamId(workflowRunId),
      turn: 0,
      state: makeDurableAgentEventSequencerState()
    }).pipe(
      Effect.asVoid,
      Effect.tap(() => reportError(workflowStepError(error), { operation: 'agent.workflow.step' })),
      Effect.catch(() => Effect.void),
      Effect.ensuring(closeWorkflowWriter(writer))
    )
  )
}

const writeWorkflowErrorStep = (error: unknown) =>
  writeAgentWorkflowError(error).catch(() => undefined)

const decodeWorkflowUserId = (context: unknown) =>
  typeof context === 'string'
    ? Effect.succeed(context)
    : Effect.fail(new AgentWorkflowStepError({ message: 'Invalid workflow context' }))

export async function runAgentWorkflow(input: AgentWorkflowInput) {
  'use workflow'

  await runVercelAgentWorkflow({
    input: { request: input.request, context: input.userId },
    runModelStep: runAgentWorkflowModelStep,
    runToolBatchStep: runAgentWorkflowToolBatchStep,
    closeStream: closeAgentWorkflowStream,
    writeError: writeWorkflowErrorStep,
    awaitInput: async awaitingInput => {
      using hook = createHook<unknown>({ token: awaitingInput.hookToken })

      return await hook
    }
  })
}
