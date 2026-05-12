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
import { runtimeErrorToAgentError } from './error.ts'
import {
  InputAppended,
  replayRuntimeSessionEvents,
  RunCompleted,
  RunFailed,
  RunStarted,
  SessionEventStore,
  type RuntimeSessionEventLog,
  type SessionEventStoreApi,
  type SessionRevision
} from './session-event-store.ts'
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
}

export type AppendInputRuntimeRequest = {
  readonly _tag: 'AppendInput'
  readonly sessionId: string
  readonly input: AgentMessage
  readonly runId: string
  readonly expectedRevision?: SessionRevision
}

export type RuntimeRequest =
  | TranscriptRuntimeRequest
  | AppendInputRuntimeRequest

type LoopRequirements = ContextTransformer | LLMProvider | LoopConfig | ToolExecutor
type AppendRuntimeRequirements = LoopRequirements | SessionEventStore
type RuntimeRequirements = LoopRequirements | AppendRuntimeRequirements
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

const appendAfterSuccess = (
  stream: Stream.Stream<AgentEvent, RuntimeErrorUnion, RuntimeRequirements>,
  append: Effect.Effect<void, RuntimeError>
) => stream.pipe(Stream.concat(Stream.fromEffect(append).pipe(Stream.flatMap(() => Stream.empty))))

const makeTranscriptRuntimeStream = (request: TranscriptRuntimeRequest, config: RuntimeConfig) =>
  Stream.unwrap(
    Ref.make<ReadonlyArray<AgentMessage>>([]).pipe(
      Effect.map(createdMessages =>
        runAndCollectMessages(config, request.messages, createdMessages)
      )
    )
  )

const emptyRuntimeSessionEventLog = (sessionId: string): RuntimeSessionEventLog => ({
  sessionId,
  revision: 0,
  events: []
})

const loadAppendLogOrEmpty = (store: SessionEventStoreApi, sessionId: string) =>
  store.load(sessionId).pipe(
    Effect.catchTag('SessionNotFoundError', () =>
      Effect.succeed(emptyRuntimeSessionEventLog(sessionId))
    )
  )

const appendRunFailed = (
  store: SessionEventStoreApi,
  request: AppendInputRuntimeRequest,
  revision: SessionRevision,
  error: AgentLoopError
) =>
  store.append({
    sessionId: request.sessionId,
    expectedRevision: revision,
    events: [RunFailed.make({ runId: request.runId, error: runtimeErrorToAgentError(error) })]
  })

const makeAppendInputRuntimeStream = (request: AppendInputRuntimeRequest, config: RuntimeConfig) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const store = yield* SessionEventStore
      const initialLog = yield* loadAppendLogOrEmpty(store, request.sessionId)
      const startedLog = yield* store.append({
        sessionId: request.sessionId,
        expectedRevision: request.expectedRevision ?? initialLog.revision,
        events: [
          InputAppended.make({ message: request.input }),
          RunStarted.make({ runId: request.runId })
        ]
      })
      const messages = [...replayRuntimeSessionEvents(initialLog.events), request.input]
      const createdMessages = yield* Ref.make<ReadonlyArray<AgentMessage>>([])
      const stream = runAndCollectMessages(config, messages, createdMessages).pipe(
        Stream.catchTags({
          AbortError: error =>
            Stream.fromEffect(appendRunFailed(store, request, startedLog.revision, error)).pipe(
              Stream.flatMap(() => Stream.fail(error))
            ),
          ContextTransformError: error =>
            Stream.fromEffect(appendRunFailed(store, request, startedLog.revision, error)).pipe(
              Stream.flatMap(() => Stream.fail(error))
            ),
          FauxExhaustedError: error =>
            Stream.fromEffect(appendRunFailed(store, request, startedLog.revision, error)).pipe(
              Stream.flatMap(() => Stream.fail(error))
            ),
          LLMError: error =>
            Stream.fromEffect(appendRunFailed(store, request, startedLog.revision, error)).pipe(
              Stream.flatMap(() => Stream.fail(error))
            ),
          ToolError: error =>
            Stream.fromEffect(appendRunFailed(store, request, startedLog.revision, error)).pipe(
              Stream.flatMap(() => Stream.fail(error))
            )
        })
      )

      return appendAfterSuccess(
        stream,
        Ref.get(createdMessages).pipe(
          Effect.flatMap(messages =>
            store.append({
              sessionId: request.sessionId,
              expectedRevision: startedLog.revision,
              events: [RunCompleted.make({ runId: request.runId, messages })]
            })
          ),
          Effect.asVoid
        )
      )
    })
  )

export function runRuntime(
  request: TranscriptRuntimeRequest,
  config: RuntimeConfig
): Stream.Stream<AgentEvent, AgentLoopError, LoopRequirements>
export function runRuntime(
  request: AppendInputRuntimeRequest,
  config: RuntimeConfig
): Stream.Stream<AgentEvent, RuntimeErrorUnion, AppendRuntimeRequirements>
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
      return makeTranscriptRuntimeStream(request, config)
    case 'AppendInput':
      return makeAppendInputRuntimeStream(request, config)
  }
}
