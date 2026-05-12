import { Effect, Ref, Stream } from 'effect'
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
import { SessionStore } from './session-store.ts'
import type { RuntimeError } from './error.ts'

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

type LoopRequirements = ContextTransformer | LLMProvider | LoopConfig | ToolExecutor
type RuntimeRequirements = LoopRequirements | SessionStore
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
  createdMessages: Ref.Ref<ReadonlyArray<AgentMessage>>
) =>
  run(runtimeRunConfig(config, messages)).pipe(
    Stream.tap(event => {
      const newMessages = extractNewMessages(event)

      return newMessages.length === 0
        ? Effect.void
        : Ref.update(createdMessages, messages => [...messages, ...newMessages])
    })
  )

const saveAfterSuccess = (
  stream: Stream.Stream<AgentEvent, RuntimeErrorUnion, RuntimeRequirements>,
  save: Effect.Effect<void, RuntimeError>
) => stream.pipe(Stream.concat(Stream.fromEffect(save).pipe(Stream.flatMap(() => Stream.empty))))

const makeTranscriptRuntimeStream = (request: TranscriptRuntimeRequest, config: RuntimeConfig) =>
  Stream.unwrap(
    Ref.make<ReadonlyArray<AgentMessage>>([]).pipe(
      Effect.map(createdMessages =>
        runAndCollectMessages(config, request.messages, createdMessages)
      )
    )
  )

const makePersistentTranscriptRuntimeStream = (
  request: PersistentTranscriptRuntimeRequest,
  config: RuntimeConfig
) => {
  return Stream.unwrap(
    Effect.gen(function* () {
      const store = yield* SessionStore
      const createdMessages = yield* Ref.make<ReadonlyArray<AgentMessage>>([])
      const stream = runAndCollectMessages(config, request.messages, createdMessages)

      return saveAfterSuccess(
        stream,
        Ref.get(createdMessages).pipe(
          Effect.flatMap(messages =>
            store.save({ id: request.sessionId, messages: [...request.messages, ...messages] })
          )
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
      const createdMessages = yield* Ref.make<ReadonlyArray<AgentMessage>>([])

      return saveAfterSuccess(
        runAndCollectMessages(config, messages, createdMessages),
        Ref.get(createdMessages).pipe(
          Effect.flatMap(created =>
            store.save({ id: snapshot.id, messages: [...messages, ...created] })
          )
        )
      )
    })
  )

export function runRuntime(
  request: TranscriptRuntimeRequest,
  config: RuntimeConfig
): Stream.Stream<AgentEvent, AgentLoopError, LoopRequirements>
export function runRuntime(
  request: PersistentTranscriptRuntimeRequest | InputRuntimeRequest,
  config: RuntimeConfig
): Stream.Stream<AgentEvent, RuntimeErrorUnion, RuntimeRequirements>
export function runRuntime(
  request: RuntimeRequest,
  config: RuntimeConfig
): Stream.Stream<AgentEvent, RuntimeErrorUnion, RuntimeRequirements>
export function runRuntime(
  request: RuntimeRequest,
  config: RuntimeConfig
): Stream.Stream<AgentEvent, RuntimeErrorUnion, RuntimeRequirements> {
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
