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

const contextOverflowRetryStream = (
  input: ContextOverflowRetryProviderInput,
  retried: Ref.Ref<boolean>,
  request: LLMRequest
) =>
  input.provider.stream(request).pipe(
    Stream.catchTags({
      LLMError: error => {
        if (error.cause !== 'context_overflow') return Stream.fail(error)

        return Stream.unwrap(
          Ref.get(retried).pipe(
            Effect.flatMap(alreadyRetried => {
              if (alreadyRetried) return Effect.succeed(Stream.fail(error))

              return Ref.set(retried, true).pipe(
                Effect.flatMap(() => input.compact(request.messages)),
                Effect.flatMap(result => {
                  if (result._tag === 'Skipped') return Effect.succeed(Stream.fail(error))

                  const setMessages =
                    input.messagesRef === undefined
                      ? Effect.void
                      : Ref.set(input.messagesRef, result.messages)

                  return setMessages.pipe(
                    Effect.as(input.provider.stream({ ...request, messages: result.messages }))
                  )
                }),
                Effect.catch(() => Effect.succeed(Stream.fail(error)))
              )
            })
          )
        )
      }
    })
  )

export const makeContextOverflowRetryProvider = (input: ContextOverflowRetryProviderInput) =>
  Effect.succeed(
    LLMProvider.of({
      stream: request =>
        Stream.unwrap(
          Ref.make(false).pipe(
            Effect.map(retried => contextOverflowRetryStream(input, retried, request))
          )
        )
    })
  )
