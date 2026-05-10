import { Effect, Layer, Ref, Stream } from 'effect'
import { ToolCall } from '@yolk/protocol'
import { FauxExhaustedError } from '../error'
import {
  LLMDone,
  LLMReasoningDelta,
  LLMTextDelta,
  LLMToolCall,
  type LLMEvent
} from '../llm-event'
import { LLMProvider, type LLMRequest } from '../services/llm-provider'

export type FauxResponse = {
  readonly events: ReadonlyArray<LLMEvent>
}

export const Reply = {
  text: (text: string): FauxResponse => ({
    events: [
      ...text.split('').map(character => LLMTextDelta.make({ text: character })),
      LLMDone.make({ stopReason: 'stop' })
    ]
  }),
  reasoningText: (reasoning: string, text: string): FauxResponse => ({
    events: [
      LLMReasoningDelta.make({ text: reasoning }),
      ...text.split('').map(character => LLMTextDelta.make({ text: character })),
      LLMDone.make({ stopReason: 'stop' })
    ]
  }),
  toolCall: (input: { readonly id: string; readonly name: string; readonly params: unknown }): FauxResponse => ({
    events: [
      LLMToolCall.make({
        call: ToolCall.make({ id: input.id, name: input.name, params: input.params })
      }),
      LLMDone.make({ stopReason: 'tool_use' })
    ]
  })
}

const takeResponse = (responses: Ref.Ref<ReadonlyArray<FauxResponse>>) =>
  Effect.gen(function* () {
    const current = yield* Ref.get(responses)
    const response = current[0]

    if (response === undefined) {
      return yield* Effect.fail(
        new FauxExhaustedError({ message: 'No more faux responses queued' })
      )
    }

    yield* Ref.set(responses, current.slice(1))
    return response
  })

export const FauxProvider = {
  layer: (...initialResponses: ReadonlyArray<FauxResponse>) =>
    FauxProvider.layerWithRequests({ responses: initialResponses, requests: [] }),
  layerWithRequests: (input: {
    readonly responses: ReadonlyArray<FauxResponse>
    readonly requests: Array<LLMRequest>
  }) =>
    Layer.effect(
      LLMProvider,
      Effect.gen(function* () {
        const responses = yield* Ref.make(input.responses)

        return LLMProvider.of({
          stream: request => {
            input.requests.push(request)
            return Stream.fromEffect(takeResponse(responses)).pipe(
              Stream.flatMap(response => Stream.fromIterable(response.events))
            )
          }
        })
      })
    )
}
