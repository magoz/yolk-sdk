import { Effect, Stream } from 'effect'
import {
  AgentEnd,
  AgentStart,
  AssistantMessageEvent,
  contentParts,
  LLMToolCall as AgentLLMToolCall,
  LLMReasoningDelta as AgentLLMReasoningDelta,
  LLMStreamEnd,
  LLMStreamStart,
  LLMTextDelta as AgentLLMTextDelta,
  ToolExecutionEnd,
  ToolExecutionStart,
  ToolResultEvent,
  ToolResultMessage,
  type ToolCall,
  type AgentReasoningEffort,
  type ToolResult,
  TurnEnd,
  TurnStart,
  type AgentEvent,
  type AgentMessage,
  type AgentModelCapabilities,
  type ToolDef
} from '@yolk/protocol'
import { accumulateAssistantMessage, collectToolCalls } from './accumulator.ts'
import { AbortError, LLMError, type AgentLoopError, type ToolError } from './error.ts'
import type { LLMEvent } from './llm-event.ts'
import { ContextTransformer } from './services/context-transformer.ts'
import { LLMProvider, type LLMRequest } from './services/llm-provider.ts'
import { LoopConfig } from './services/loop-config.ts'
import { ToolExecutor } from './services/tool-executor.ts'

export type AgentLoopRunId = string

export type RunConfig = {
  readonly messages: ReadonlyArray<AgentMessage>
  readonly systemPrompt: string
  readonly tools: ReadonlyArray<ToolDef>
  readonly model: string
  readonly reasoningEffort?: AgentReasoningEffort
  readonly capabilities?: AgentModelCapabilities
}

const unsupportedInputError = (message: string) =>
  new LLMError({
    cause: 'provider_error',
    message,
    retryable: false
  })

const validateContent = (message: AgentMessage, capabilities: AgentModelCapabilities) =>
  Effect.forEach(contentParts(message.content), part => {
    switch (part._tag) {
      case 'Text':
        return capabilities.input.text
          ? Effect.void
          : Effect.fail(unsupportedInputError('Text input is not supported by this model'))
      case 'Image':
        return capabilities.input.image
          ? Effect.void
          : Effect.fail(unsupportedInputError('Image input is not supported by this model'))
      case 'Audio':
        return capabilities.input.audio
          ? Effect.void
          : Effect.fail(unsupportedInputError('Audio input is not supported by this model'))
    }
  })

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

const toLlmEvents = (llmEvents: ReadonlyArray<LLMEvent>): ReadonlyArray<AgentEvent> => {
  const events: Array<AgentEvent> = []

  for (const event of llmEvents) {
    switch (event._tag) {
      case 'TextDelta':
        events.push(AgentLLMTextDelta.make({ text: event.text }))
        break
      case 'ReasoningDelta':
        events.push(AgentLLMReasoningDelta.make({ text: event.text }))
        break
      case 'ToolCall':
        events.push(AgentLLMToolCall.make({ call: event.call }))
        break
      case 'Done':
        break
    }
  }

  return events
}

const toLlmEvent = (event: LLMEvent): ReadonlyArray<AgentEvent> => toLlmEvents([event])

type TurnStreamInput = {
  readonly config: RunConfig
  readonly contextTransformer: {
    readonly transform: (
      messages: ReadonlyArray<AgentMessage>
    ) => Effect.Effect<ReadonlyArray<AgentMessage>>
  }
  readonly loopConfig: { readonly maxTurns: number }
  readonly provider: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, AgentLoopError>
  }
  readonly executor: {
    readonly execute: (call: ToolCall) => Effect.Effect<ToolResult, ToolError>
  }
  readonly currentMessages: ReadonlyArray<AgentMessage>
  readonly createdMessages: Array<AgentMessage>
  readonly turn: number
}

const makeToolExecutionStream = (
  executor: TurnStreamInput['executor'],
  call: ToolCall,
  createdMessages: Array<AgentMessage>,
  toolResultMessages: Array<AgentMessage>
): Stream.Stream<AgentEvent, AgentLoopError> =>
  Stream.make(ToolExecutionStart.make({ call })).pipe(
    Stream.concat(
      Stream.fromEffect(
        executor.execute(call).pipe(
          Effect.map(result => {
            const toolResultMessage = ToolResultMessage.make({
              toolCallId: result.toolCallId,
              content: result.content
            })

            createdMessages.push(toolResultMessage)
            toolResultMessages.push(toolResultMessage)

            return [ToolExecutionEnd.make({ call, result }), ToolResultEvent.make({ result })]
          })
        )
      ).pipe(Stream.flatMap(events => Stream.fromIterable(events)))
    )
  )

const makeTurnStream = (input: TurnStreamInput): Stream.Stream<AgentEvent, AgentLoopError> =>
  Stream.suspend(() => {
    if (input.turn > input.loopConfig.maxTurns) {
      return Stream.fail(new AbortError({ reason: 'max_turns' }))
    }

    const llmEvents: Array<LLMEvent> = []
    const llmStream = Stream.unwrap(
      input.contextTransformer.transform(input.currentMessages).pipe(
        Effect.tap(transformedMessages => validateCapabilities(input.config, transformedMessages)),
        Effect.map(transformedMessages =>
          input.provider
            .stream({
              messages: transformedMessages,
              tools: input.config.tools,
              model: input.config.model,
              reasoningEffort: input.config.reasoningEffort,
              systemPrompt: input.config.systemPrompt
            })
            .pipe(
              Stream.tap(event =>
                Effect.sync(() => {
                  llmEvents.push(event)
                })
              ),
              Stream.flatMap(event => Stream.fromIterable(toLlmEvent(event)))
            )
        )
      )
    )

    const afterLlmStream = Stream.suspend(() => {
      const toolCalls = collectToolCalls(llmEvents)
      const assistantMessage = accumulateAssistantMessage(llmEvents)
      const turnEndEvents: Array<AgentEvent> = [
        LLMStreamEnd.make({ turn: input.turn }),
        AssistantMessageEvent.make({ message: assistantMessage })
      ]

      input.createdMessages.push(assistantMessage)

      if (toolCalls.length === 0) {
        return Stream.fromIterable([
          ...turnEndEvents,
          TurnEnd.make({ turn: input.turn, reason: 'stop' }),
          AgentEnd.make({
            messages: [...input.createdMessages],
            turns: input.turn,
            usage: { input: 0, output: 0 }
          })
        ])
      }

      const toolResultMessages: Array<AgentMessage> = []
      const toolExecutionStream = Stream.fromIterable(toolCalls).pipe(
        Stream.flatMap(call =>
          makeToolExecutionStream(input.executor, call, input.createdMessages, toolResultMessages)
        )
      )
      const nextTurnStream = Stream.suspend(() =>
        Stream.make(TurnEnd.make({ turn: input.turn, reason: 'tool_use' })).pipe(
          Stream.concat(
            makeTurnStream({
              ...input,
              currentMessages: [...input.currentMessages, assistantMessage, ...toolResultMessages],
              turn: input.turn + 1
            })
          )
        )
      )

      return Stream.fromIterable(turnEndEvents).pipe(
        Stream.concat(toolExecutionStream),
        Stream.concat(nextTurnStream)
      )
    })

    return Stream.fromIterable([
      TurnStart.make({ turn: input.turn }),
      LLMStreamStart.make({ turn: input.turn })
    ]).pipe(Stream.concat(llmStream), Stream.concat(afterLlmStream))
  })

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
      const createdMessages: Array<AgentMessage> = []

      return Stream.make(AgentStart.make({})).pipe(
        Stream.concat(
          makeTurnStream({
            config,
            contextTransformer,
            loopConfig,
            provider,
            executor,
            currentMessages: config.messages,
            createdMessages,
            turn: 1
          })
        )
      )
    })
  )
