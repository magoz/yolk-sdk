import { getWritable } from 'workflow'
import { Data, Effect, Ref, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import {
  runVercelAgentWorkflow,
  type SerializableWorkflowState,
  type VercelAgentWorkflowModelStepResult,
  type VercelAgentWorkflowToolBatchStepResult
} from '@yolk/vercel-workflows-runtime'
import {
  addAgentUsage,
  AgentEnd,
  AgentError,
  AgentUsage,
  AssistantMessageEvent,
  AgentMessage,
  ToolCall,
  ToolInputEnd,
  ToolResultMessage,
  TurnEnd,
  UsageUpdate,
  zeroAgentUsage,
  AgentEvent
} from '@yolk/protocol'
import { runModelTurn, runToolBatch } from '@yolk/agent-loop'
import { AppLayer } from '@/lib/layers'
import { reportError } from '@/lib/services/telemetry/report-error'
import {
  AgentRouteRequest,
  encodeAgentNdjsonEvent,
  validateAgentRouteImages
} from '@/lib/agents/route-handler'
import { makeAgentTextRuntime } from './text-response'

export type AgentWorkflowInput = {
  readonly userId: string
  readonly request: unknown
}

type IndexedToolResultMessage = {
  readonly index: number
  readonly message: AgentMessage
}

class AgentWorkflowStepError extends Data.TaggedError('AgentWorkflowStepError')<{
  message: string
  cause?: unknown
}> {}

const writeEvent = (writer: WritableStreamDefaultWriter<Uint8Array>, event: AgentEvent) =>
  encodeAgentNdjsonEvent(event).pipe(Effect.flatMap(chunk => Effect.promise(() => writer.write(chunk))))

export const addWorkflowEventId = (event: AgentEvent, eventId: string) =>
  Schema.decodeUnknownEffect(AgentEvent)({ ...event, eventId })

const workflowEventId = (turn: number, eventSequence: number) =>
  `workflow:${turn}:${eventSequence}`

const writeSequencedWorkflowEvent = (input: {
  readonly writer: WritableStreamDefaultWriter<Uint8Array>
  readonly event: AgentEvent
  readonly turn: number
  readonly eventSequence: Ref.Ref<number>
}) =>
  Effect.gen(function* () {
    const sequence = yield* Ref.get(input.eventSequence)
    yield* Ref.set(input.eventSequence, sequence + 1)
    const event = yield* addWorkflowEventId(input.event, workflowEventId(input.turn, sequence))

    yield* writeEvent(input.writer, event)
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
const encodeUsage = Schema.encodeUnknownEffect(AgentUsage)

const decodeUsageOrZero = (usage: unknown | undefined) =>
  usage === undefined ? Effect.succeed(zeroAgentUsage) : Schema.decodeUnknownEffect(AgentUsage)(usage)

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
          Effect.flatMap(event => Ref.update(input.usage, usage => addAgentUsage(usage, event.usage)))
        )
      }

      return Effect.void
    })
  )

const workflowErrorEvent = (error: unknown) =>
  AgentError.make({
    code: 'unknown',
    message: error instanceof Error ? error.message : 'Workflow agent failed',
    retryable: false
  })

const workflowStepError = (error: unknown) =>
  new AgentWorkflowStepError({
    message: error instanceof Error ? error.message : 'Workflow agent failed',
    cause: error
  })

const orderedToolResultMessages = (results: ReadonlyArray<IndexedToolResultMessage>) =>
  [...results].sort((left, right) => left.index - right.index).map(result => result.message)

export async function runAgentWorkflowModelStep(input: {
  readonly context: unknown
  readonly state: SerializableWorkflowState
}): Promise<VercelAgentWorkflowModelStepResult> {
  'use step'

  const writable = getWritable<Uint8Array>()
  const writer = writable.getWriter()

  return await Effect.runPromise(
    Effect.gen(function* () {
      const request = yield* decodeStepRequest(input.state)
      yield* validateAgentRouteImages(request)
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
      const nextCreatedMessages = currentAssistantMessage === undefined
        ? createdMessages
        : [...createdMessages, currentAssistantMessage]
      const nextMessages = currentAssistantMessage === undefined
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
          turn: input.state.turn,
          eventSequence
        })
      }
      const nextEventSequence = yield* Ref.get(eventSequence)

      return {
        done: currentReason === 'stop',
        messages: yield* Effect.forEach(nextMessages, message => encodeMessage(message)),
        createdMessages: yield* Effect.forEach(nextCreatedMessages, message => encodeMessage(message)),
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
  readonly turn?: number
  readonly eventSequence?: number
}): Promise<VercelAgentWorkflowToolBatchStepResult> {
  'use step'

  const writable = getWritable<Uint8Array>()
  const writer = writable.getWriter()

  return await Effect.runPromise(
    Effect.gen(function* () {
      const request = yield* Schema.decodeUnknownEffect(AgentRouteRequest)(input.request)
      const calls = yield* Schema.decodeUnknownEffect(Schema.Array(ToolCall))(input.calls)
      const createdMessages = yield* decodeMessages(input.createdMessages)
      const userId = yield* decodeWorkflowUserId(input.context)
      const runtime = yield* makeAgentTextRuntime(request, userId, '/agent/workflow')
      const toolResultMessages = yield* Ref.make<ReadonlyArray<IndexedToolResultMessage>>([])
      const eventSequence = yield* Ref.make(input.eventSequence ?? 0)

      yield* runToolBatch({ calls }).pipe(
        Stream.runForEach(event =>
          writeSequencedWorkflowEvent({
            writer,
            event,
            turn: input.turn ?? 0,
            eventSequence
          }).pipe(
            Effect.flatMap(() => {
              if (event._tag !== 'ToolExecutionCompleted') {
                return Effect.void
              }

              return Ref.update(toolResultMessages, messages => {
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
          )
        ),
        Effect.provide(runtime.layer)
      )

      const messages = orderedToolResultMessages(yield* Ref.get(toolResultMessages))
      const nextCreatedMessages = [...createdMessages, ...messages]
      const nextEventSequence = yield* Ref.get(eventSequence)

      return {
        messages: yield* Effect.forEach(messages, message => encodeMessage(message)),
        createdMessages: yield* Effect.forEach(nextCreatedMessages, message => encodeMessage(message)),
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

  await Effect.runPromise(
    writeEvent(writer, workflowErrorEvent(error)).pipe(
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
    writeError: writeWorkflowErrorStep
  })
}
