import { getWritable } from 'workflow'
import { Data, Effect, Ref, Stream } from 'effect'
import * as Schema from 'effect/Schema'
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
  type AgentEvent
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

type AgentWorkflowState = {
  readonly request: unknown
  readonly messages?: ReadonlyArray<unknown>
  readonly createdMessages: ReadonlyArray<unknown>
  readonly usage?: unknown
  readonly turn: number
}

type AgentWorkflowModelStepResult = {
  readonly done: boolean
  readonly reason: 'stop' | 'tool_use'
  readonly messages: ReadonlyArray<unknown>
  readonly createdMessages: ReadonlyArray<unknown>
  readonly toolCalls: ReadonlyArray<unknown>
  readonly usage: unknown
  readonly turn: number
}

type AgentWorkflowToolBatchStepResult = {
  readonly messages: ReadonlyArray<unknown>
  readonly createdMessages: ReadonlyArray<unknown>
}

const maxWorkflowTurns = 500

class AgentWorkflowStepError extends Data.TaggedError('AgentWorkflowStepError')<{
  message: string
  cause?: unknown
}> {}

const writeEvent = (writer: WritableStreamDefaultWriter<Uint8Array>, event: AgentEvent) =>
  encodeAgentNdjsonEvent(event).pipe(Effect.flatMap(chunk => Effect.promise(() => writer.write(chunk))))

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

const decodeStepRequest = (state: AgentWorkflowState) =>
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
}) =>
  writeEvent(input.writer, input.event).pipe(
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

export async function runAgentWorkflowModelStep(input: {
  readonly userId: string
  readonly state: AgentWorkflowState
}): Promise<AgentWorkflowModelStepResult> {
  'use step'

  const writable = getWritable<Uint8Array>()
  const writer = writable.getWriter()

  return await Effect.runPromise(
    Effect.gen(function* () {
      const request = yield* decodeStepRequest(input.state)
      yield* validateAgentRouteImages(request)
      const createdMessages = yield* decodeMessages(input.state.createdMessages)
      const initialUsage = yield* decodeUsageOrZero(input.state.usage)
      const runtime = yield* makeAgentTextRuntime(request, input.userId, '/agent/workflow')
      const assistantMessage = yield* Ref.make<AgentMessage | undefined>(undefined)
      const toolCalls = yield* Ref.make<ReadonlyArray<ToolCall>>([])
      const usage = yield* Ref.make(initialUsage)
      const reason = yield* Ref.make<'stop' | 'tool_use'>('stop')

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
          collectModelEvent({ event, writer, assistantMessage, toolCalls, usage, reason })
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
        yield* writeEvent(
          writer,
          AgentEnd.make({
            messages: nextCreatedMessages,
            turns: input.state.turn,
            usage: currentUsage
          })
        )
      }

      return {
        done: currentReason === 'stop',
        reason: currentReason,
        messages: yield* Effect.forEach(nextMessages, message => encodeMessage(message)),
        createdMessages: yield* Effect.forEach(nextCreatedMessages, message => encodeMessage(message)),
        toolCalls: yield* Effect.forEach(currentToolCalls, call => encodeToolCall(call)),
        usage: yield* encodeUsage(currentUsage),
        turn: input.state.turn
      }
    }).pipe(Effect.ensuring(releaseWorkflowWriter(writer)), Effect.provide(AppLayer), Effect.scoped)
  )
}

export async function runAgentWorkflowToolBatchStep(input: {
  readonly userId: string
  readonly request: unknown
  readonly calls: ReadonlyArray<unknown>
  readonly createdMessages: ReadonlyArray<unknown>
}): Promise<AgentWorkflowToolBatchStepResult> {
  'use step'

  const writable = getWritable<Uint8Array>()
  const writer = writable.getWriter()

  return await Effect.runPromise(
    Effect.gen(function* () {
      const request = yield* Schema.decodeUnknownEffect(AgentRouteRequest)(input.request)
      const calls = yield* Schema.decodeUnknownEffect(Schema.Array(ToolCall))(input.calls)
      const createdMessages = yield* decodeMessages(input.createdMessages)
      const runtime = yield* makeAgentTextRuntime(request, input.userId, '/agent/workflow')
      const toolResultMessages = yield* Ref.make<ReadonlyArray<AgentMessage>>([])

      yield* runToolBatch({ calls }).pipe(
        Stream.runForEach(event =>
          writeEvent(writer, event).pipe(
            Effect.flatMap(() => {
              if (event._tag !== 'ToolExecutionCompleted') {
                return Effect.void
              }

              return Ref.update(toolResultMessages, messages => [
                ...messages,
                ToolResultMessage.make({
                  toolCallId: event.result.toolCallId,
                  content: event.result.content,
                  isError: event.result.isError,
                  structuredContent: event.result.structuredContent
                })
              ])
            })
          )
        ),
        Effect.provide(runtime.layer)
      )

      const messages = yield* Ref.get(toolResultMessages)
      const nextCreatedMessages = [...createdMessages, ...messages]

      return {
        messages: yield* Effect.forEach(messages, message => encodeMessage(message)),
        createdMessages: yield* Effect.forEach(nextCreatedMessages, message => encodeMessage(message))
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

type WorkflowStepResult<A> =
  | {
      readonly _tag: 'Success'
      readonly value: A
    }
  | {
      readonly _tag: 'Failure'
      readonly error: unknown
    }

const settleWorkflowStep = <A>(promise: Promise<A>): Promise<WorkflowStepResult<A>> =>
  promise.then(
    value => ({ _tag: 'Success', value }),
    error => ({ _tag: 'Failure', error })
  )

export async function runAgentWorkflow(input: AgentWorkflowInput) {
  'use workflow'

  let state: AgentWorkflowState = {
    request: input.request,
    createdMessages: [],
    turn: 1
  }

  for (let step = 0; step < maxWorkflowTurns; step++) {
    const modelResult = await settleWorkflowStep(
      runAgentWorkflowModelStep({ userId: input.userId, state })
    )

    if (modelResult._tag === 'Failure') {
      await writeWorkflowErrorStep(modelResult.error)
      return
    }

    if (modelResult.value.done) {
      const closeResult = await settleWorkflowStep(closeAgentWorkflowStream())

      if (closeResult._tag === 'Failure') {
        await writeWorkflowErrorStep(closeResult.error)
      }

      return
    }

    const toolsResult = await settleWorkflowStep(
      runAgentWorkflowToolBatchStep({
        userId: input.userId,
        request: input.request,
        calls: modelResult.value.toolCalls,
        createdMessages: modelResult.value.createdMessages
      })
    )

    if (toolsResult._tag === 'Failure') {
      await writeWorkflowErrorStep(toolsResult.error)
      return
    }

    state = {
      request: input.request,
      messages: [...modelResult.value.messages, ...toolsResult.value.messages],
      createdMessages: toolsResult.value.createdMessages,
      usage: modelResult.value.usage,
      turn: modelResult.value.turn + 1
    }
  }

  await writeWorkflowErrorStep(new Error('Workflow agent exceeded max turns'))
}
