import { Effect, Stream } from 'effect'
import type {
  AgentEvent,
  AgentMessage,
  AgentModelCapabilities,
  AgentReasoningEffort,
  ToolDef
} from '@yolk/protocol'
import {
  run,
  type AgentLoopError,
  type ContextTransformer,
  type LLMProvider,
  type LoopConfig,
  type ToolExecutor
} from '@yolk/agent-loop'
import { SessionStore } from './session-store'
import type { RuntimeError } from './error'

export type RuntimeTranscript = readonly [AgentMessage, ...Array<AgentMessage>]

export type RuntimeConfig = {
  readonly systemPrompt: string
  readonly tools: ReadonlyArray<ToolDef>
  readonly model: string
  readonly reasoningEffort?: AgentReasoningEffort
  readonly capabilities?: AgentModelCapabilities
}

export type RuntimeRequest<Ctx> =
  | {
      readonly _tag: 'Transcript'
      readonly sessionId: string
      readonly messages: RuntimeTranscript
      readonly context: Ctx
      readonly persist?: boolean
    }
  | {
      readonly _tag: 'Input'
      readonly sessionId: string
      readonly input: AgentMessage
      readonly context: Ctx
    }

const extractNewMessages = (event: AgentEvent) => (event._tag === 'AgentEnd' ? event.messages : [])

const runtimeRunConfig = (config: RuntimeConfig, messages: ReadonlyArray<AgentMessage>) => ({
  messages,
  systemPrompt: config.systemPrompt,
  tools: config.tools,
  reasoningEffort: config.reasoningEffort,
  capabilities: config.capabilities,
  model: config.model
})

const runAndCollectMessages = (
  config: RuntimeConfig,
  messages: ReadonlyArray<AgentMessage>,
  createdMessages: Array<AgentMessage>
) =>
  run(runtimeRunConfig(config, messages)).pipe(
    Stream.tap(event =>
      Effect.sync(() => {
        createdMessages.push(...extractNewMessages(event))
      })
    )
  )

const shouldPersistTranscript = <Ctx>(
  request: Extract<RuntimeRequest<Ctx>, { readonly _tag: 'Transcript' }>
) => request.persist === true

const makeTranscriptRuntimeStream = <Ctx>(
  request: Extract<RuntimeRequest<Ctx>, { readonly _tag: 'Transcript' }>,
  config: RuntimeConfig
) => {
  const createdMessages: Array<AgentMessage> = []
  const stream = runAndCollectMessages(config, request.messages, createdMessages)

  if (!shouldPersistTranscript(request)) {
    return stream
  }

  return Stream.unwrap(
    Effect.gen(function* () {
      const store = yield* SessionStore

      return stream.pipe(
        Stream.ensuring(
          Effect.sync(() => [...request.messages, ...createdMessages]).pipe(
            Effect.flatMap(messages => store.save({ id: request.sessionId, messages }))
          )
        )
      )
    })
  )
}

const makeInputRuntimeStream = <Ctx>(
  request: Extract<RuntimeRequest<Ctx>, { readonly _tag: 'Input' }>,
  config: RuntimeConfig
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const store = yield* SessionStore
      const snapshot = yield* store.load(request.sessionId)
      const messages = [...snapshot.messages, request.input]
      const createdMessages: Array<AgentMessage> = []

      return runAndCollectMessages(config, messages, createdMessages).pipe(
        Stream.ensuring(
          Effect.sync(() => [...messages, ...createdMessages]).pipe(
            Effect.flatMap(updatedMessages =>
              store.save({ id: snapshot.id, messages: updatedMessages })
            )
          )
        )
      )
    })
  )

export const runRuntime = <Ctx>(
  request: RuntimeRequest<Ctx>,
  config: RuntimeConfig
): Stream.Stream<
  AgentEvent,
  RuntimeError | AgentLoopError,
  ContextTransformer | LLMProvider | LoopConfig | SessionStore | ToolExecutor
> => {
  switch (request._tag) {
    case 'Transcript':
      return makeTranscriptRuntimeStream(request, config)
    case 'Input':
      return makeInputRuntimeStream(request, config)
  }
}
