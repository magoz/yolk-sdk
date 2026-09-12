import { getWorkflowMetadata, getWritable } from 'workflow'
import { Cause, Clock, Effect, Layer, Predicate, Ref, Result, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import {
  makeDurableAgentEventSequencerState,
  writeDurableAgentEvent,
  type SerializableWorkflowState,
  type VercelAgentWorkflowModelStepResult,
  type VercelAgentWorkflowToolBatchStepInput,
  type VercelAgentWorkflowToolBatchStepResult
} from '@yolk-sdk/vercel-workflows'

import {
  addAgentUsage,
  AgentEnd,
  AgentError,
  AgentUsage,
  AgentMessage,
  AgentAwaitingInput,
  ToolCall,
  ToolResult,
  HitlRequest,
  HitlResponse,
  ToolResultMessage,
  toolResultMessageFromResult,
  ToolExecutionStarted,
  SubagentStarted,
  SubagentCompleted,
  makeSubagentRunId,
  type AgentEvent,
  zeroAgentUsage
} from '@yolk-sdk/agent/protocol'

import {
  AbortError,
  collectModelTurn,
  decorateLLMProvider,
  LLMError,
  prepareToolBatch,
  runModelTurn,
  runToolBatch,
  ToolError,
  ToolExecutor
} from '@yolk-sdk/agent/loop'

import { AppLayer } from '@/lib/layers'

import { reportError } from '@/lib/services/telemetry/report-error'

import {
  AgentRouteRequest,
  validateAgentRouteDocuments,
  validateAgentRouteImages
} from '@/lib/agents/route-handler'

import { AgentWorkflowStore } from '@/lib/services/agent-workflow/live-layer'

import { addWorkflowToolResultUsage } from './workflow-tool-usage'

import { AgentWorkflowStepError, workflowErrorEvent, workflowStepError } from './workflow-error'
import { assertChildAdmission, workflowRuntime, WorkflowAgentContext } from './child-control'
import { agentWorkflowHitlHookToken } from './workflow-contract'

type IndexedToolResultMessage = {
  readonly index: number
  readonly message: ToolResultMessage
}

const workflowEventStreamId = (workflowRunId: string) => `workflow:${workflowRunId}`

const workflowErrorEventStreamId = (workflowRunId: string) => `workflow:${workflowRunId}:error`

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

const encodeAgentError = Schema.encodeUnknownEffect(AgentError)

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
      const context = yield* Schema.decodeUnknownEffect(WorkflowAgentContext)(input.context)
      yield* assertChildAdmission(context, getWorkflowMetadata().workflowRunId)
      const runtime = yield* workflowRuntime(request, context)
      const store = yield* AgentWorkflowStore
      const eventSequence = yield* Ref.make(input.state.eventSequence ?? 0)

      // Stream construction can happen eagerly during retry setup. Admission belongs at
      // subscription, after the retry delay, before every provider attempt's effects.
      const {
        assistantMessage: currentAssistantMessage,
        toolCalls: currentToolCalls,
        usage: currentUsage,
        stopReason
      } = yield* collectModelTurn(
        runModelTurn({
          messages: runtime.input.messages,
          systemPrompt: runtime.config.systemPrompt,
          tools: runtime.config.tools,
          reasoningEffort: runtime.input.reasoningEffort ?? runtime.config.reasoningEffort,
          capabilities: runtime.config.capabilities,
          model: runtime.config.model,
          turn: input.state.turn
        }),
        {
          initialUsage,
          onEvent: event =>
            writeSequencedWorkflowEvent({
              writer,
              event,
              workflowRunId,
              turn: input.state.turn,
              eventSequence
            })
        }
      ).pipe(
        Effect.provide(
          decorateLLMProvider(provider => ({
            stream: request =>
              Stream.unwrap(
                assertChildAdmission(context, workflowRunId).pipe(
                  Effect.mapError(error =>
                    Predicate.isTagged(error, 'WorkflowRegistryError') ||
                    Predicate.isTagged(error, 'WorkflowRunForbidden')
                      ? new AbortError({ reason: 'user' })
                      : new LLMError({
                          cause: 'provider_error',
                          message: 'Workflow admission unavailable',
                          retryable: false
                        })
                  ),
                  Effect.map(() => provider.stream(request)),
                  Effect.provideService(AgentWorkflowStore, store)
                )
              )
          })).pipe(Layer.provideMerge(runtime.layer))
        )
      )

      const needsContinuation = stopReason === 'tool_use'

      const nextCreatedMessages =
        currentAssistantMessage === undefined
          ? createdMessages
          : [...createdMessages, currentAssistantMessage]

      const nextMessages =
        currentAssistantMessage === undefined
          ? runtime.input.messages
          : [...runtime.input.messages, currentAssistantMessage]

      if (!needsContinuation) {
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
        done: !needsContinuation,
        messages: yield* Effect.forEach(nextMessages, message => encodeMessage(message)),
        createdMessages: yield* Effect.forEach(nextCreatedMessages, message =>
          encodeMessage(message)
        ),
        toolCalls: yield* Effect.forEach(currentToolCalls, call => encodeToolCall(call)),
        usage: yield* encodeUsage(currentUsage),
        turn: input.state.turn,
        eventSequence: nextEventSequence
      }
    }).pipe(
      Effect.ensuring(releaseWorkflowWriter(writer)),
      Effect.provide(AgentWorkflowStore.layer),
      Effect.provide(AppLayer),
      Effect.scoped
    )
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
  readonly preflightOnly?: boolean
  readonly result?: unknown
  readonly eventNamespace?: string
  readonly executionStartedAtMs?: number
}): Promise<
  VercelAgentWorkflowToolBatchStepResult & { readonly executableIds?: ReadonlyArray<string> }
> {
  const writable = getWritable<Uint8Array>()
  const writer = writable.getWriter()
  const workflowRunId = getWorkflowMetadata().workflowRunId

  const eventRunId =
    input.eventNamespace === undefined
      ? workflowRunId
      : `${workflowRunId}:tool:${input.eventNamespace}`

  let latestUsage = zeroAgentUsage
  let latestEventSequence = input.eventSequence
  let latestToolResultMessages: ReadonlyArray<ToolResultMessage> = []

  const result = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const request = yield* Schema.decodeUnknownEffect(AgentRouteRequest)(input.request)
      const calls = yield* Schema.decodeUnknownEffect(Schema.Array(ToolCall))(input.calls)
      const createdMessages = yield* decodeMessages(input.createdMessages)
      const hitlResponses = yield* decodeHitlResponses(input.hitlResponses)
      const usage = yield* decodeUsageOrZero(input.usage)
      latestUsage = usage
      const context = yield* Schema.decodeUnknownEffect(WorkflowAgentContext)(input.context)
      yield* assertChildAdmission(context, getWorkflowMetadata().workflowRunId)
      const runtime = yield* workflowRuntime(request, context)

      const prepared = yield* prepareToolBatch({
        calls,
        tools: runtime.config.tools,
        responses: hitlResponses
      })

      if (input.preflightOnly === true && prepared.pendingRequests.length === 0) {
        return {
          messages: [],
          createdMessages: input.createdMessages,
          usage: input.usage,
          eventSequence: input.eventSequence,
          executableIds: prepared.callsToExecute.map(item => item.call.id)
        }
      }

      const suppliedResult =
        input.result === undefined
          ? undefined
          : yield* Schema.decodeUnknownEffect(ToolResult)(input.result)

      const toolResultMessages = yield* Ref.make<ReadonlyArray<IndexedToolResultMessage>>([])
      const cumulativeUsage = yield* Ref.make(usage)
      const awaitingInput = yield* Ref.make<AgentAwaitingInput | undefined>(undefined)
      const eventSequence = yield* Ref.make(input.eventSequence ?? 0)

      const toolStream = runToolBatch({
        calls,
        tools: runtime.config.tools,
        hitlResponses,
        model: runtime.config.model,
        createdMessages,
        turn: input.turn,
        usage
      })

      const executor = yield* ToolExecutor.pipe(Effect.provide(runtime.layer))
      const store = yield* AgentWorkflowStore
      yield* toolStream.pipe(
        Stream.provideService(ToolExecutor, {
          execute: call =>
            assertChildAdmission(context, workflowRunId).pipe(
              Effect.provideService(AgentWorkflowStore, store),
              Effect.mapError(
                () =>
                  new ToolError({
                    tool: call.name,
                    cause: 'execution',
                    message: 'Workflow execution is stopped or unavailable'
                  })
              ),
              Effect.flatMap(() =>
                suppliedResult === undefined
                  ? executor.execute(call)
                  : Effect.succeed(suppliedResult)
              )
            )
        }),
        Stream.filter(
          event =>
            input.executionStartedAtMs === undefined ||
            (!Predicate.isTagged(event, 'ToolExecutionStarted') &&
              !Predicate.isTagged(event, 'SubagentStarted'))
        ),
        Stream.map(event =>
          Predicate.isTagged(event, 'SubagentCompleted') && input.executionStartedAtMs !== undefined
            ? SubagentCompleted.make({
                ...event,
                durationMs: Math.max(
                  0,
                  (event.createdAtMs ?? input.executionStartedAtMs) - input.executionStartedAtMs
                )
              })
            : event
        ),
        Stream.runForEach(event =>
          writeSequencedWorkflowEvent({
            writer,
            event,
            workflowRunId: eventRunId,
            turn: input.turn ?? 0,
            eventSequence
          }).pipe(
            Effect.tap(() =>
              Ref.get(eventSequence).pipe(
                Effect.tap(sequence =>
                  Effect.sync(() => {
                    latestEventSequence = sequence
                  })
                )
              )
            ),
            Effect.flatMap(() => {
              if (Schema.is(AgentAwaitingInput)(event)) {
                return Schema.decodeUnknownEffect(AgentAwaitingInput)(event).pipe(
                  Effect.flatMap(decoded => Ref.set(awaitingInput, decoded))
                )
              }

              if (
                !Predicate.isTagged(event, 'ToolExecutionCompleted') &&
                !Predicate.isTagged(event, 'ToolExecutionAccepted')
              ) {
                return Effect.void
              }

              return Effect.gen(function* () {
                if (Predicate.isTagged(event, 'ToolExecutionCompleted')) {
                  yield* Ref.update(cumulativeUsage, current =>
                    addWorkflowToolResultUsage(current, event.result)
                  )
                }

                latestUsage = yield* Ref.get(cumulativeUsage)
                yield* Ref.update(toolResultMessages, messages => {
                  const callIndex = calls.findIndex(call => call.id === event.result.toolCallId)

                  const nextMessages = [
                    ...messages,
                    {
                      index: callIndex < 0 ? calls.length : callIndex,
                      message: toolResultMessageFromResult(event.result)
                    }
                  ]

                  latestToolResultMessages = orderedToolResultMessages(nextMessages)

                  return nextMessages
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
    }).pipe(
      Effect.ensuring(releaseWorkflowWriter(writer)),
      Effect.provide(AgentWorkflowStore.layer),
      Effect.provide(AppLayer),
      Effect.scoped
    )
  )

  if (Predicate.isTagged(result, 'Success')) {
    return result.value
  }

  if (Cause.hasDies(result.cause) || Cause.hasInterrupts(result.cause)) {
    return await Effect.runPromise(Effect.failCause(result.cause))
  }

  const expectedFailure = Cause.findFail(result.cause)

  if (Result.isFailure(expectedFailure)) {
    return await Effect.runPromise(Effect.failCause(result.cause))
  }

  const failureMessages = await Effect.runPromise(
    Effect.forEach(latestToolResultMessages, message => encodeMessage(message))
  )

  return {
    messages: failureMessages,
    createdMessages: [...input.createdMessages, ...failureMessages],
    usage: await Effect.runPromise(encodeUsage(latestUsage)),
    eventSequence: latestEventSequence,
    failure: await Effect.runPromise(
      encodeAgentError(workflowErrorEvent(expectedFailure.success.error))
    )
  }
}

export async function closeAgentWorkflowStream() {
  const writable = getWritable<Uint8Array>()
  const writer = writable.getWriter()

  await Effect.runPromise(closeWorkflowWriter(writer).pipe(Effect.catch(() => Effect.void)))
}

export async function writeAgentWorkflowError(error: unknown) {
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

export async function mergeWorkflowToolResultsStep(
  input: VercelAgentWorkflowToolBatchStepInput,
  results: ReadonlyArray<VercelAgentWorkflowToolBatchStepResult>,
  executionFailure?: unknown
) {
  return await Effect.runPromise(
    Effect.gen(function* () {
      let usage = yield* decodeUsageOrZero(input.usage)

      for (const result of results)
        usage = addAgentUsage(usage, yield* decodeUsageOrZero(result.usage))
      const messages = results.flatMap(result => result.messages)
      const calls = yield* Schema.decodeUnknownEffect(Schema.Array(ToolCall))(input.calls)
      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(ToolResultMessage))(messages)

      const complete =
        decoded.length === calls.length &&
        decoded.every((message, index) => message.toolCallId === calls[index]?.id) &&
        results.every(result => result.awaitingInput === undefined)

      const failure =
        (executionFailure === undefined
          ? undefined
          : yield* encodeAgentError(workflowErrorEvent(executionFailure))) ??
        results.find(result => result.failure !== undefined)?.failure ??
        (complete
          ? undefined
          : yield* encodeAgentError(
              AgentError.make({
                code: 'tool_error',
                message: 'Workflow tool batch did not produce one ordered result per call',
                retryable: false
              })
            ))

      return {
        messages,
        createdMessages: [...input.createdMessages, ...messages],
        usage: yield* encodeUsage(usage),
        eventSequence: input.eventSequence,
        ...(failure === undefined ? {} : { failure })
      }
    })
  )
}

export async function startWorkflowChildToolStep(input: {
  readonly context: unknown
  readonly request: unknown
  readonly call: unknown
  readonly turn?: number
  readonly eventNamespace: string
  readonly childModel: string | null
}) {
  const workflowRunId = getWorkflowMetadata().workflowRunId
  const writer = getWritable<Uint8Array>().getWriter()

  return await Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Schema.decodeUnknownEffect(WorkflowAgentContext)(input.context)
      yield* assertChildAdmission(context, workflowRunId)
      const call = yield* Schema.decodeUnknownEffect(ToolCall)(input.call)
      const startedAtMs = yield* Clock.currentTimeMillis
      const events: AgentEvent[] = [ToolExecutionStarted.make({ call, createdAtMs: startedAtMs })]

      if (call.name === 'subagent' && input.childModel !== null) {
        const params = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ subagent_type: Schema.String, description: Schema.String })
        )(call.params)

        events.push(
          SubagentStarted.make({
            parentToolCallId: call.id,
            subagentRunId: makeSubagentRunId(call.id),
            subagentType: params.subagent_type,
            description: params.description,
            model: input.childModel,
            createdAtMs: startedAtMs
          })
        )
      }

      const eventSequence = yield* Ref.make(0)

      for (const event of events)
        yield* writeSequencedWorkflowEvent({
          writer,
          event,
          workflowRunId: `${workflowRunId}:tool:${input.eventNamespace}`,
          turn: input.turn ?? 0,
          eventSequence
        })

      return { startedAtMs, eventSequence: yield* Ref.get(eventSequence) }
    }).pipe(
      Effect.ensuring(releaseWorkflowWriter(writer)),
      Effect.provide(AgentWorkflowStore.layer)
    )
  )
}

export async function executableWorkflowCallStep(call: unknown, ids: ReadonlyArray<string>) {
  return await Effect.runPromise(
    Schema.decodeUnknownEffect(ToolCall)(call).pipe(
      Effect.map(call => (ids.includes(call.id) ? call.id : null))
    )
  )
}
