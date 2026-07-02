'use client'

import { useCallback, useEffect, useMemo, useRef, type Ref } from 'react'
import { Effect } from 'effect'
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

export type VoiceDebugEvent =
  | {
      readonly _tag: 'SessionConfigured'
      readonly eventType: string
      readonly model: string | null
      readonly transcriptionModel: string | null
      readonly transcriptionLanguage: string | null
    }
  | {
      readonly _tag: 'InputTranscript'
      readonly itemId: string | null
      readonly transcript: string
    }
  | {
      readonly _tag: 'OutputTranscript'
      readonly itemId: string | null
      readonly responseId: string | null
      readonly transcript: string
    }

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

const responseErrorMessageEffect = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.mapError(toBrowserHttpError('Could not read response body')),
    Effect.map(body => (body.length > 0 ? body : `Request failed with ${response.status}`))
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
    const body = yield* encodeToolCallBody(
      VoiceSessionToolCallRequest.make({
        sessionId,
        callId: call.callId,
        name: call.name,
        argumentsJson: call.argumentsJson,
        ...(approval === undefined ? {} : { approval })
      })
    )
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

  const handleVoiceEvent = useCallback(
    (event: VoiceEvent) => {
      switch (event._tag) {
        case 'SessionOpened':
          callbacksRef.current.onDebug({
            _tag: 'SessionConfigured',
            eventType: 'session',
            model: event.model,
            transcriptionModel: event.transcriptionModel ?? null,
            transcriptionLanguage: event.transcriptionLanguage ?? null
          })
          return
        case 'UserTranscriptDelta':
          inputPendingRef.current = true
          return
        case 'UserTranscriptFinal':
          inputPendingRef.current = false
          callbacksRef.current.onDebug({
            _tag: 'InputTranscript',
            itemId: event.itemId,
            transcript: event.text
          })
          callbacksRef.current.onUserMessage(UserMessage.make({ content: event.text }))
          flushBufferedEvents()
          return
        case 'AssistantTranscriptDelta':
          project(event)
          emitAgentEvent(LLMTextDelta.make({ text: event.delta }))
          return
        case 'AssistantTranscriptFinal': {
          callbacksRef.current.onDebug({
            _tag: 'OutputTranscript',
            itemId: event.itemId,
            responseId: event.responseId,
            transcript: event.text ?? ''
          })
          const projected = project(event)

          if (projected.length > 0) {
            emitAgentEvent(assistantEndEvent(projected))
          }

          return
        }
        case 'Interrupted':
        case 'SessionClosed': {
          const projected = project(event)

          if (projected.length > 0) {
            emitAgentEvent(assistantEndEvent(projected))
          }

          return
        }
        case 'ToolCallsRequested': {
          project(event)

          const calls = new Map(toolCallsRef.current)

          for (const voiceCall of event.calls) {
            const call = protocolToolCallFromVoice(voiceCall)
            calls.set(voiceCall.callId, call)
            emitAgentEvent(ToolInputEnd.make({ call }))
            emitAgentEvent(ToolExecutionStarted.make({ call }))
          }

          toolCallsRef.current = calls

          return
        }
        case 'ToolCallCompleted': {
          project(event)

          const call = toolCallsRef.current.get(event.callId)

          if (call !== undefined) {
            emitAgentEvent(
              ToolExecutionCompleted.make({
                call,
                result: ToolResult.make({ toolCallId: event.callId, content: event.output })
              })
            )
          }

          return
        }
        case 'ToolCallFailed': {
          project(event)

          const call = toolCallsRef.current.get(event.callId)

          if (call !== undefined) {
            emitAgentEvent(
              ToolExecutionCompleted.make({
                call,
                result: ToolResult.make({
                  toolCallId: event.callId,
                  content: event.message,
                  isError: true
                })
              })
            )
          }

          return
        }
        case 'SessionOpening':
        case 'AudioInputStarted':
        case 'AudioInputStopped':
        case 'AssistantAudioStarted':
        case 'AssistantAudioStopped':
        case 'ToolCallExecuting':
        case 'AwaitingInput':
        case 'Error':
          return
      }
    },
    [emitAgentEvent, flushBufferedEvents, project]
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
