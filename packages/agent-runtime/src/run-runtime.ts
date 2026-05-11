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

export type TranscriptRuntimeRequest = {
  readonly _tag: 'Transcript'
  readonly sessionId: string
  readonly messages: RuntimeTranscript
  readonly persist?: false
}

export type PersistentTranscriptRuntimeRequest = {
  readonly _tag: 'Transcript'
  readonly sessionId: string
  readonly messages: RuntimeTranscript
  readonly persist: true
}

export type InputRuntimeRequest = {
  readonly _tag: 'Input'
  readonly sessionId: string
  readonly input: AgentMessage
}

export type RuntimeRequest =
  | TranscriptRuntimeRequest
  | PersistentTranscriptRuntimeRequest
  | InputRuntimeRequest

type RuntimeRequirements = ContextTransformer | LLMProvider | LoopConfig | ToolExecutor
type RuntimeErrorUnion = RuntimeError | AgentLoopError

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

const saveAfterSuccess = (
  stream: Stream.Stream<AgentEvent, RuntimeErrorUnion, RuntimeRequirements>,
  save: Effect.Effect<void>
) => stream.pipe(Stream.concat(Stream.fromEffect(save).pipe(Stream.flatMap(() => Stream.empty))))

const makeTranscriptRuntimeStream = (request: TranscriptRuntimeRequest, config: RuntimeConfig) => {
  const createdMessages: Array<AgentMessage> = []

  return runAndCollectMessages(config, request.messages, createdMessages)
}

const makePersistentTranscriptRuntimeStream = (
  request: PersistentTranscriptRuntimeRequest,
  config: RuntimeConfig
) => {
  const createdMessages: Array<AgentMessage> = []
  const stream = runAndCollectMessages(config, request.messages, createdMessages)

  return Stream.unwrap(
    Effect.gen(function* () {
      const store = yield* SessionStore

      return saveAfterSuccess(
        stream,
        Effect.sync(() => [...request.messages, ...createdMessages]).pipe(
          Effect.flatMap(messages => store.save({ id: request.sessionId, messages }))
        )
      )
    })
  )
}

const makeInputRuntimeStream = (request: InputRuntimeRequest, config: RuntimeConfig) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const store = yield* SessionStore
      const snapshot = yield* store.load(request.sessionId)
      const messages = [...snapshot.messages, request.input]
      const createdMessages: Array<AgentMessage> = []

      return saveAfterSuccess(
        runAndCollectMessages(config, messages, createdMessages),
        Effect.sync(() => [...messages, ...createdMessages]).pipe(
          Effect.flatMap(updatedMessages =>
            store.save({ id: snapshot.id, messages: updatedMessages })
          )
        )
      )
    })
  )

export function runRuntime(
  request: TranscriptRuntimeRequest,
  config: RuntimeConfig
): Stream.Stream<AgentEvent, RuntimeErrorUnion, RuntimeRequirements>
export function runRuntime(
  request: PersistentTranscriptRuntimeRequest | InputRuntimeRequest,
  config: RuntimeConfig
): Stream.Stream<AgentEvent, RuntimeErrorUnion, RuntimeRequirements | SessionStore>
export function runRuntime(
  request: RuntimeRequest,
  config: RuntimeConfig
): Stream.Stream<AgentEvent, RuntimeErrorUnion, RuntimeRequirements | SessionStore> {
  switch (request._tag) {
    case 'Transcript':
      if (request.persist === true) {
        return makePersistentTranscriptRuntimeStream(request, config)
      }

      return makeTranscriptRuntimeStream(request, config)
    case 'Input':
      return makeInputRuntimeStream(request, config)
  }
}
