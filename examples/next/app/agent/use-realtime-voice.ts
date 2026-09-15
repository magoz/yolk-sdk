'use client'

import { useCallback, useEffect, useMemo, useRef, type Ref } from 'react'
import { Data, Effect, Match, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse
} from 'effect/unstable/http'
import {
  AgentEnd,
  AssistantMessageEvent,
  LLMTextDelta,
  type ToolCall,
  ToolExecutionCompleted,
  ToolExecutionStarted,
  ToolInputEnd,
  ToolResult,
  UserMessage,
  zeroAgentUsage,
  type AgentEvent,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'
import {
  emptyVoiceProjectionState,
  projectVoiceEvent,
  protocolToolCallFromVoice,
  VoiceSessionError,
  VoiceSessionToolCallRequest,
  VoiceToolCallOutcome,
  voiceSeedTextsFromMessages,
  type VoiceEvent,
  type VoiceProjectionState,
  type VoiceToolCall
} from '@yolk-sdk/agent/voice'
import { useYolkVoice } from '@yolk-sdk/agent/voice/react'
import {
  decodeOpenAiRealtimeServerEvent,
  openAiRealtimeServerEventToVoiceEvents,
  openAiRealtimeVoiceClientCodec
} from '@yolk-sdk/agent/providers/openai/realtime'
import type { ToolApprovalResponse } from '@yolk-sdk/agent/protocol'
import type { OpenAiRealtimeTranscriptionModel } from '@/lib/agents/realtime/openai-realtime'

export type VoiceStatus = 'idle' | 'connecting' | 'live' | 'error'

export type VoiceDebugEvent = Data.TaggedEnum<{
  readonly SessionConfigured: {
    readonly eventType: string
    readonly model: string | null
    readonly transcriptionModel: string | null
    readonly transcriptionLanguage: string | null
  }
  readonly InputTranscript: {
    readonly itemId: string | null
    readonly transcript: string
  }
  readonly OutputTranscript: {
    readonly itemId: string | null
    readonly responseId: string | null
    readonly transcript: string
  }
}>

export const VoiceDebugEvent = Data.taggedEnum<VoiceDebugEvent>()

type UseRealtimeVoiceInput = {
  readonly sessionId: string
  readonly messages: ReadonlyArray<AgentMessage>
  readonly transcriptionModel: OpenAiRealtimeTranscriptionModel
  readonly onAgentEvent: (event: AgentEvent) => void
  readonly onUserMessage: (message: UserMessage) => void
  readonly onError: (message: string) => void
  readonly onDebug: (event: VoiceDebugEvent) => void
}

const toBrowserHttpError = (message: string) => (error: HttpClientError.HttpClientError) =>
  new VoiceSessionError({ code: 'transport_failed', message: `${message}: ${error.message}` })

const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.String }))
)

// Route error bodies are `{ "error": "..." }`; show the message, not raw JSON.
const errorBodyMessage = (body: string, status: number) => {
  if (body.length === 0) {
    return `Request failed with ${status}`
  }

  return Option.match(decodeErrorBody(body), {
    onNone: () => body,
    onSome: decoded => decoded.error
  })
}

const responseErrorMessageEffect = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.mapError(toBrowserHttpError('Could not read response body')),
    Effect.map(body => errorBodyMessage(body, response.status))
  )

const ensureOkResponse = (response: HttpClientResponse.HttpClientResponse) => {
  if (response.status >= 200 && response.status < 300) {
    return Effect.succeed(response)
  }

  return responseErrorMessageEffect(response).pipe(
    Effect.flatMap(message =>
      Effect.fail(new VoiceSessionError({ code: 'session_setup_failed', message }))
    )
  )
}

const realtimeCallUrl = (transcriptionModel: OpenAiRealtimeTranscriptionModel) => {
  const params = new URLSearchParams({ transcriptionModel })

  return `/api/agent/realtime/call?${params.toString()}`
}

const negotiateRealtimeSdp = (
  offerSdp: string,
  transcriptionModel: OpenAiRealtimeTranscriptionModel
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient

    const request = HttpClientRequest.post(realtimeCallUrl(transcriptionModel)).pipe(
      HttpClientRequest.setHeaders({
        accept: 'application/sdp',
        'content-type': 'application/sdp'
      }),
      HttpClientRequest.bodyText(offerSdp, 'application/sdp')
    )

    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(toBrowserHttpError('Realtime call request failed')))

    const okResponse = yield* ensureOkResponse(response)

    return yield* okResponse.text.pipe(
      Effect.mapError(toBrowserHttpError('Could not read Realtime SDP response'))
    )
  }).pipe(Effect.provide(FetchHttpClient.layer))

const encodeToolCallBody = Schema.encodeEffect(Schema.fromJsonString(VoiceSessionToolCallRequest))

const decodeToolCallOutcome = Schema.decodeUnknownEffect(VoiceToolCallOutcome)

const executeVoiceToolCallOnServer = (
  sessionId: string,
  call: VoiceToolCall,
  approval?: ToolApprovalResponse
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient

    const requestFields =
      approval === undefined
        ? {
            sessionId,
            callId: call.callId,
            name: call.name,
            argumentsJson: call.argumentsJson
          }
        : {
            sessionId,
            callId: call.callId,
            name: call.name,
            argumentsJson: call.argumentsJson,
            approval
          }

    const body = yield* encodeToolCallBody(VoiceSessionToolCallRequest.make(requestFields))

    const request = HttpClientRequest.post('/api/agent/realtime/tool').pipe(
      HttpClientRequest.setHeaders({
        accept: 'application/json',
        'content-type': 'application/json'
      }),
      HttpClientRequest.bodyText(body, 'application/json')
    )

    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(toBrowserHttpError('Realtime tool request failed')))

    const okResponse = yield* ensureOkResponse(response)

    const payload = yield* okResponse.json.pipe(
      Effect.mapError(toBrowserHttpError('Could not parse Realtime tool response'))
    )

    return yield* decodeToolCallOutcome(payload)
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.catchTag('SchemaError', error =>
      Effect.fail(
        new VoiceSessionError({
          code: 'protocol_error',
          message: `Invalid Realtime tool payload: ${error.message}`
        })
      )
    )
  )

const decodeVoiceMessage = (raw: string): ReadonlyArray<VoiceEvent> =>
  openAiRealtimeServerEventToVoiceEvents(decodeOpenAiRealtimeServerEvent(raw))

const assistantEndEvent = (messages: ReadonlyArray<AgentMessage>) =>
  AgentEnd.make({ messages, turns: 1, usage: zeroAgentUsage })

/**
 * App adapter over the package voice hook. Owns app UX policy: buffering
 * assistant events until the pending user transcript lands, projecting voice
 * events into chat `AgentEvent`s, and console debug rows. Transport,
 * controller, tool forwarding, and HITL live in `@yolk-sdk/agent/voice`.
 */
export const useRealtimeVoice = ({
  sessionId,
  messages,
  transcriptionModel,
  onAgentEvent,
  onUserMessage,
  onError,
  onDebug
}: UseRealtimeVoiceInput) => {
  const projectionRef = useRef<VoiceProjectionState>(emptyVoiceProjectionState)
  const toolCallsRef = useRef<ReadonlyMap<string, ToolCall>>(new Map())
  const inputPendingRef = useRef(false)
  const bufferedEventsRef = useRef<ReadonlyArray<AgentEvent>>([])
  const callbacksRef = useRef({ onAgentEvent, onUserMessage, onError, onDebug })
  const messagesRef = useRef(messages)

  useEffect(() => {
    callbacksRef.current = { onAgentEvent, onUserMessage, onError, onDebug }
  }, [onAgentEvent, onUserMessage, onError, onDebug])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const emitAgentEvent = useCallback((event: AgentEvent) => {
    if (!inputPendingRef.current) {
      callbacksRef.current.onAgentEvent(event)

      return
    }

    bufferedEventsRef.current = [...bufferedEventsRef.current, event]
  }, [])

  const flushBufferedEvents = useCallback(() => {
    const events = bufferedEventsRef.current
    bufferedEventsRef.current = []

    for (const event of events) {
      callbacksRef.current.onAgentEvent(event)
    }
  }, [])

  const project = useCallback((event: VoiceEvent) => {
    const result = projectVoiceEvent(projectionRef.current, event)
    projectionRef.current = result.state

    return result.messages
  }, [])

  // Projected assistant messages replace their streamed bubble
  // deterministically (`AssistantMessage` -> appendOrReplace), instead of
  // relying on the `AgentEnd` fallback append whose ordering guard breaks
  // under realtime races (late user transcripts, double final event
  // families, back-to-back responses) and produced duplicated messages.
  const emitProjectedAssistantMessages = useCallback(
    (projected: ReadonlyArray<AgentMessage>) => {
      for (const message of projected) {
        if (Predicate.isTagged(message, 'Assistant')) {
          emitAgentEvent(AssistantMessageEvent.make({ message }))
        }
      }
    },
    [emitAgentEvent]
  )

  const handleVoiceEvent = useCallback(
    (event: VoiceEvent) => {
      Match.value(event).pipe(
        Match.tag('SessionOpened', current => {
          callbacksRef.current.onDebug(
            VoiceDebugEvent.SessionConfigured({
              eventType: 'session',
              model: current.model,
              transcriptionModel: current.transcriptionModel ?? null,
              transcriptionLanguage: current.transcriptionLanguage ?? null
            })
          )
        }),
        Match.tag('UserTranscriptDelta', () => {
          inputPendingRef.current = true
        }),
        Match.tag('UserTranscriptFinal', current => {
          inputPendingRef.current = false
          callbacksRef.current.onDebug(
            VoiceDebugEvent.InputTranscript({
              itemId: current.itemId,
              transcript: current.text
            })
          )
          callbacksRef.current.onUserMessage(UserMessage.make({ content: current.text }))
          flushBufferedEvents()
        }),
        Match.tag('AssistantTranscriptDelta', current => {
          const projected = project(current)
          emitProjectedAssistantMessages(projected)
          emitAgentEvent(LLMTextDelta.make({ text: current.delta }))
        }),
        Match.tag('AssistantTranscriptFinal', current => {
          callbacksRef.current.onDebug(
            VoiceDebugEvent.OutputTranscript({
              itemId: current.itemId,
              responseId: current.responseId,
              transcript: current.text ?? ''
            })
          )
          const projected = project(current)
          emitProjectedAssistantMessages(projected)

          if (projected.length > 0) {
            emitAgentEvent(assistantEndEvent(projected))
          }
        }),
        Match.tag('Interrupted', 'SessionClosed', current => {
          const projected = project(current)
          emitProjectedAssistantMessages(projected)

          if (projected.length > 0) {
            emitAgentEvent(assistantEndEvent(projected))
          }
        }),
        Match.tag('ToolCallsRequested', current => {
          project(current)

          const calls = new Map(toolCallsRef.current)

          for (const voiceCall of current.calls) {
            const call = protocolToolCallFromVoice(voiceCall)
            calls.set(voiceCall.callId, call)
            emitAgentEvent(ToolInputEnd.make({ call }))
            emitAgentEvent(ToolExecutionStarted.make({ call }))
          }

          toolCallsRef.current = calls
        }),
        Match.tag('ToolCallCompleted', current => {
          project(current)

          const call = toolCallsRef.current.get(current.callId)

          if (call !== undefined) {
            emitAgentEvent(
              ToolExecutionCompleted.make({
                call,
                result: ToolResult.make({ toolCallId: current.callId, content: current.output })
              })
            )
          }
        }),
        Match.tag('ToolCallFailed', current => {
          project(current)

          const call = toolCallsRef.current.get(current.callId)

          if (call !== undefined) {
            emitAgentEvent(
              ToolExecutionCompleted.make({
                call,
                result: ToolResult.make({
                  toolCallId: current.callId,
                  content: current.message,
                  isError: true
                })
              })
            )
          }
        }),
        Match.orElse(() => undefined)
      )
    },
    [emitAgentEvent, emitProjectedAssistantMessages, flushBufferedEvents, project]
  )

  const voice = useYolkVoice({
    negotiate: offerSdp => negotiateRealtimeSdp(offerSdp, transcriptionModel),
    executeToolCall: (call, approval) => executeVoiceToolCallOnServer(sessionId, call, approval),
    codec: openAiRealtimeVoiceClientCodec,
    decodeMessage: decodeVoiceMessage,
    dataChannelLabel: 'oai-events',
    seeds: () => voiceSeedTextsFromMessages(messagesRef.current),
    onEvent: handleVoiceEvent,
    onError: error => callbacksRef.current.onError(error.message)
  })

  const startSession = voice.start

  const stopSession = useCallback(() => {
    projectionRef.current = emptyVoiceProjectionState
    toolCallsRef.current = new Map()
    inputPendingRef.current = false
    bufferedEventsRef.current = []
    voice.stop()
  }, [voice])

  const toggleSession = useCallback(() => {
    if (voice.isConnecting || voice.isLive) {
      stopSession()

      return
    }

    startSession()
  }, [startSession, stopSession, voice.isConnecting, voice.isLive])

  const audioRef: Ref<HTMLAudioElement> = useMemo(
    () => voice.attachAudioElement,
    [voice.attachAudioElement]
  )

  return {
    audioRef,
    status: voice.status,
    userDraft: voice.userDraft,
    isConnecting: voice.isConnecting,
    isLive: voice.isLive,
    startSession,
    stopSession,
    toggleSession
  }
}
