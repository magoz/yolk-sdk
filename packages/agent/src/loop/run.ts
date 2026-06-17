import { Clock, Effect, Ref, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import {
  AgentAwaitingInput,
  AgentEnd,
  AgentRetry,
  AgentStart,
  AssistantMessageEvent,
  UsageUpdate,
  addAgentUsage,
  contentParts,
  contentPreview,
  LLMReasoningDelta as AgentLLMReasoningDelta,
  LLMStreamEnd,
  LLMStreamStart,
  LLMTextDelta as AgentLLMTextDelta,
  ToolExecutionCompleted,
  ToolExecutionError,
  ToolExecutionStarted,
  ToolApprovalRequested,
  ToolInputEnd,
  ToolInputDelta,
  ToolInputStart,
  QuestionRequested,
  ProviderToolResult,
  QuestionRequest,
  QuestionToolParams,
  formatQuestionResponseContent,
  hitlResponseEvent,
  questionResponseStructuredContent,
  makeSubagentRunId,
  ToolApprovalRequest,
  ToolResultMessage,
  SubagentCompleted,
  SubagentStarted,
  assistantHostToolCalls,
  type ToolCall,
  type AgentReasoningEffort,
  type HitlRequest,
  type HitlResponse,
  type QuestionPrompt,
  type QuestionResponse,
  type ToolApprovalResponse,
  ToolResult,
  TurnEnd,
  TurnStart,
  zeroAgentUsage,
  type AgentEvent,
  type AgentErrorCode,
  type AgentMessage,
  type AgentUsage,
  type AgentModelCapabilities,
  type ToolDef
} from '@yolk-sdk/agent/protocol'
import { accumulateAssistantMessage, collectToolCalls } from './accumulator.ts'
import {
  AbortError,
  LLMError,
  ToolError,
  type AgentLoopError,
  type LLMProviderError
} from './error.ts'
import type { LLMEvent } from './llm-event.ts'
import { ContextTransformer, type ContextTransformResult } from './services/context-transformer.ts'
import { LLMProvider, type LLMRequest } from './services/llm-provider.ts'
import { LoopConfig, type LoopConfigShape } from './services/loop-config.ts'
import { ToolExecutor } from './services/tool-executor.ts'

export type AgentLoopRunId = string

export type RunConfig = {
  readonly messages: ReadonlyArray<AgentMessage>
  readonly systemPrompt: string
  readonly tools: ReadonlyArray<ToolDef>
  readonly hitlResponses?: ReadonlyArray<HitlResponse>
  readonly model: string
  readonly reasoningEffort?: AgentReasoningEffort
  readonly capabilities?: AgentModelCapabilities
}

export type ModelTurnConfig = RunConfig & {
  readonly turn: number
}

export type ToolBatchConfig = {
  readonly calls: ReadonlyArray<ToolCall>
  readonly tools?: ReadonlyArray<ToolDef>
  readonly hitlResponses?: ReadonlyArray<HitlResponse>
  readonly model?: string
  readonly createdMessages?: ReadonlyArray<AgentMessage>
  readonly turn?: number
  readonly usage?: AgentUsage
}

const questionToolName = 'question'

type TaskCallMetadata = {
  readonly subagentRunId: string
  readonly subagentType: string
  readonly description: string
}

const objectField = (input: unknown, key: string) =>
  input !== null && typeof input === 'object'
    ? Object.getOwnPropertyDescriptor(input, key)?.value
    : undefined

const nonEmptyStringField = (input: unknown, key: string) => {
  const value = objectField(input, key)

  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

const taskCallMetadata = (call: ToolCall): TaskCallMetadata | undefined => {
  if (call.name !== 'task') {
    return undefined
  }

  const subagentType = nonEmptyStringField(call.params, 'subagent_type')
  const description = nonEmptyStringField(call.params, 'description')

  if (subagentType === undefined || description === undefined) {
    return undefined
  }

  return {
    subagentRunId: makeSubagentRunId(call.id),
    subagentType,
    description
  }
}

const subagentStartedEvent = (input: {
  readonly call: ToolCall
  readonly model: string
  readonly startedAtMs: number
}) => {
  const metadata = taskCallMetadata(input.call)

  return metadata === undefined
    ? undefined
    : SubagentStarted.make({
        parentToolCallId: input.call.id,
        subagentRunId: metadata.subagentRunId,
        subagentType: metadata.subagentType,
        description: metadata.description,
        model: input.model,
        createdAtMs: input.startedAtMs
      })
}

const subagentCompletedEvent = (input: {
  readonly call: ToolCall
  readonly result: ToolResult
  readonly model: string
  readonly startedAtMs: number
  readonly endedAtMs: number
}) => {
  const metadata = taskCallMetadata(input.call)

  return metadata === undefined
    ? undefined
    : SubagentCompleted.make({
        parentToolCallId: input.call.id,
        subagentRunId: metadata.subagentRunId,
        subagentType: metadata.subagentType,
        description: metadata.description,
        model: input.model,
        status: input.result.isError === true ? 'error' : 'completed',
        durationMs: Math.max(0, input.endedAtMs - input.startedAtMs),
        summary: contentPreview(input.result.content),
        createdAtMs: input.endedAtMs
      })
}

const toolCompletionEvents = (input: {
  readonly call: ToolCall
  readonly result: ToolResult
  readonly model: string
  readonly startedAtMs: number
  readonly endedAtMs: number
}): ReadonlyArray<AgentEvent> => {
  const completed = subagentCompletedEvent(input)
  const toolCompleted = ToolExecutionCompleted.make({
    call: input.call,
    result: input.result,
    createdAtMs: input.endedAtMs
  })

  return completed === undefined ? [toolCompleted] : [toolCompleted, completed]
}

const toolErrorResult = (call: ToolCall, error: ToolError) =>
  ToolResult.make({
    toolCallId: call.id,
    content: error.message,
    isError: true
  })

const toolErrorEvents = (input: {
  readonly call: ToolCall
  readonly error: ToolError
  readonly model: string
  readonly startedAtMs: number
  readonly endedAtMs: number
}): ReadonlyArray<AgentEvent> => [
  ToolExecutionError.make({
    call: input.call,
    message: input.error.message,
    code: toolErrorCode(input.error),
    createdAtMs: input.endedAtMs
  }),
  ...toolCompletionEvents({
    call: input.call,
    result: toolErrorResult(input.call, input.error),
    model: input.model,
    startedAtMs: input.startedAtMs,
    endedAtMs: input.endedAtMs
  })
]

const unsupportedInputError = (message: string) =>
  new LLMError({
    cause: 'validation_error',
    message,
    retryable: false
  })

const validateContent = (message: AgentMessage, capabilities: AgentModelCapabilities) =>
  Effect.forEach(contentPartsFromMessage(message), part => {
    switch (part._tag) {
      case 'Text':
        return capabilities.input.text
          ? Effect.void
          : Effect.fail(unsupportedInputError('Text input is not supported by this model'))
      case 'Image':
        return capabilities.input.image
          ? Effect.void
          : Effect.fail(unsupportedInputError('Image input is not supported by this model'))
      case 'Document':
        return capabilities.input.document
          ? Effect.void
          : Effect.fail(unsupportedInputError('Document input is not supported by this model'))
      case 'Audio':
        return capabilities.input.audio
          ? Effect.void
          : Effect.fail(unsupportedInputError('Audio input is not supported by this model'))
    }
  })

const contentPartsFromMessage = (message: AgentMessage) => {
  switch (message._tag) {
    case 'User':
    case 'ToolResult':
      return contentParts(message.content)
    case 'Assistant':
      return message.parts.flatMap(part => (part._tag === 'Text' ? contentParts(part.content) : []))
  }
}

const validateCapabilities = (
  config: RunConfig,
  messages: ReadonlyArray<AgentMessage>
): Effect.Effect<void, LLMError> => {
  const capabilities = config.capabilities

  if (capabilities === undefined) {
    return Effect.void
  }

  if (!capabilities.tools && config.tools.length > 0) {
    return Effect.fail(unsupportedInputError('Tools are not supported by this model'))
  }

  if (!capabilities.reasoning && config.reasoningEffort !== undefined) {
    return Effect.fail(unsupportedInputError('Reasoning effort is not supported by this model'))
  }

  return Effect.forEach(messages, message => validateContent(message, capabilities)).pipe(
    Effect.asVoid
  )
}

const toLlmEvent = (event: LLMEvent): ReadonlyArray<AgentEvent> => {
  switch (event._tag) {
    case 'TextDelta':
      return [AgentLLMTextDelta.make({ text: event.text })]
    case 'ReasoningDelta':
      return [AgentLLMReasoningDelta.make({ text: event.text })]
    case 'ToolCall':
      return [ToolInputEnd.make({ call: event.call })]
    case 'ToolInputStart':
      return [ToolInputStart.make({ id: event.id, name: event.name })]
    case 'ToolInputDelta':
      return [ToolInputDelta.make({ id: event.id, delta: event.delta })]
    case 'ProviderToolResult':
      return [ProviderToolResult.make({ call: event.call, result: event.result })]
    case 'Usage':
      return [UsageUpdate.make({ usage: event.usage })]
    case 'Done':
      return []
  }
}

const isLlmEvent = (event: LLMEvent | AgentEvent | AgentRetry): event is LLMEvent => {
  switch (event._tag) {
    case 'TextDelta':
    case 'ReasoningDelta':
    case 'Done':
    case 'ToolCall':
    case 'ToolInputStart':
    case 'ToolInputDelta':
    case 'ProviderToolResult':
    case 'Usage':
      return true
    default:
      return false
  }
}

type TurnStreamInput = {
  readonly config: RunConfig
  readonly contextTransformer: {
    readonly transform: (
      messages: ReadonlyArray<AgentMessage>
    ) => Effect.Effect<ContextTransformResult, AgentLoopError>
  }
  readonly loopConfig: LoopConfigShape
  readonly provider: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMProviderError>
  }
  readonly executor: {
    readonly execute: (call: ToolCall) => Effect.Effect<ToolResult, ToolError>
  }
  readonly currentMessages: ReadonlyArray<AgentMessage>
  readonly createdMessages: Ref.Ref<ReadonlyArray<AgentMessage>>
  readonly usage: Ref.Ref<AgentUsage>
  readonly turn: number
}

const maxUnhintedRetryDelayMs = 30_000
const maxHintedRetryDelayMs = 2_147_483_647

const validDelayMs = (delayMs: number) =>
  Number.isFinite(delayMs) && delayMs >= 0 ? Math.floor(delayMs) : undefined

const hintedRetryDelayMs = (error: LLMError) => {
  const delayMs = error.provider?.retryAfterMs
  const validDelay = delayMs === undefined ? undefined : validDelayMs(delayMs)

  return validDelay === undefined ? undefined : Math.min(validDelay, maxHintedRetryDelayMs)
}

const retryDelayMs = (baseDelayMs: number, attempt: number, error: LLMError) => {
  const hintedDelay = hintedRetryDelayMs(error)

  if (hintedDelay !== undefined) {
    return hintedDelay
  }

  const delayMs = validDelayMs(baseDelayMs * 2 ** Math.max(0, attempt - 1)) ?? 0

  return Math.min(delayMs, maxUnhintedRetryDelayMs)
}

const retryReason = (error: LLMError): AgentErrorCode => error.cause

const retrySleep = (delayMs: number) =>
  delayMs === 0 ? Effect.void : Effect.sleep(`${delayMs} millis`)

const failAgentLoopError = (
  error: AgentLoopError
): Stream.Stream<LLMEvent | AgentRetry, AgentLoopError> => Stream.fail(error)

const sleepStream = (delayMs: number): Stream.Stream<LLMEvent | AgentRetry, AgentLoopError> =>
  Stream.fromEffect(retrySleep(delayMs)).pipe(Stream.flatMap(() => Stream.empty))

const withProviderRetries = (
  stream: Stream.Stream<LLMEvent, LLMProviderError>,
  loopConfig: TurnStreamInput['loopConfig'],
  makeStream: () => Stream.Stream<LLMEvent, LLMProviderError>,
  attempt: number
): Stream.Stream<LLMEvent | AgentRetry, AgentLoopError> =>
  Stream.unwrap(
    Ref.make(false).pipe(
      Effect.map(emittedProviderEvent =>
        stream.pipe(
          Stream.tap(() => Ref.set(emittedProviderEvent, true)),
          Stream.catchTags({
            LLMError: error =>
              Stream.unwrap(
                Ref.get(emittedProviderEvent).pipe(
                  Effect.map(emitted => {
                    if (
                      emitted ||
                      !error.retryable ||
                      error.cause === 'context_overflow' ||
                      attempt > loopConfig.maxRetries
                    ) {
                      return failAgentLoopError(error)
                    }

                    const delayMs = retryDelayMs(loopConfig.retryBaseDelayMs, attempt, error)
                    return Stream.make(
                      AgentRetry.make({
                        attempt,
                        reason: retryReason(error),
                        delayMs,
                        message: error.message,
                        ...(error.provider === undefined ? {} : { provider: error.provider })
                      })
                    ).pipe(
                      Stream.concat(sleepStream(delayMs)),
                      Stream.concat(
                        withProviderRetries(makeStream(), loopConfig, makeStream, attempt + 1)
                      )
                    )
                  })
                )
              ),
            AbortError: failAgentLoopError,
            FauxExhaustedError: failAgentLoopError
          })
        )
      )
    )
  )

const makeToolExecutionStream = (
  executor: TurnStreamInput['executor'],
  call: ToolCall,
  model: string
): Stream.Stream<AgentEvent, AgentLoopError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const startedAtMs = yield* Clock.currentTimeMillis
      const started = subagentStartedEvent({ call, model, startedAtMs })
      const startEvents: ReadonlyArray<AgentEvent> =
        started === undefined
          ? [ToolExecutionStarted.make({ call, createdAtMs: startedAtMs })]
          : [ToolExecutionStarted.make({ call, createdAtMs: startedAtMs }), started]

      return Stream.fromIterable(startEvents).pipe(
        Stream.concat(
          Stream.fromEffect(
            executor.execute(call).pipe(
              Effect.flatMap(result =>
                Clock.currentTimeMillis.pipe(
                  Effect.map(endedAtMs =>
                    toolCompletionEvents({
                      call,
                      result,
                      model,
                      startedAtMs,
                      endedAtMs
                    })
                  )
                )
              )
            )
          ).pipe(
            Stream.flatMap(Stream.fromIterable),
            Stream.catchTag('ToolError', error =>
              Stream.fromEffect(Clock.currentTimeMillis).pipe(
                Stream.flatMap(endedAtMs =>
                  Stream.fromIterable(
                    toolErrorEvents({
                      call,
                      error,
                      model,
                      startedAtMs,
                      endedAtMs
                    })
                  )
                )
              )
            )
          )
        )
      )
    })
  )

type IndexedToolResultMessage = {
  readonly index: number
  readonly message: AgentMessage
}

type IndexedToolCall = {
  readonly index: number
  readonly call: ToolCall
}

type PreparedToolCall =
  | {
      readonly _tag: 'Execute'
      readonly index: number
      readonly call: ToolCall
      readonly events: ReadonlyArray<AgentEvent>
    }
  | {
      readonly _tag: 'Result'
      readonly index: number
      readonly call: ToolCall
      readonly result: ToolResult
      readonly events: ReadonlyArray<AgentEvent>
    }
  | {
      readonly _tag: 'Pending'
      readonly request: HitlRequest
      readonly events: ReadonlyArray<AgentEvent>
    }

type PreparedToolBatch = {
  readonly callsToExecute: ReadonlyArray<IndexedToolCall>
  readonly resultMessages: ReadonlyArray<IndexedToolResultMessage>
  readonly resultEvents: ReadonlyArray<AgentEvent>
  readonly events: ReadonlyArray<AgentEvent>
  readonly pendingRequests: ReadonlyArray<HitlRequest>
  readonly pendingEvents: ReadonlyArray<AgentEvent>
}

type NonEmptyHitlRequests = readonly [HitlRequest, ...Array<HitlRequest>]

const boundedToolConcurrency = (loopConfig: LoopConfigShape) =>
  Math.max(1, loopConfig.toolConcurrency)

const toolResultMessageFromResult = (result: ToolResult) =>
  ToolResultMessage.make({
    toolCallId: result.toolCallId,
    content: result.content,
    isError: result.isError,
    structuredContent: result.structuredContent
  })

const toolDefFor = (tools: ReadonlyArray<ToolDef>, call: ToolCall) =>
  tools.find(tool => tool.name === call.name)

const approvalRequired = (tools: ReadonlyArray<ToolDef>, call: ToolCall) =>
  toolDefFor(tools, call)?.approval?.mode === 'manual'

const approvalRequestId = (call: ToolCall) => `approval:${call.id}`

const questionRequestId = (call: ToolCall) => `question:${call.id}`

const matchesApproval = (response: ToolApprovalResponse, call: ToolCall) =>
  response.toolCallId === call.id && response.requestId === approvalRequestId(call)

const matchesQuestion = (response: QuestionResponse, call: ToolCall) =>
  response.toolCallId === call.id && response.requestId === questionRequestId(call)

const approvalResponseFor = (responses: ReadonlyArray<HitlResponse>, call: ToolCall) =>
  responses.flatMap(response =>
    response._tag === 'ToolApprovalResponse' && matchesApproval(response, call) ? [response] : []
  )[0]

const questionResponseFor = (responses: ReadonlyArray<HitlResponse>, call: ToolCall) =>
  responses.flatMap(response =>
    response._tag === 'QuestionResponse' && matchesQuestion(response, call) ? [response] : []
  )[0]

const toolApprovalRequest = (tools: ReadonlyArray<ToolDef>, call: ToolCall): ToolApprovalRequest =>
  ToolApprovalRequest.make({
    requestId: approvalRequestId(call),
    toolCallId: call.id,
    call,
    policy: toolDefFor(tools, call)?.approval
  })

const deniedToolResult = (call: ToolCall, response: ToolApprovalResponse) => {
  const reason = response.reason ?? 'Denied by user'

  return ToolResult.make({
    toolCallId: call.id,
    content: `Tool call denied: ${reason}`,
    isError: true,
    structuredContent: {
      type: 'tool_approval_denied',
      reason,
      source: response.source
    }
  })
}

const questionToolResult = (
  response: QuestionResponse,
  questions: ReadonlyArray<QuestionPrompt>
) => {
  return ToolResult.make({
    toolCallId: response.toolCallId,
    content: formatQuestionResponseContent(response, questions),
    isError: response.outcome === 'cancelled' ? true : undefined,
    structuredContent: questionResponseStructuredContent(response)
  })
}

const invalidQuestionToolResult = (call: ToolCall) =>
  ToolResult.make({
    toolCallId: call.id,
    content: 'Invalid question arguments.',
    isError: true,
    structuredContent: { type: 'question_invalid' }
  })

const prepareQuestionCall = (
  call: ToolCall,
  index: number,
  responses: ReadonlyArray<HitlResponse>
): Effect.Effect<PreparedToolCall> =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(QuestionToolParams)(call.params).pipe(
      Effect.result
    )

    if (decoded._tag === 'Failure') {
      return {
        _tag: 'Result',
        index,
        call,
        result: invalidQuestionToolResult(call),
        events: []
      }
    }

    const response = questionResponseFor(responses, call)

    if (response !== undefined) {
      return {
        _tag: 'Result',
        index,
        call,
        result: questionToolResult(response, decoded.success.questions),
        events: [hitlResponseEvent(response)]
      }
    }

    const request = QuestionRequest.make({
      requestId: questionRequestId(call),
      toolCallId: call.id,
      call,
      questions: decoded.success.questions
    })

    return {
      _tag: 'Pending',
      request,
      events: [QuestionRequested.make({ request })]
    }
  })

const prepareApprovalCall = (
  tools: ReadonlyArray<ToolDef>,
  call: ToolCall,
  index: number,
  responses: ReadonlyArray<HitlResponse>
): PreparedToolCall => {
  if (!approvalRequired(tools, call)) {
    return { _tag: 'Execute', index, call, events: [] }
  }

  const request = toolApprovalRequest(tools, call)
  const response = approvalResponseFor(responses, call)

  if (response === undefined) {
    return {
      _tag: 'Pending',
      request,
      events: [ToolApprovalRequested.make({ call, request })]
    }
  }

  if (response.decision === 'denied') {
    return {
      _tag: 'Result',
      index,
      call,
      result: deniedToolResult(call, response),
      events: [hitlResponseEvent(response)]
    }
  }

  return {
    _tag: 'Execute',
    index,
    call,
    events: [hitlResponseEvent(response)]
  }
}

const prepareToolCall = (input: {
  readonly tools: ReadonlyArray<ToolDef>
  readonly responses: ReadonlyArray<HitlResponse>
  readonly call: ToolCall
  readonly index: number
}): Effect.Effect<PreparedToolCall> =>
  input.call.name === questionToolName
    ? prepareQuestionCall(input.call, input.index, input.responses)
    : Effect.succeed(prepareApprovalCall(input.tools, input.call, input.index, input.responses))

const prepareToolBatch = (input: {
  readonly tools: ReadonlyArray<ToolDef>
  readonly responses: ReadonlyArray<HitlResponse>
  readonly calls: ReadonlyArray<ToolCall>
}): Effect.Effect<PreparedToolBatch> =>
  Effect.gen(function* () {
    const prepared = yield* Effect.forEach(input.calls, (call, index) =>
      prepareToolCall({ tools: input.tools, responses: input.responses, call, index })
    )

    return {
      callsToExecute: prepared.flatMap(item =>
        item._tag === 'Execute' ? [{ index: item.index, call: item.call }] : []
      ),
      resultMessages: prepared.flatMap(item =>
        item._tag === 'Result'
          ? [{ index: item.index, message: toolResultMessageFromResult(item.result) }]
          : []
      ),
      resultEvents: syntheticToolCompletionEvents(prepared),
      events: prepared.flatMap(item => (item._tag === 'Pending' ? [] : item.events)),
      pendingRequests: prepared.flatMap(item => (item._tag === 'Pending' ? [item.request] : [])),
      pendingEvents: prepared.flatMap(item => (item._tag === 'Pending' ? item.events : []))
    }
  })

const orderedToolResultMessages = (results: ReadonlyArray<IndexedToolResultMessage>) =>
  [...results].sort((left, right) => left.index - right.index).map(result => result.message)

const syntheticToolCompletionEvents = (
  prepared: ReadonlyArray<PreparedToolCall>
): ReadonlyArray<AgentEvent> =>
  prepared.flatMap(item =>
    item._tag === 'Result'
      ? [ToolExecutionCompleted.make({ call: item.call, result: item.result })]
      : []
  )

const toolResultIds = (messages: ReadonlyArray<AgentMessage>): ReadonlySet<string> =>
  new Set(messages.flatMap(message => (message._tag === 'ToolResult' ? [message.toolCallId] : [])))

const pendingHostToolCalls = (messages: ReadonlyArray<AgentMessage>) => {
  const completed = toolResultIds(messages)

  return messages.flatMap(message =>
    message._tag === 'Assistant'
      ? assistantHostToolCalls(message).filter(call => !completed.has(call.id))
      : []
  )
}

const nonEmptyHitlRequests = (
  requests: ReadonlyArray<HitlRequest>
): NonEmptyHitlRequests | undefined => {
  const first = requests[0]

  return first === undefined ? undefined : [first, ...requests.slice(1)]
}

const parallelToolExecutionStream = (input: {
  readonly calls: ReadonlyArray<IndexedToolCall>
  readonly executor: TurnStreamInput['executor']
  readonly loopConfig: LoopConfigShape
  readonly model: string
  readonly results: Ref.Ref<ReadonlyArray<IndexedToolResultMessage>>
}) =>
  Stream.mergeAll(
    input.calls.map(({ call, index }) =>
      makeToolExecutionStream(input.executor, call, input.model).pipe(
        Stream.tap(event => {
          if (event._tag !== 'ToolExecutionCompleted') {
            return Effect.void
          }

          return Ref.update(input.results, results => [
            ...results,
            { index, message: toolResultMessageFromResult(event.result) }
          ])
        })
      )
    ),
    { concurrency: boundedToolConcurrency(input.loopConfig) }
  )

const toolErrorCode = (error: ToolError): AgentErrorCode => {
  switch (error.cause) {
    case 'validation':
    case 'invalid_input':
      return 'validation_error'
    case 'timeout':
      return 'tool_timeout'
    case 'permission':
    case 'denied':
      return 'tool_denied'
    case 'execution':
    case 'not_found':
    case 'unavailable':
      return 'tool_error'
  }
}

type TurnCompletion = {
  readonly toolCalls: ReadonlyArray<ToolCall>
  readonly stopReason: 'stop' | 'tool_use'
}

const validateTurnCompletion = (
  events: ReadonlyArray<LLMEvent>
): Effect.Effect<TurnCompletion, LLMError> => {
  const doneEvents = events.filter(event => event._tag === 'Done')
  const toolCalls = collectToolCalls(events)
  const stopReason: TurnCompletion['stopReason'] = toolCalls.length === 0 ? 'stop' : 'tool_use'

  if (doneEvents.length !== 1) {
    return Effect.fail(
      new LLMError({
        cause: 'invalid_response',
        message: `Expected exactly one LLM done event, received ${doneEvents.length}`,
        retryable: false
      })
    )
  }

  const doneEvent = doneEvents[0]

  if (doneEvent === undefined || doneEvent.stopReason !== stopReason) {
    return Effect.fail(
      new LLMError({
        cause: 'invalid_response',
        message: `LLM done reason must be ${stopReason}`,
        retryable: false
      })
    )
  }

  return Effect.succeed({ toolCalls, stopReason })
}

const makeAfterLlmStream = (
  input: TurnStreamInput,
  llmEventsRef: Ref.Ref<ReadonlyArray<LLMEvent>>
): Stream.Stream<AgentEvent, AgentLoopError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const llmEvents = yield* Ref.get(llmEventsRef)
      const completion = yield* validateTurnCompletion(llmEvents)
      const assistantMessage = accumulateAssistantMessage(llmEvents)
      const turnEndEvents: ReadonlyArray<AgentEvent> = [
        LLMStreamEnd.make({ turn: input.turn }),
        AssistantMessageEvent.make({ message: assistantMessage })
      ]

      yield* Ref.update(input.createdMessages, messages => [...messages, assistantMessage])

      if (completion.toolCalls.length === 0) {
        const messages = yield* Ref.get(input.createdMessages)
        const usage = yield* Ref.get(input.usage)

        return Stream.fromIterable([
          ...turnEndEvents,
          TurnEnd.make({ turn: input.turn, reason: completion.stopReason }),
          AgentEnd.make({
            messages,
            turns: input.turn,
            usage
          })
        ])
      }

      const toolResultMessages = yield* Ref.make<ReadonlyArray<IndexedToolResultMessage>>([])
      const prepared = yield* prepareToolBatch({
        tools: input.config.tools,
        responses: input.config.hitlResponses ?? [],
        calls: completion.toolCalls
      })

      if (prepared.resultMessages.length > 0) {
        yield* Ref.update(toolResultMessages, results => [...results, ...prepared.resultMessages])
      }

      if (prepared.pendingRequests.length > 0) {
        const pendingRequests = nonEmptyHitlRequests(prepared.pendingRequests)

        if (pendingRequests === undefined) {
          return Stream.empty
        }

        const readyResults = orderedToolResultMessages(yield* Ref.get(toolResultMessages))
        if (readyResults.length > 0) {
          yield* Ref.update(input.createdMessages, messages => [...messages, ...readyResults])
        }

        const messages = yield* Ref.get(input.createdMessages)
        const usage = yield* Ref.get(input.usage)

        return Stream.fromIterable([
          ...turnEndEvents,
          ...prepared.events,
          ...prepared.pendingEvents,
          TurnEnd.make({ turn: input.turn, reason: completion.stopReason }),
          AgentAwaitingInput.make({
            requests: pendingRequests,
            messages,
            turns: input.turn,
            usage
          })
        ])
      }

      const toolExecutionStream = parallelToolExecutionStream({
        calls: prepared.callsToExecute,
        executor: input.executor,
        loopConfig: input.loopConfig,
        model: input.config.model,
        results: toolResultMessages
      })
      const nextTurnStream = Stream.unwrap(
        Ref.get(toolResultMessages).pipe(
          Effect.flatMap(results => {
            const orderedResults = orderedToolResultMessages(results)

            return Ref.update(input.createdMessages, messages => [
              ...messages,
              ...orderedResults
            ]).pipe(
              Effect.as(
                Stream.make(TurnEnd.make({ turn: input.turn, reason: completion.stopReason })).pipe(
                  Stream.concat(
                    makeTurnStream({
                      ...input,
                      currentMessages: [
                        ...input.currentMessages,
                        assistantMessage,
                        ...orderedResults
                      ],
                      turn: input.turn + 1
                    })
                  )
                )
              )
            )
          })
        )
      )

      return Stream.fromIterable(turnEndEvents).pipe(
        Stream.concat(Stream.fromIterable(prepared.events)),
        Stream.concat(toolExecutionStream),
        Stream.concat(nextTurnStream)
      )
    })
  )

const makeModelOnlyAfterLlmStream = (
  input: TurnStreamInput,
  llmEventsRef: Ref.Ref<ReadonlyArray<LLMEvent>>
): Stream.Stream<AgentEvent, AgentLoopError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const llmEvents = yield* Ref.get(llmEventsRef)
      const completion = yield* validateTurnCompletion(llmEvents)
      const assistantMessage = accumulateAssistantMessage(llmEvents)

      yield* Ref.update(input.createdMessages, messages => [...messages, assistantMessage])

      return Stream.fromIterable([
        LLMStreamEnd.make({ turn: input.turn }),
        AssistantMessageEvent.make({ message: assistantMessage }),
        TurnEnd.make({ turn: input.turn, reason: completion.stopReason })
      ])
    })
  )

const makeLlmStream = (
  input: TurnStreamInput,
  llmEvents: Ref.Ref<ReadonlyArray<LLMEvent>>,
  result: ContextTransformResult
): Stream.Stream<AgentEvent, AgentLoopError> => {
  const makeStream = () =>
    input.provider.stream({
      messages: result.messages,
      tools: input.config.tools,
      model: input.config.model,
      reasoningEffort: input.config.reasoningEffort,
      systemPrompt: input.config.systemPrompt
    })

  return Stream.fromIterable(result.events)
    .pipe(Stream.concat(withProviderRetries(makeStream(), input.loopConfig, makeStream, 1)))
    .pipe(
      Stream.tap(event => {
        if (!isLlmEvent(event)) {
          return Effect.void
        }

        const appendEvent = Ref.update(llmEvents, events => [...events, event])

        if (event._tag !== 'Usage') {
          return appendEvent
        }

        return Ref.update(input.usage, usage => addAgentUsage(usage, event.usage)).pipe(
          Effect.flatMap(() => appendEvent)
        )
      }),
      Stream.flatMap(event =>
        event._tag === 'AgentRetry'
          ? Stream.make(event)
          : isLlmEvent(event)
            ? Stream.fromIterable(toLlmEvent(event))
            : Stream.make(event)
      ),
      Stream.concat(makeAfterLlmStream(input, llmEvents))
    )
}

const makeModelOnlyLlmStream = (
  input: TurnStreamInput,
  llmEvents: Ref.Ref<ReadonlyArray<LLMEvent>>,
  result: ContextTransformResult
): Stream.Stream<AgentEvent, AgentLoopError> => {
  const makeStream = () =>
    input.provider.stream({
      messages: result.messages,
      tools: input.config.tools,
      model: input.config.model,
      reasoningEffort: input.config.reasoningEffort,
      systemPrompt: input.config.systemPrompt
    })

  return Stream.fromIterable(result.events)
    .pipe(Stream.concat(withProviderRetries(makeStream(), input.loopConfig, makeStream, 1)))
    .pipe(
      Stream.tap(event => {
        if (!isLlmEvent(event)) {
          return Effect.void
        }

        const appendEvent = Ref.update(llmEvents, events => [...events, event])

        if (event._tag !== 'Usage') {
          return appendEvent
        }

        return Ref.update(input.usage, usage => addAgentUsage(usage, event.usage)).pipe(
          Effect.flatMap(() => appendEvent)
        )
      }),
      Stream.flatMap(event =>
        event._tag === 'AgentRetry'
          ? Stream.make(event)
          : isLlmEvent(event)
            ? Stream.fromIterable(toLlmEvent(event))
            : Stream.make(event)
      ),
      Stream.concat(makeModelOnlyAfterLlmStream(input, llmEvents))
    )
}

const makeTurnStream = (input: TurnStreamInput): Stream.Stream<AgentEvent, AgentLoopError> =>
  Stream.suspend(() => {
    if (input.turn > input.loopConfig.maxTurns) {
      return Stream.fail(new AbortError({ reason: 'max_turns' }))
    }

    const llmStream = Stream.unwrap(
      Effect.gen(function* () {
        const llmEvents = yield* Ref.make<ReadonlyArray<LLMEvent>>([])
        const result = yield* input.contextTransformer.transform(input.currentMessages)
        yield* validateCapabilities(input.config, result.messages)

        return makeLlmStream(input, llmEvents, result)
      })
    )

    return Stream.fromIterable([
      TurnStart.make({ turn: input.turn }),
      LLMStreamStart.make({ turn: input.turn })
    ]).pipe(Stream.concat(llmStream))
  })

const makePendingToolResumeStream = (
  input: TurnStreamInput
): Stream.Stream<AgentEvent, AgentLoopError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const pendingCalls = pendingHostToolCalls(input.currentMessages)

      if (pendingCalls.length === 0 || (input.config.hitlResponses ?? []).length === 0) {
        return makeTurnStream(input)
      }

      const toolResultMessages = yield* Ref.make<ReadonlyArray<IndexedToolResultMessage>>([])
      const prepared = yield* prepareToolBatch({
        tools: input.config.tools,
        responses: input.config.hitlResponses ?? [],
        calls: pendingCalls
      })

      if (prepared.resultMessages.length > 0) {
        yield* Ref.update(toolResultMessages, results => [...results, ...prepared.resultMessages])
      }

      if (prepared.pendingRequests.length > 0) {
        const pendingRequests = nonEmptyHitlRequests(prepared.pendingRequests)

        if (pendingRequests === undefined) {
          return Stream.empty
        }

        const readyResults = orderedToolResultMessages(yield* Ref.get(toolResultMessages))
        if (readyResults.length > 0) {
          yield* Ref.update(input.createdMessages, messages => [...messages, ...readyResults])
        }

        const messages = yield* Ref.get(input.createdMessages)
        const usage = yield* Ref.get(input.usage)

        return Stream.fromIterable([
          ...prepared.events,
          ...prepared.pendingEvents,
          AgentAwaitingInput.make({
            requests: pendingRequests,
            messages,
            turns: Math.max(0, input.turn - 1),
            usage
          })
        ])
      }

      const toolExecutionStream = parallelToolExecutionStream({
        calls: prepared.callsToExecute,
        executor: input.executor,
        loopConfig: input.loopConfig,
        model: input.config.model,
        results: toolResultMessages
      })
      const nextTurnStream = Stream.unwrap(
        Ref.get(toolResultMessages).pipe(
          Effect.flatMap(results => {
            const orderedResults = orderedToolResultMessages(results)

            return Ref.update(input.createdMessages, messages => [
              ...messages,
              ...orderedResults
            ]).pipe(
              Effect.as(
                makeTurnStream({
                  ...input,
                  currentMessages: [...input.currentMessages, ...orderedResults]
                })
              )
            )
          })
        )
      )

      return Stream.fromIterable(prepared.events).pipe(
        Stream.concat(toolExecutionStream),
        Stream.concat(nextTurnStream)
      )
    })
  )

const unavailableToolExecutor: TurnStreamInput['executor'] = {
  execute: call =>
    Effect.fail(
      new ToolError({
        tool: call.name,
        message: 'Tool execution is not available in model turn step',
        cause: 'execution'
      })
    )
}

const makeModelOnlyTurnStream = (
  input: TurnStreamInput
): Stream.Stream<AgentEvent, AgentLoopError> =>
  Stream.suspend(() => {
    if (input.turn > input.loopConfig.maxTurns) {
      return Stream.fail(new AbortError({ reason: 'max_turns' }))
    }

    const llmStream = Stream.unwrap(
      Effect.gen(function* () {
        const llmEvents = yield* Ref.make<ReadonlyArray<LLMEvent>>([])
        const result = yield* input.contextTransformer.transform(input.currentMessages)
        yield* validateCapabilities(input.config, result.messages)

        return makeModelOnlyLlmStream(input, llmEvents, result)
      })
    )

    return Stream.fromIterable([
      TurnStart.make({ turn: input.turn }),
      LLMStreamStart.make({ turn: input.turn })
    ]).pipe(Stream.concat(llmStream))
  })

export const runModelTurn = (
  config: ModelTurnConfig
): Stream.Stream<AgentEvent, AgentLoopError, ContextTransformer | LLMProvider | LoopConfig> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const contextTransformer = yield* ContextTransformer
      const loopConfig = yield* LoopConfig
      const provider = yield* LLMProvider
      const createdMessages = yield* Ref.make<ReadonlyArray<AgentMessage>>([])
      const usage = yield* Ref.make(zeroAgentUsage)

      return makeModelOnlyTurnStream({
        config,
        contextTransformer,
        loopConfig,
        provider,
        executor: unavailableToolExecutor,
        currentMessages: config.messages,
        createdMessages,
        usage,
        turn: config.turn
      })
    })
  )

export const runToolBatch = (
  config: ToolBatchConfig
): Stream.Stream<AgentEvent, AgentLoopError, LoopConfig | ToolExecutor> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const executor = yield* ToolExecutor
      const loopConfig = yield* LoopConfig
      const toolResultMessages = yield* Ref.make<ReadonlyArray<IndexedToolResultMessage>>([])
      const prepared = yield* prepareToolBatch({
        tools: config.tools ?? [],
        responses: config.hitlResponses ?? [],
        calls: config.calls
      })
      const hasPendingRequests = prepared.pendingRequests.length > 0
      const resultEvents = hasPendingRequests ? [] : prepared.resultEvents
      const pendingRequests = nonEmptyHitlRequests(prepared.pendingRequests)
      const awaitingEvents: ReadonlyArray<AgentEvent> =
        pendingRequests === undefined
          ? []
          : [
              AgentAwaitingInput.make({
                requests: pendingRequests,
                messages: config.createdMessages ?? [],
                turns: config.turn ?? 0,
                usage: config.usage ?? zeroAgentUsage
              })
            ]

      return Stream.fromIterable([
        ...prepared.events,
        ...resultEvents,
        ...prepared.pendingEvents,
        ...awaitingEvents
      ]).pipe(
        Stream.concat(
          parallelToolExecutionStream({
            calls: hasPendingRequests ? [] : prepared.callsToExecute,
            executor,
            loopConfig,
            model: config.model ?? '',
            results: toolResultMessages
          })
        )
      )
    })
  )

export const run = (
  config: RunConfig
): Stream.Stream<
  AgentEvent,
  AgentLoopError,
  ContextTransformer | LLMProvider | LoopConfig | ToolExecutor
> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const contextTransformer = yield* ContextTransformer
      const loopConfig = yield* LoopConfig
      const provider = yield* LLMProvider
      const executor = yield* ToolExecutor
      const createdMessages = yield* Ref.make<ReadonlyArray<AgentMessage>>([])
      const usage = yield* Ref.make(zeroAgentUsage)

      return Stream.make(AgentStart.make({})).pipe(
        Stream.concat(
          makePendingToolResumeStream({
            config,
            contextTransformer,
            loopConfig,
            provider,
            executor,
            currentMessages: config.messages,
            createdMessages,
            usage,
            turn: 1
          })
        )
      )
    })
  )
