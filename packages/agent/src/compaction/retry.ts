import { Data, Effect, Match, Ref, Stream } from 'effect'
import type { AgentMessage } from '@yolk-sdk/agent/protocol'
import {
  LLMProvider,
  type LLMEvent,
  type LLMProviderError,
  type LLMRequest
} from '@yolk-sdk/agent/loop'

export type ContextOverflowRetryCompactionResult = Data.TaggedEnum<{
  Compacted: {
    readonly messages: ReadonlyArray<AgentMessage>
  }
  Skipped: {
    readonly messages: ReadonlyArray<AgentMessage>
  }
}>

export const ContextOverflowRetryCompactionResult =
  Data.taggedEnum<ContextOverflowRetryCompactionResult>()

export type OverflowCompactionDecision =
  | {
      readonly _tag: 'Compacted'
      readonly messages: ReadonlyArray<AgentMessage>
    }
  | {
      readonly _tag: 'Skipped'
    }

export const OverflowCompactionDecision = Data.taggedEnum<OverflowCompactionDecision>()

export type ContextOverflowRetryCompactor = (
  messages: ReadonlyArray<AgentMessage>
) => Effect.Effect<ContextOverflowRetryCompactionResult, unknown>

export type ContextOverflowRetryProviderInput = {
  readonly provider: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMProviderError>
  }
  readonly messagesRef?: Ref.Ref<ReadonlyArray<AgentMessage>>
  readonly compact: ContextOverflowRetryCompactor
}

type OverflowCompactionInput = ContextOverflowRetryCompactionResult | OverflowCompactionDecision

/** Durable persist-then-retry and in-process silent retry both compact at most once. */
export const overflowCompactionMaxAttempts = 1

export const isOverflowCompactionAttemptCount = (attempt: number) =>
  Number.isSafeInteger(attempt) && attempt >= 0

export const overflowCompactionAttemptAllowed = (attempt: number) =>
  isOverflowCompactionAttemptCount(attempt) && attempt < overflowCompactionMaxAttempts

export const overflowCompactionMayRun = (input: {
  readonly attempt: number
  readonly outputStarted: boolean
}) => overflowCompactionAttemptAllowed(input.attempt) && !input.outputStarted

const llmEventStartsOutput = (event: LLMEvent) =>
  Match.value(event).pipe(
    Match.tag(
      'TextDelta',
      'ReasoningDelta',
      'ToolCall',
      'ToolInputStart',
      'ToolInputDelta',
      'ProviderToolResult',
      () => true
    ),
    Match.tag('Done', 'Usage', () => false),
    Match.exhaustive
  )

export const applyOverflowCompaction = <E, R>(input: {
  readonly compact: (
    messages: ReadonlyArray<AgentMessage>
  ) => Effect.Effect<OverflowCompactionInput, E, R>
  readonly messages: ReadonlyArray<AgentMessage>
  readonly attempt: number
  readonly outputStarted: boolean
}): Effect.Effect<OverflowCompactionDecision, E, R> => {
  if (!overflowCompactionMayRun(input)) {
    return Effect.succeed(OverflowCompactionDecision.Skipped())
  }

  return input.compact(input.messages).pipe(
    Effect.map(result =>
      Match.value(result).pipe(
        Match.tag('Compacted', current =>
          OverflowCompactionDecision.Compacted({
            messages: current.messages
          })
        ),
        Match.tag('Skipped', () => OverflowCompactionDecision.Skipped()),
        Match.exhaustive
      )
    )
  )
}

const contextOverflowRetryStream = (
  input: ContextOverflowRetryProviderInput,
  attempts: Ref.Ref<number>,
  outputStarted: Ref.Ref<boolean>,
  request: LLMRequest
) =>
  input.provider.stream(request).pipe(
    Stream.tap(event => (llmEventStartsOutput(event) ? Ref.set(outputStarted, true) : Effect.void)),
    Stream.catchTags({
      LLMError: error => {
        if (error.cause !== 'context_overflow') return Stream.fail(error)

        return Stream.unwrap(
          Effect.gen(function* () {
            const attempt = yield* Ref.get(attempts)
            const started = yield* Ref.get(outputStarted)

            const decision = yield* applyOverflowCompaction({
              compact: input.compact,
              messages: request.messages,
              attempt,
              outputStarted: started
            }).pipe(Effect.catch(() => Effect.succeed(OverflowCompactionDecision.Skipped())))

            yield* Ref.set(attempts, attempt + 1)

            return yield* Match.value(decision).pipe(
              Match.tag('Skipped', () => Effect.succeed(Stream.fail(error))),
              Match.tag('Compacted', current =>
                Effect.gen(function* () {
                  if (input.messagesRef !== undefined) {
                    yield* Ref.set(input.messagesRef, current.messages)
                  }

                  return input.provider
                    .stream({ ...request, messages: current.messages })
                    .pipe(
                      Stream.tap(event =>
                        llmEventStartsOutput(event) ? Ref.set(outputStarted, true) : Effect.void
                      )
                    )
                })
              ),
              Match.exhaustive
            )
          })
        )
      }
    })
  )

export const makeContextOverflowRetryProvider = (input: ContextOverflowRetryProviderInput) =>
  Effect.succeed(
    LLMProvider.of({
      stream: request =>
        Stream.unwrap(
          Effect.gen(function* () {
            const attempts = yield* Ref.make(0)
            const outputStarted = yield* Ref.make(false)

            return contextOverflowRetryStream(input, attempts, outputStarted, request)
          })
        )
    })
  )
