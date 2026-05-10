import { Effect, Stream } from 'effect'
import {
  AgentEnd,
  AgentStart,
  AssistantMessageEvent,
  LLMToolCall as AgentLLMToolCall,
  LLMStreamEnd,
  LLMStreamStart,
  LLMTextDelta as AgentLLMTextDelta,
  ToolExecutionEnd,
  ToolExecutionStart,
  ToolResultEvent,
  ToolResultMessage,
  TurnEnd,
  TurnStart,
  type AgentEvent,
  type AgentMessage,
  type ToolDef
} from '@yolk/protocol'
import { accumulateAssistantMessage, collectToolCalls } from './accumulator'
import { AbortError, type AgentLoopError } from './error'
import type { LLMEvent } from './llm-event'
import { ContextTransformer } from './services/context-transformer'
import { LLMProvider } from './services/llm-provider'
import { LoopConfig } from './services/loop-config'
import { ToolExecutor } from './services/tool-executor'

export type AgentLoopRunId = string

export type RunConfig = {
  readonly messages: ReadonlyArray<AgentMessage>
  readonly systemPrompt: string
  readonly tools: ReadonlyArray<ToolDef>
  readonly model: string
}

const toLlmEvents = (llmEvents: ReadonlyArray<LLMEvent>): ReadonlyArray<AgentEvent> => {
  const events: Array<AgentEvent> = []

  for (const event of llmEvents) {
    switch (event._tag) {
      case 'TextDelta':
        events.push(AgentLLMTextDelta.make({ text: event.text }))
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
      const events: Array<AgentEvent> = [AgentStart.make({})]
      const createdMessages: Array<AgentMessage> = []
      let currentMessages: ReadonlyArray<AgentMessage> = config.messages
      let turn = 1
      let shouldContinue = true

      while (shouldContinue) {
        if (turn > loopConfig.maxTurns) {
          return yield* Effect.fail(new AbortError({ reason: 'max_turns' }))
        }

        events.push(TurnStart.make({ turn }), LLMStreamStart.make({ turn }))
        const transformedMessages = yield* contextTransformer.transform(currentMessages)

        const llmEvents = yield* provider
          .stream({
            messages: transformedMessages,
            tools: config.tools,
            model: config.model,
            systemPrompt: config.systemPrompt
          })
          .pipe(Stream.runCollect)

        const toolCalls = collectToolCalls(llmEvents)
        const assistantMessage = accumulateAssistantMessage(llmEvents)

        events.push(
          ...toLlmEvents(llmEvents),
          LLMStreamEnd.make({ turn }),
          AssistantMessageEvent.make({ message: assistantMessage })
        )
        createdMessages.push(assistantMessage)

        if (toolCalls.length === 0) {
          events.push(TurnEnd.make({ turn, reason: 'stop' }))
          shouldContinue = false
        } else {
          const toolResultMessages: Array<AgentMessage> = []

          for (const call of toolCalls) {
            events.push(ToolExecutionStart.make({ call }))
            const result = yield* executor.execute(call)
            const toolResultMessage = ToolResultMessage.make({
              toolCallId: result.toolCallId,
              content: result.content
            })

            events.push(
              ToolExecutionEnd.make({ call, result }),
              ToolResultEvent.make({ result })
            )
            createdMessages.push(toolResultMessage)
            toolResultMessages.push(toolResultMessage)
          }

          events.push(TurnEnd.make({ turn, reason: 'tool_use' }))
          currentMessages = [...currentMessages, assistantMessage, ...toolResultMessages]
          turn += 1
        }
      }

      events.push(
        AgentEnd.make({
          messages: createdMessages,
          turns: turn,
          usage: { input: 0, output: 0 }
        })
      )

      return Stream.fromIterable(events)
    })
  )
