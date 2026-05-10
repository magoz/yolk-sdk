import { Option } from 'effect'
import * as Schema from 'effect/Schema'

const OpenAiRealtimeInputTextContent = Schema.Struct({
  type: Schema.Literals(['input_text']),
  text: Schema.String
})

const OpenAiRealtimeOutputTextContent = Schema.Struct({
  type: Schema.Literals(['output_text']),
  text: Schema.String
})

const OpenAiRealtimeUserMessageItem = Schema.Struct({
  type: Schema.Literals(['message']),
  role: Schema.Literals(['user']),
  content: Schema.Array(OpenAiRealtimeInputTextContent)
})

const OpenAiRealtimeAssistantMessageItem = Schema.Struct({
  type: Schema.Literals(['message']),
  role: Schema.Literals(['assistant']),
  content: Schema.Array(OpenAiRealtimeOutputTextContent)
})

export const OpenAiRealtimeConversationMessageItem = Schema.Union([
  OpenAiRealtimeUserMessageItem,
  OpenAiRealtimeAssistantMessageItem
])
export type OpenAiRealtimeConversationMessageItem =
  typeof OpenAiRealtimeConversationMessageItem.Type

export class OpenAiRealtimeFunctionCall extends Schema.Class<OpenAiRealtimeFunctionCall>(
  'OpenAiRealtimeFunctionCall'
)({
  callId: Schema.String,
  name: Schema.String,
  argumentsJson: Schema.String
}) {}

const OpenAiRealtimeFunctionCallItem = Schema.Struct({
  type: Schema.Literals(['function_call']),
  call_id: Schema.String,
  name: Schema.String,
  arguments: Schema.String
})

export class OpenAiRealtimeFunctionCallOutputItem extends Schema.Class<OpenAiRealtimeFunctionCallOutputItem>(
  'OpenAiRealtimeFunctionCallOutputItem'
)({
  type: Schema.Literals(['function_call_output']),
  call_id: Schema.String,
  output: Schema.String
}) {}

const OpenAiRealtimeConversationItem = Schema.Union([
  OpenAiRealtimeConversationMessageItem,
  OpenAiRealtimeFunctionCallOutputItem
])

export class OpenAiRealtimeConversationItemCreateEvent extends Schema.Class<OpenAiRealtimeConversationItemCreateEvent>(
  'OpenAiRealtimeConversationItemCreateEvent'
)({
  type: Schema.Literals(['conversation.item.create']),
  item: OpenAiRealtimeConversationItem
}) {}

export class OpenAiRealtimeResponseCreateEvent extends Schema.Class<OpenAiRealtimeResponseCreateEvent>(
  'OpenAiRealtimeResponseCreateEvent'
)({
  type: Schema.Literals(['response.create'])
}) {}

export const OpenAiRealtimeClientEvent = Schema.Union([
  OpenAiRealtimeConversationItemCreateEvent,
  OpenAiRealtimeResponseCreateEvent
])
export type OpenAiRealtimeClientEvent = typeof OpenAiRealtimeClientEvent.Type

const OpenAiRealtimeResponseDoneEvent = Schema.Struct({
  type: Schema.Literals(['response.done']),
  response_id: Schema.optional(Schema.String),
  response: Schema.Struct({
    id: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
    output: Schema.Array(Schema.Unknown)
  })
})

const OpenAiRealtimeInputAudioTranscriptionDeltaEvent = Schema.Struct({
  type: Schema.Literals(['conversation.item.input_audio_transcription.delta']),
  item_id: Schema.optional(Schema.String),
  delta: Schema.String
})

const OpenAiRealtimeInputAudioTranscriptionCompletedEvent = Schema.Struct({
  type: Schema.Literals(['conversation.item.input_audio_transcription.completed']),
  item_id: Schema.optional(Schema.String),
  transcript: Schema.String
})

const OpenAiRealtimeOutputAudioTranscriptDeltaEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(['response.output_audio_transcript.delta']),
    item_id: Schema.optional(Schema.String),
    response_id: Schema.optional(Schema.String),
    delta: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literals(['response.audio_transcript.delta']),
    item_id: Schema.optional(Schema.String),
    response_id: Schema.optional(Schema.String),
    delta: Schema.String
  })
])

const OpenAiRealtimeOutputAudioTranscriptDoneEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(['response.output_audio_transcript.done']),
    item_id: Schema.optional(Schema.String),
    response_id: Schema.optional(Schema.String),
    transcript: Schema.optional(Schema.String)
  }),
  Schema.Struct({
    type: Schema.Literals(['response.audio_transcript.done']),
    item_id: Schema.optional(Schema.String),
    response_id: Schema.optional(Schema.String),
    transcript: Schema.optional(Schema.String)
  })
])

const OpenAiRealtimeSessionConfigEvent = Schema.Struct({
  type: Schema.String,
  session: Schema.Struct({
    model: Schema.optional(Schema.String),
    audio: Schema.optional(
      Schema.Struct({
        input: Schema.optional(
          Schema.Struct({
            transcription: Schema.optional(
              Schema.Struct({
                model: Schema.optional(Schema.String),
                language: Schema.optional(Schema.String)
              })
            )
          })
        )
      })
    )
  })
})

const OpenAiRealtimeErrorEvent = Schema.Struct({
  type: Schema.Literals(['error']),
  error: Schema.Struct({
    message: Schema.String
  })
})

export const OpenAiRealtimeToolExecutionResponse = Schema.Struct({
  event: OpenAiRealtimeConversationItemCreateEvent
})
export type OpenAiRealtimeToolExecutionResponse = typeof OpenAiRealtimeToolExecutionResponse.Type

export class OpenAiRealtimeInputAudioTranscriptionDelta extends Schema.TaggedClass<OpenAiRealtimeInputAudioTranscriptionDelta>()(
  'InputAudioTranscriptionDelta',
  { itemId: Schema.NullOr(Schema.String), delta: Schema.String }
) {}

export class OpenAiRealtimeInputAudioTranscriptionCompleted extends Schema.TaggedClass<OpenAiRealtimeInputAudioTranscriptionCompleted>()(
  'InputAudioTranscriptionCompleted',
  { itemId: Schema.NullOr(Schema.String), transcript: Schema.String }
) {}

export class OpenAiRealtimeOutputAudioTranscriptDelta extends Schema.TaggedClass<OpenAiRealtimeOutputAudioTranscriptDelta>()(
  'OutputAudioTranscriptDelta',
  {
    itemId: Schema.NullOr(Schema.String),
    responseId: Schema.NullOr(Schema.String),
    delta: Schema.String
  }
) {}

export class OpenAiRealtimeOutputAudioTranscriptDone extends Schema.TaggedClass<OpenAiRealtimeOutputAudioTranscriptDone>()(
  'OutputAudioTranscriptDone',
  {
    itemId: Schema.NullOr(Schema.String),
    responseId: Schema.NullOr(Schema.String),
    transcript: Schema.NullOr(Schema.String)
  }
) {}

export class OpenAiRealtimeSessionConfigured extends Schema.TaggedClass<OpenAiRealtimeSessionConfigured>()(
  'SessionConfigured',
  {
    eventType: Schema.String,
    model: Schema.NullOr(Schema.String),
    transcriptionModel: Schema.NullOr(Schema.String),
    transcriptionLanguage: Schema.NullOr(Schema.String)
  }
) {}

export class OpenAiRealtimeResponseDone extends Schema.TaggedClass<OpenAiRealtimeResponseDone>()(
  'ResponseDone',
  {
    responseId: Schema.NullOr(Schema.String),
    status: Schema.NullOr(Schema.String)
  }
) {}

export class OpenAiRealtimeFunctionCalls extends Schema.TaggedClass<OpenAiRealtimeFunctionCalls>()(
  'FunctionCalls',
  { calls: Schema.Array(OpenAiRealtimeFunctionCall) }
) {}

export class OpenAiRealtimeError extends Schema.TaggedClass<OpenAiRealtimeError>()('Error', {
  message: Schema.String
}) {}

export class OpenAiRealtimeIgnored extends Schema.TaggedClass<OpenAiRealtimeIgnored>()('Ignored', {}) {}

export const OpenAiRealtimeServerEvent = Schema.Union([
  OpenAiRealtimeInputAudioTranscriptionDelta,
  OpenAiRealtimeInputAudioTranscriptionCompleted,
  OpenAiRealtimeOutputAudioTranscriptDelta,
  OpenAiRealtimeOutputAudioTranscriptDone,
  OpenAiRealtimeSessionConfigured,
  OpenAiRealtimeResponseDone,
  OpenAiRealtimeFunctionCalls,
  OpenAiRealtimeError,
  OpenAiRealtimeIgnored
])
export type OpenAiRealtimeServerEvent = typeof OpenAiRealtimeServerEvent.Type

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
  item: typeof OpenAiRealtimeConversationItem.Type
) => OpenAiRealtimeConversationItemCreateEvent.make({ type: 'conversation.item.create', item })

export const makeOpenAiRealtimeFunctionCallOutputEvent = (
  callId: string,
  output: string
) =>
  makeOpenAiRealtimeConversationItemCreateEvent(
    OpenAiRealtimeFunctionCallOutputItem.make({
      type: 'function_call_output',
      call_id: callId,
      output
    })
  )

export const makeOpenAiRealtimeResponseCreateEvent = () =>
  OpenAiRealtimeResponseCreateEvent.make({ type: 'response.create' })

export const decodeOpenAiRealtimeToolExecutionResponse =
  Schema.decodeUnknownOption(OpenAiRealtimeToolExecutionResponse)

export const readOpenAiRealtimeToolOutput = (
  event: OpenAiRealtimeConversationItemCreateEvent
) => {
  const item = event.item

  return item.type === 'function_call_output' ? item.output : 'Tool output sent'
}

const decodeFunctionCallItem = Schema.decodeUnknownOption(OpenAiRealtimeFunctionCallItem)

const readFunctionCalls = (value: unknown): ReadonlyArray<OpenAiRealtimeFunctionCall> => {
  const decoded = Schema.decodeUnknownOption(OpenAiRealtimeResponseDoneEvent)(value)

  if (Option.isNone(decoded)) {
    return []
  }

  return decoded.value.response.output.flatMap(item => {
    const call = decodeFunctionCallItem(item)

    if (Option.isNone(call)) {
      return []
    }

    return [
      OpenAiRealtimeFunctionCall.make({
        callId: call.value.call_id,
        name: call.value.name,
        argumentsJson: call.value.arguments
      })
    ]
  })
}

const decodeJsonString = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

const isSessionConfigEventType = (eventType: string) =>
  eventType === 'session.created' || eventType === 'session.updated'

export const decodeOpenAiRealtimeServerEvent = (raw: string): OpenAiRealtimeServerEvent => {
  const value = decodeJsonString(raw)

  if (Option.isNone(value)) {
    return OpenAiRealtimeIgnored.make({})
  }

  const sessionConfig = Schema.decodeUnknownOption(OpenAiRealtimeSessionConfigEvent)(value.value)

  if (Option.isSome(sessionConfig) && isSessionConfigEventType(sessionConfig.value.type)) {
    const input = sessionConfig.value.session.audio?.input
    const transcription = input?.transcription

    return OpenAiRealtimeSessionConfigured.make({
      eventType: sessionConfig.value.type,
      model: sessionConfig.value.session.model ?? null,
      transcriptionModel: transcription?.model ?? null,
      transcriptionLanguage: transcription?.language ?? null
    })
  }

  const inputDelta = Schema.decodeUnknownOption(OpenAiRealtimeInputAudioTranscriptionDeltaEvent)(
    value.value
  )

  if (Option.isSome(inputDelta)) {
    return OpenAiRealtimeInputAudioTranscriptionDelta.make({
      itemId: inputDelta.value.item_id ?? null,
      delta: inputDelta.value.delta
    })
  }

  const inputCompleted = Schema.decodeUnknownOption(OpenAiRealtimeInputAudioTranscriptionCompletedEvent)(
    value.value
  )

  if (Option.isSome(inputCompleted)) {
    return OpenAiRealtimeInputAudioTranscriptionCompleted.make({
      itemId: inputCompleted.value.item_id ?? null,
      transcript: inputCompleted.value.transcript
    })
  }

  const outputDelta = Schema.decodeUnknownOption(OpenAiRealtimeOutputAudioTranscriptDeltaEvent)(
    value.value
  )

  if (Option.isSome(outputDelta)) {
    return OpenAiRealtimeOutputAudioTranscriptDelta.make({
      itemId: outputDelta.value.item_id ?? null,
      responseId: outputDelta.value.response_id ?? null,
      delta: outputDelta.value.delta
    })
  }

  const outputDone = Schema.decodeUnknownOption(OpenAiRealtimeOutputAudioTranscriptDoneEvent)(
    value.value
  )

  if (Option.isSome(outputDone)) {
    return OpenAiRealtimeOutputAudioTranscriptDone.make({
      itemId: outputDone.value.item_id ?? null,
      responseId: outputDone.value.response_id ?? null,
      transcript: outputDone.value.transcript ?? null
    })
  }

  const calls = readFunctionCalls(value.value)

  if (calls.length > 0) {
    return OpenAiRealtimeFunctionCalls.make({ calls })
  }

  const responseDone = Schema.decodeUnknownOption(OpenAiRealtimeResponseDoneEvent)(value.value)

  if (Option.isSome(responseDone)) {
    return OpenAiRealtimeResponseDone.make({
      responseId: responseDone.value.response.id ?? responseDone.value.response_id ?? null,
      status: responseDone.value.response.status ?? null
    })
  }

  const error = Schema.decodeUnknownOption(OpenAiRealtimeErrorEvent)(value.value)

  if (Option.isSome(error)) {
    return OpenAiRealtimeError.make({ message: error.value.error.message })
  }

  return OpenAiRealtimeIgnored.make({})
}
