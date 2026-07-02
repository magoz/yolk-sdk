import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { VoiceSessionError } from '@yolk-sdk/agent/voice'
import type { VoiceClientCodec } from '@yolk-sdk/agent/voice'
import {
  makeOpenAiRealtimeAssistantMessageItem,
  makeOpenAiRealtimeConversationItemCreateEvent,
  makeOpenAiRealtimeFunctionCallOutputEvent,
  makeOpenAiRealtimeResponseCreateEvent,
  OpenAiRealtimeClientEvent
} from './events.ts'
import { makeOpenAiRealtimeUserMessageItem } from './events.ts'

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
  encodeToolOutput: (callId, output) =>
    encodeAll([makeOpenAiRealtimeFunctionCallOutputEvent(callId, output)]),
  encodeResponseTurn: () => encodeAll([makeOpenAiRealtimeResponseCreateEvent()]),
  encodeUserText: text =>
    encodeAll([
      makeOpenAiRealtimeConversationItemCreateEvent(makeOpenAiRealtimeUserMessageItem(text))
    ]),
  encodeAssistantText: text =>
    encodeAll([
      makeOpenAiRealtimeConversationItemCreateEvent(makeOpenAiRealtimeAssistantMessageItem(text))
    ])
}
