import { Effect, Ref, Stream } from 'effect'
import type {
  AgentEvent,
  AgentMessage,
  AgentModelCapabilities,
  AgentReasoningEffort,
  HitlResponse,
  HitlRequest,
  ToolDef
} from '@yolk-sdk/agent/protocol'
import {
  run,
  type AgentLoopError,
  type ContextTransformer,
  type LLMProvider,
  type LoopConfig,
  type ToolExecutor
} from '@yolk-sdk/agent/loop'
import { runtimeErrorToAgentError, SessionConflictError } from './error.ts'
import {
  HitlResponseAppended,
  InputAppended,
  replayRuntimeHitlResponses,
  replayRuntimeSessionEvents,
  RunAwaitingInput,
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
  readonly hitlResponses?: ReadonlyArray<HitlResponse>
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

export type AppendHitlResponseRuntimeRequest = {
  readonly _tag: 'AppendHitlResponse'
  readonly sessionId: string
  readonly response: HitlResponse
  readonly runId: string
  readonly expectedRevision?: SessionRevision
}

export type RuntimeRequest =
  | TranscriptRuntimeRequest
  | AppendInputRuntimeRequest
  | AppendHitlResponseRuntimeRequest

type LoopRequirements = ContextTransformer | LLMProvider | LoopConfig | ToolExecutor
type AppendRuntimeRequirements = LoopRequirements | SessionEventStore
type RuntimeRequirements = LoopRequirements | AppendRuntimeRequirements
type RuntimeErrorUnion = RuntimeError | AgentLoopError

const extractNewMessages = (event: AgentEvent) => (event._tag === 'AgentEnd' ? event.messages : [])

const runtimeRunConfig = (config: RuntimeConfig, messages: ReadonlyArray<AgentMessage>) => ({
  messages,
  systemPrompt: config.systemPrompt,
  tools: config.tools,
  hitlResponses: config.hitlResponses,
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
  store
    .load(sessionId)
    .pipe(
      Effect.catchTag('SessionNotFoundError', () =>
        Effect.succeed(emptyRuntimeSessionEventLog(sessionId))
      )
    )

const latestAwaitingRequests = (log: RuntimeSessionEventLog): ReadonlyArray<HitlRequest> =>
  log.events.reduceRight<ReadonlyArray<HitlRequest> | undefined>((found, stored) => {
    if (found !== undefined) return found
    switch (stored.event._tag) {
      case 'RunAwaitingInput':
        return stored.event.requests
      case 'RunCompleted':
      case 'RunFailed':
      case 'RunInterrupted':
        return []
      case 'HitlResponseAppended':
      case 'InputAppended':
      case 'RunStarted':
        return undefined
    }
  }, undefined) ?? []

const hitlResponseMatchesRequest = (response: HitlResponse, request: HitlRequest) => {
  switch (response._tag) {
    case 'ToolApprovalResponse':
      return (
        request._tag === 'ToolApprovalRequest' &&
        response.requestId === request.requestId &&
        response.toolCallId === request.toolCallId
      )
    case 'QuestionResponse':
      return (
        request._tag === 'QuestionRequest' &&
        response.requestId === request.requestId &&
        response.toolCallId === request.toolCallId
      )
  }
}

const validateHitlResponse = (
  request: AppendHitlResponseRuntimeRequest,
  log: RuntimeSessionEventLog
) => {
  if (
    latestAwaitingRequests(log).some(item => hitlResponseMatchesRequest(request.response, item))
  ) {
    return Effect.void
  }

  return Effect.fail(
    new SessionConflictError({
      sessionId: request.sessionId,
      message: `HITL response does not match pending requests: ${request.response.requestId}`
    })
  )
}

const appendRunFailed = (
  store: SessionEventStoreApi,
  request: AppendInputRuntimeRequest | AppendHitlResponseRuntimeRequest,
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
      return run(runtimeRunConfig(config, messages)).pipe(
        Stream.tap(event =>
          event._tag === 'AgentEnd'
            ? store
                .append({
                  sessionId: request.sessionId,
                  expectedRevision: startedLog.revision,
                  events: [RunCompleted.make({ runId: request.runId, messages: event.messages })]
                })
                .pipe(Effect.asVoid)
            : event._tag === 'AgentAwaitingInput'
              ? store
                  .append({
                    sessionId: request.sessionId,
                    expectedRevision: startedLog.revision,
                    events: [
                      RunAwaitingInput.make({
                        runId: request.runId,
                        requests: event.requests,
                        messages: event.messages
                      })
                    ]
                  })
                  .pipe(Effect.asVoid)
              : Effect.void
        ),
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
    })
  )

const makeAppendHitlResponseRuntimeStream = (
  request: AppendHitlResponseRuntimeRequest,
  config: RuntimeConfig
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const store = yield* SessionEventStore
      const initialLog = yield* loadAppendLogOrEmpty(store, request.sessionId)
      yield* validateHitlResponse(request, initialLog)
      const startedLog = yield* store.append({
        sessionId: request.sessionId,
        expectedRevision: request.expectedRevision ?? initialLog.revision,
        events: [
          HitlResponseAppended.make({ response: request.response }),
          RunStarted.make({ runId: request.runId })
        ]
      })
      const messages = replayRuntimeSessionEvents(initialLog.events)
      const priorResponses = replayRuntimeHitlResponses(initialLog.events)
      const hitlResponses = [...priorResponses, request.response]

      return run(runtimeRunConfig({ ...config, hitlResponses }, messages)).pipe(
        Stream.tap(event =>
          event._tag === 'AgentEnd'
            ? store
                .append({
                  sessionId: request.sessionId,
                  expectedRevision: startedLog.revision,
                  events: [RunCompleted.make({ runId: request.runId, messages: event.messages })]
                })
                .pipe(Effect.asVoid)
            : event._tag === 'AgentAwaitingInput'
              ? store
                  .append({
                    sessionId: request.sessionId,
                    expectedRevision: startedLog.revision,
                    events: [
                      RunAwaitingInput.make({
                        runId: request.runId,
                        requests: event.requests,
                        messages: event.messages
                      })
                    ]
                  })
                  .pipe(Effect.asVoid)
              : Effect.void
        ),
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
  request: AppendHitlResponseRuntimeRequest,
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
    case 'AppendHitlResponse':
      return makeAppendHitlResponseRuntimeStream(request, config)
  }
}
