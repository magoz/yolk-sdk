import { Effect, Ref, Stream } from 'effect'
import type { AgentMessage } from '@yolk-sdk/agent/protocol'
import {
  LLMProvider,
  type LLMEvent,
  type LLMProviderError,
  type LLMRequest
} from '@yolk-sdk/agent/loop'

export type ContextOverflowRetryCompactionResult =
  | {
      readonly _tag: 'Compacted'
      readonly messages: ReadonlyArray<AgentMessage>
    }
  | {
      readonly _tag: 'Skipped'
      readonly messages: ReadonlyArray<AgentMessage>
    }

export type OverflowCompactionDecision =
  | {
      readonly _tag: 'Compacted'
      readonly messages: ReadonlyArray<AgentMessage>
    }
  | {
      readonly _tag: 'Skipped'
    }

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

const llmEventStartsOutput = (event: LLMEvent) => {
  switch (event._tag) {
    case 'TextDelta':
    case 'ReasoningDelta':
    case 'ToolCall':
    case 'ToolInputStart':
    case 'ToolInputDelta':
    case 'ProviderToolResult':
      return true
    case 'Done':
    case 'Usage':
      return false
  }
}

export const applyOverflowCompaction = <E, R>(input: {
  readonly compact: (
    messages: ReadonlyArray<AgentMessage>
  ) => Effect.Effect<OverflowCompactionInput, E, R>
  readonly messages: ReadonlyArray<AgentMessage>
  readonly attempt: number
  readonly outputStarted: boolean
}): Effect.Effect<OverflowCompactionDecision, E, R> => {
  if (!overflowCompactionMayRun(input)) {
    return Effect.succeed({ _tag: 'Skipped' })
  }

  return input
    .compact(input.messages)
    .pipe(
      Effect.map(result =>
        result._tag === 'Compacted'
          ? { _tag: 'Compacted' as const, messages: result.messages }
          : { _tag: 'Skipped' as const }
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
            }).pipe(Effect.catch(() => Effect.succeed({ _tag: 'Skipped' as const })))

            yield* Ref.set(attempts, attempt + 1)

            if (decision._tag === 'Skipped') return Stream.fail(error)

            if (input.messagesRef !== undefined) {
              yield* Ref.set(input.messagesRef, decision.messages)
            }

            return input.provider
              .stream({ ...request, messages: decision.messages })
              .pipe(
                Stream.tap(event =>
                  llmEventStartsOutput(event) ? Ref.set(outputStarted, true) : Effect.void
                )
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
