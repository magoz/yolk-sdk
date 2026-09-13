import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { replaceLoneSurrogates } from '@yolk-sdk/agent/protocol'
import { VoiceSessionError } from '@yolk-sdk/agent/voice'
import type { VoiceClientCodec } from '@yolk-sdk/agent/voice'
import {
  OpenAiRealtimeClientEvent,
  OpenAiRealtimeConversationItemCreateEvent,
  OpenAiRealtimeFunctionCallOutputItem,
  OpenAiRealtimeResponseCreateEvent,
  type OpenAiRealtimeConversationItem,
  type OpenAiRealtimeConversationMessageItem
} from './events.ts'

export const makeOpenAiRealtimeUserMessageItem = (
  text: string
): OpenAiRealtimeConversationMessageItem => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }]
})

export const makeOpenAiRealtimeAssistantMessageItem = (
  text: string
): OpenAiRealtimeConversationMessageItem => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text }]
})

export const makeOpenAiRealtimeConversationItemCreateEvent = (
  item: OpenAiRealtimeConversationItem
) => OpenAiRealtimeConversationItemCreateEvent.make({ type: 'conversation.item.create', item })

export const makeOpenAiRealtimeFunctionCallOutputEvent = (callId: string, output: string) =>
  makeOpenAiRealtimeConversationItemCreateEvent(
    OpenAiRealtimeFunctionCallOutputItem.make({
      type: 'function_call_output',
      call_id: callId,
      output
    })
  )

export const makeOpenAiRealtimeResponseCreateEvent = () =>
  OpenAiRealtimeResponseCreateEvent.make({ type: 'response.create' })

const encodeClientEvent = Schema.encodeEffect(Schema.fromJsonString(OpenAiRealtimeClientEvent))

const encodeAll = (events: ReadonlyArray<OpenAiRealtimeClientEvent>) =>
  Effect.forEach(events, event => encodeClientEvent(event)).pipe(
    Effect.mapError(
      error =>
        new VoiceSessionError({
          code: 'protocol_error',
          message: `Could not encode OpenAI Realtime client event: ${error.message}`
        })
    )
  )

/**
 * OpenAI Realtime implementation of the provider-neutral voice client codec.
 * Tool outputs become `conversation.item.create` function outputs; response
 * turns are `response.create`; text seeds become conversation message items.
 */
export const openAiRealtimeVoiceClientCodec: VoiceClientCodec = {
  // Seeds/outputs can replay persisted transcripts; lone surrogates are
  // unencodable as UTF-8 and can break provider-side decoding, so harden
  // every outbound text payload.
  encodeToolOutput: (callId, output) =>
    encodeAll([makeOpenAiRealtimeFunctionCallOutputEvent(callId, replaceLoneSurrogates(output))]),
  encodeResponseTurn: () => encodeAll([makeOpenAiRealtimeResponseCreateEvent()]),
  encodeUserText: text =>
    encodeAll([
      makeOpenAiRealtimeConversationItemCreateEvent(
        makeOpenAiRealtimeUserMessageItem(replaceLoneSurrogates(text))
      )
    ]),
  encodeAssistantText: text =>
    encodeAll([
      makeOpenAiRealtimeConversationItemCreateEvent(
        makeOpenAiRealtimeAssistantMessageItem(replaceLoneSurrogates(text))
      )
    ])
}
