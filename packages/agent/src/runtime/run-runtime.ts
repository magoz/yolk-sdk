import { Array as Arr, Data, Effect, Match, Option, Predicate, Ref, Stream } from 'effect'
import type {
  AgentEvent,
  AgentMessage,
  AgentModelCapabilities,
  AgentReasoningEffort,
  HitlResponse,
  HitlRequest,
  InputToolHandler,
  InteractionPreflight,
  InteractionHost,
  ToolApprovalPreviewer,
  ToolDef
} from '@yolk-sdk/agent/protocol'
import {
  run,
  type AgentLoopError,
  type ContextTransformer,
  type LLMProvider,
  type LoopConfig,
  type RunConfig,
  type RunInstruction,
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
  /** Server-side input validators by tool name (from ResolvedToolSet.inputs). */
  readonly inputs?: Readonly<Record<string, InputToolHandler>>
  /** Server-side interaction preflight by tool name (from ResolvedToolSet.interactions). */
  readonly interactions?: Readonly<Record<string, InteractionPreflight>>
  readonly interactionHost?: InteractionHost
  /** Change previewers by tool name (from ResolvedToolSet.approvalPreviews). */
  readonly approvalPreviews?: Readonly<Record<string, ToolApprovalPreviewer>>
  readonly model: string
  readonly reasoningEffort?: AgentReasoningEffort
  readonly capabilities?: AgentModelCapabilities
  /** Forwarded as `LLMRequest.cacheKey`; typically the session id. */
  readonly cacheKey?: string
  /** Host instructions kept current in the conversation (ADR 0007), for example
   * `ResolvedToolSet.instructions`; forwarded as `RunConfig.instructions`.
   */
  readonly instructions?: ReadonlyArray<RunInstruction>
}

export type RuntimeRequest = Data.TaggedEnum<{
  readonly Transcript: {
    readonly sessionId: string
    readonly messages: RuntimeTranscript
  }
  readonly AppendInput: {
    readonly sessionId: string
    readonly input: AgentMessage
    readonly runId: string
    readonly expectedRevision?: SessionRevision
  }
  readonly AppendHitlResponse: {
    readonly sessionId: string
    readonly response: HitlResponse
    readonly runId: string
    readonly expectedRevision?: SessionRevision
  }
}>

export const RuntimeRequest = Data.taggedEnum<RuntimeRequest>()

export type TranscriptRuntimeRequest = Extract<RuntimeRequest, { readonly _tag: 'Transcript' }>

export type AppendInputRuntimeRequest = Extract<RuntimeRequest, { readonly _tag: 'AppendInput' }>

export type AppendHitlResponseRuntimeRequest = Extract<
  RuntimeRequest,
  { readonly _tag: 'AppendHitlResponse' }
>

type LoopRequirements = ContextTransformer | LLMProvider | LoopConfig | ToolExecutor

type AppendRuntimeRequirements = LoopRequirements | SessionEventStore

type RuntimeRequirements = LoopRequirements | AppendRuntimeRequirements

type RuntimeErrorUnion = RuntimeError | AgentLoopError

const extractNewMessages = (event: AgentEvent) =>
  Predicate.isTagged(event, 'AgentEnd') ? event.messages : []

type RunConfigFields = { -readonly [Key in keyof RunConfig]: RunConfig[Key] }

const runtimeRunConfig = (
  config: RuntimeConfig,
  messages: ReadonlyArray<AgentMessage>
): RunConfig => {
  const runConfig: RunConfigFields = {
    messages,
    systemPrompt: config.systemPrompt,
    tools: config.tools,
    hitlResponses: config.hitlResponses,
    inputs: config.inputs,
    interactions: config.interactions,
    interactionHost: config.interactionHost,
    approvalPreviews: config.approvalPreviews,
    reasoningEffort: config.reasoningEffort,
    capabilities: config.capabilities,
    model: config.model
  }

  if (config.cacheKey !== undefined) {
    runConfig.cacheKey = config.cacheKey
  }

  if (config.instructions !== undefined) {
    runConfig.instructions = config.instructions
  }

  return runConfig
}

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

    return Match.value(stored.event).pipe(
      Match.tag('RunAwaitingInput', awaiting => awaiting.requests),
      Match.tag('RunCompleted', 'RunFailed', 'RunInterrupted', () => []),
      Match.tag('HitlResponseAppended', 'InputAppended', 'RunStarted', () => undefined),
      Match.exhaustive
    )
  }, undefined) ?? []

/**
 * The responses of the paused batch: those logged after the event that recorded the batch's
 * assistant message (the transcript's last assistant message: a pause ends the run right after
 * its batch). They include answers to earlier siblings of the batch (each answer resumes the same
 * batch until it settles), and never an answer to an earlier batch, even one settled inside the
 * same run without a run terminator, where a provider-reused call id would match it.
 */
const pausedBatchResponses = (log: RuntimeSessionEventLog): ReadonlyArray<HitlResponse> => {
  const transcript = replayRuntimeSessionEvents(log.events)

  return Option.match(
    Arr.findLastIndex(transcript, message => Predicate.isTagged(message, 'Assistant')),
    {
      onNone: () => [],
      onSome: batchMessage => {
        const counts = Arr.scan(
          log.events,
          0,
          (count, stored) => count + replayRuntimeSessionEvents([stored]).length
        ).slice(1)

        return Option.match(
          Arr.findFirstIndex(counts, count => count > batchMessage),
          {
            onNone: () => [],
            onSome: recorded => replayRuntimeHitlResponses(log.events.slice(recorded + 1))
          }
        )
      }
    }
  )
}

const hitlResponseMatchesRequest = (response: HitlResponse, request: HitlRequest) =>
  Match.value(response).pipe(
    Match.tag(
      'ToolApprovalResponse',
      approval =>
        Predicate.isTagged(request, 'ToolApprovalRequest') &&
        approval.requestId === request.requestId &&
        approval.toolCallId === request.toolCallId
    ),
    Match.tag(
      'QuestionResponse',
      answer =>
        Predicate.isTagged(request, 'QuestionRequest') &&
        answer.requestId === request.requestId &&
        answer.toolCallId === request.toolCallId
    ),
    Match.tag(
      'InputResponse',
      answer =>
        Predicate.isTagged(request, 'InputRequest') &&
        answer.requestId === request.requestId &&
        answer.toolCallId === request.toolCallId
    ),
    Match.tag(
      'InteractionResponse',
      answer =>
        Predicate.isTagged(request, 'InteractionRequest') &&
        answer.requestId === request.requestId &&
        answer.toolCallId === request.toolCallId
    ),
    Match.exhaustive
  )

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
          Match.value(event).pipe(
            Match.tag('AgentEnd', end =>
              store
                .append({
                  sessionId: request.sessionId,
                  expectedRevision: startedLog.revision,
                  events: [RunCompleted.make({ runId: request.runId, messages: end.messages })]
                })
                .pipe(Effect.asVoid)
            ),
            Match.tag('AgentAwaitingInput', awaiting =>
              store
                .append({
                  sessionId: request.sessionId,
                  expectedRevision: startedLog.revision,
                  events: [
                    RunAwaitingInput.make({
                      runId: request.runId,
                      requests: awaiting.requests,
                      messages: awaiting.messages
                    })
                  ]
                })
                .pipe(Effect.asVoid)
            ),
            Match.orElse(() => Effect.void)
          )
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
      const priorResponses = pausedBatchResponses(initialLog)
      const hitlResponses = [...priorResponses, request.response]

      // The pause being resumed binds its unanswered approval requests (see `prepareToolBatch`).
      const resumeConfig = {
        ...runtimeRunConfig({ ...config, hitlResponses }, messages),
        awaitingRequests: latestAwaitingRequests(initialLog)
      }

      return run(resumeConfig).pipe(
        Stream.tap(event =>
          Match.value(event).pipe(
            Match.tag('AgentEnd', end =>
              store
                .append({
                  sessionId: request.sessionId,
                  expectedRevision: startedLog.revision,
                  events: [RunCompleted.make({ runId: request.runId, messages: end.messages })]
                })
                .pipe(Effect.asVoid)
            ),
            Match.tag('AgentAwaitingInput', awaiting =>
              store
                .append({
                  sessionId: request.sessionId,
                  expectedRevision: startedLog.revision,
                  events: [
                    RunAwaitingInput.make({
                      runId: request.runId,
                      requests: awaiting.requests,
                      messages: awaiting.messages
                    })
                  ]
                })
                .pipe(Effect.asVoid)
            ),
            Match.orElse(() => Effect.void)
          )
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
  return Match.value(request).pipe(
    Match.withReturnType<Stream.Stream<AgentEvent, RuntimeErrorUnion, RuntimeRequirements>>(),
    Match.tagsExhaustive({
      Transcript: transcript => makeTranscriptRuntimeStream(transcript, config),
      AppendInput: appendInput => makeAppendInputRuntimeStream(appendInput, config),
      AppendHitlResponse: appendHitl => makeAppendHitlResponseRuntimeStream(appendHitl, config)
    })
  )
}
