'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Effect, Option } from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse
} from 'effect/unstable/http'
import * as Schema from 'effect/Schema'
import {
  AgentEnd,
  type AgentMessage,
  AssistantAgentMessage,
  LLMToolCall,
  LLMTextDelta,
  ToolCall,
  ToolExecutionEnd,
  ToolExecutionStart,
  ToolResultMessage,
  ToolResult,
  UserMessage,
  type AgentEvent,
  type Content
} from '@yolk/protocol'
import {
  decodeOpenAiRealtimeServerEvent,
  decodeOpenAiRealtimeToolExecutionResponse,
  makeOpenAiRealtimeAssistantMessageItem,
  makeOpenAiRealtimeConversationItemCreateEvent,
  makeOpenAiRealtimeResponseCreateEvent,
  makeOpenAiRealtimeUserMessageItem,
  readOpenAiRealtimeToolOutput,
  type OpenAiRealtimeClientEvent,
  type OpenAiRealtimeConversationMessageItem,
  type OpenAiRealtimeFunctionCall
} from '@/lib/agents/realtime/openai-realtime-events'

export type VoiceStatus = 'idle' | 'connecting' | 'live' | 'error'

type ActiveVoiceSession = {
  readonly peerConnection: RTCPeerConnection
  readonly dataChannel: RTCDataChannel
  readonly mediaStream: MediaStream
}

type VoiceToolRequest = {
  readonly realtimeCall: OpenAiRealtimeFunctionCall
  readonly toolCall: ToolCall
}

type VoiceStartOutcome = { readonly _tag: 'Started' } | { readonly _tag: 'Stale' }

type UseRealtimeVoiceInput = {
  readonly messages: ReadonlyArray<AgentMessage>
  readonly onAgentEvent: (event: AgentEvent) => void
  readonly onUserMessage: (message: UserMessage) => void
  readonly onError: (message: string) => void
}

const encodeClientEvent = (event: OpenAiRealtimeClientEvent) => {
  const encoded = JSON.stringify(event)

  if (encoded === undefined) {
    throw new Error('Could not encode Realtime event')
  }

  return encoded
}

const contentToText = (content: Content) =>
  typeof content === 'string'
    ? content
    : content.map(part => (part._tag === 'Text' ? part.text : part._tag)).join(', ')

const toRealtimeConversationMessage = (
  message: AgentMessage
): OpenAiRealtimeConversationMessageItem | null => {
  switch (message._tag) {
    case 'User':
      return makeOpenAiRealtimeUserMessageItem(contentToText(message.content))
    case 'Assistant': {
      const text = contentToText(message.content)

      if (text.length === 0) {
        return null
      }

      return makeOpenAiRealtimeAssistantMessageItem(text)
    }
    case 'ToolResult':
      return null
  }
}

const toolCallFromRealtime = (call: OpenAiRealtimeFunctionCall) =>
  ToolCall.make({
    id: call.callId,
    name: call.name,
    params: call.argumentsJson
  })

const unknownToMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const tryBrowserPromise = <A,>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: error => error })

const toBrowserHttpError =
  (message: string) => (error: HttpClientError.HttpClientError) =>
    new Error(`${message}: ${error.message}`)

const encodeJsonString = (value: unknown, message: string) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(value).pipe(
    Effect.mapError(error => new Error(`${message}: ${unknownToMessage(error)}`))
  )

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
    Effect.flatMap(message => Effect.fail(new Error(message)))
  )
}

const requestToolExecution = (call: OpenAiRealtimeFunctionCall) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const body = yield* encodeJsonString(
      {
        callId: call.callId,
        name: call.name,
        arguments: call.argumentsJson
      },
      'Could not serialize Realtime tool request'
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

    return yield* okResponse.json.pipe(
      Effect.mapError(toBrowserHttpError('Could not parse Realtime tool response'))
    )
  })

const requestRealtimeAnswerSdp = (sdp: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.post('/api/agent/realtime/call').pipe(
      HttpClientRequest.setHeaders({
        accept: 'application/sdp',
        'content-type': 'application/sdp'
      }),
      HttpClientRequest.bodyText(sdp, 'application/sdp')
    )
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(toBrowserHttpError('Realtime call request failed')))
    const okResponse = yield* ensureOkResponse(response)

    return yield* okResponse.text.pipe(
      Effect.mapError(toBrowserHttpError('Could not read Realtime SDP response'))
    )
  })

const canUseVoice = () =>
  typeof navigator !== 'undefined' &&
  navigator.mediaDevices !== undefined &&
  typeof RTCPeerConnection !== 'undefined'

const closeSessionResources = (
  peerConnection: RTCPeerConnection,
  dataChannel: RTCDataChannel,
  mediaStream: MediaStream | null
) => {
  dataChannel.close()
  peerConnection.close()
  mediaStream?.getTracks().forEach(track => track.stop())
}

const assistantEndMessages = (content: string, toolMessages: ReadonlyArray<AgentMessage>) => {
  if (content.trim().length === 0) {
    return [...toolMessages]
  }

  return [...toolMessages, AssistantAgentMessage.make({ content, toolCalls: [] })]
}

const assistantEndEvent = (content: string, toolMessages: ReadonlyArray<AgentMessage>) =>
  AgentEnd.make({
    messages: assistantEndMessages(content, toolMessages),
    turns: 1,
    usage: { input: 0, output: 0 }
  })

export const useRealtimeVoice = ({
  messages,
  onAgentEvent,
  onUserMessage,
  onError
}: UseRealtimeVoiceInput) => {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [userDraft, setUserDraft] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const activeSessionRef = useRef<ActiveVoiceSession | null>(null)
  const assistantDraftRef = useRef('')
  const voiceCreatedMessagesRef = useRef<ReadonlyArray<AgentMessage>>([])
  const startAttemptIdRef = useRef(0)
  const isConnecting = status === 'connecting'
  const isLive = status === 'live'

  const closeActiveSession = useCallback(() => {
    const activeSession = activeSessionRef.current

    if (activeSession === null) {
      return
    }

    closeSessionResources(
      activeSession.peerConnection,
      activeSession.dataChannel,
      activeSession.mediaStream
    )
    activeSessionRef.current = null
    assistantDraftRef.current = ''
    voiceCreatedMessagesRef.current = []
    setUserDraft('')

    if (audioRef.current !== null) {
      audioRef.current.srcObject = null
    }
  }, [])

  const sendClientEvent = useCallback((dataChannel: RTCDataChannel, event: OpenAiRealtimeClientEvent) => {
    if (dataChannel.readyState !== 'open') {
      throw new Error('Realtime data channel is not open')
    }

    dataChannel.send(encodeClientEvent(event))
  }, [])

  const seedConversation = useCallback(
    (dataChannel: RTCDataChannel) => {
      for (const message of messages) {
        const item = toRealtimeConversationMessage(message)

        if (item !== null) {
          sendClientEvent(dataChannel, makeOpenAiRealtimeConversationItemCreateEvent(item))
        }
      }
    },
    [messages, sendClientEvent]
  )

  const executeToolCall = useCallback(
    (request: VoiceToolRequest, dataChannel: RTCDataChannel) =>
      Effect.gen(function* () {
      const call = request.realtimeCall
      const toolCall = request.toolCall
      yield* Effect.sync(() => {
        onAgentEvent(LLMToolCall.make({ call: toolCall }))
        onAgentEvent(ToolExecutionStart.make({ call: toolCall }))
      })

      const payload = yield* requestToolExecution(call)
      const decoded = decodeOpenAiRealtimeToolExecutionResponse(payload)

      if (Option.isNone(decoded)) {
        return yield* Effect.fail(new Error('Tool response did not include a Realtime event'))
      }

      const outputEvent = decoded.value.event

      yield* Effect.sync(() => sendClientEvent(dataChannel, outputEvent))

      const result = ToolResult.make({
        toolCallId: call.callId,
        content: readOpenAiRealtimeToolOutput(outputEvent)
      })

      yield* Effect.sync(() => {
        onAgentEvent(
          ToolExecutionEnd.make({
            call: toolCall,
            result
          })
        )
      })

      return ToolResultMessage.make({ toolCallId: result.toolCallId, content: result.content })
    }),
    [onAgentEvent, sendClientEvent]
  )

  const commitAssistantTranscript = useCallback(
    (transcript: string | null) => {
      const content = transcript ?? assistantDraftRef.current
      const toolMessages = voiceCreatedMessagesRef.current

      if (content.trim().length === 0 && toolMessages.length === 0) {
        assistantDraftRef.current = ''
        return
      }

      onAgentEvent(assistantEndEvent(content, toolMessages))
      assistantDraftRef.current = ''
      voiceCreatedMessagesRef.current = []
    },
    [onAgentEvent]
  )

  const handleRealtimeMessage = useCallback(
    (message: MessageEvent, dataChannel: RTCDataChannel) =>
      Effect.gen(function* () {
      if (typeof message.data !== 'string') {
        return
      }

      const event = decodeOpenAiRealtimeServerEvent(message.data)

      switch (event._tag) {
        case 'InputAudioTranscriptionDelta':
          yield* Effect.sync(() => setUserDraft(current => `${current}${event.delta}`))
          return
        case 'InputAudioTranscriptionCompleted':
          yield* Effect.sync(() => {
            setUserDraft('')
            onUserMessage(UserMessage.make({ content: event.transcript }))
          })
          return
        case 'OutputAudioTranscriptDelta':
          yield* Effect.sync(() => {
            assistantDraftRef.current = `${assistantDraftRef.current}${event.delta}`
            onAgentEvent(LLMTextDelta.make({ text: event.delta }))
          })
          return
        case 'OutputAudioTranscriptDone':
          yield* Effect.sync(() => commitAssistantTranscript(event.transcript))
          return
        case 'FunctionCalls': {
          const requests = event.calls.map(call => ({
            realtimeCall: call,
            toolCall: toolCallFromRealtime(call)
          }))
          const resultMessages = yield* Effect.forEach(
            requests,
            request => executeToolCall(request, dataChannel)
          )

          if (requests.length > 0) {
            yield* Effect.sync(() => {
              voiceCreatedMessagesRef.current = [
                ...voiceCreatedMessagesRef.current,
                AssistantAgentMessage.make({
                  content: '',
                  toolCalls: requests.map(request => request.toolCall)
                }),
                ...resultMessages
              ]
            })
          }

          yield* Effect.sync(() => sendClientEvent(dataChannel, makeOpenAiRealtimeResponseCreateEvent()))
          return
        }
        case 'Error':
          yield* Effect.sync(() => {
            setStatus('error')
            onError(event.message)
          })
          return
        case 'Ignored':
          return
      }
    }),
    [commitAssistantTranscript, executeToolCall, onAgentEvent, onError, onUserMessage, sendClientEvent]
  )

  const startSession = useCallback(() => {
    if (isConnecting || isLive) {
      return
    }

    if (!canUseVoice()) {
      setStatus('error')
      onError('This browser cannot run WebRTC voice sessions.')
      return
    }

    closeActiveSession()
    const startAttemptId = startAttemptIdRef.current + 1
    startAttemptIdRef.current = startAttemptId
    setStatus('connecting')
    setUserDraft('')
    assistantDraftRef.current = ''
    voiceCreatedMessagesRef.current = []

    const peerConnection = new RTCPeerConnection()
    const dataChannel = peerConnection.createDataChannel('oai-events')

    Effect.runFork(
      Effect.gen(function* () {
        const mediaStream = yield* tryBrowserPromise(() =>
          navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true
            }
          })
        )

        if (startAttemptIdRef.current !== startAttemptId) {
          closeSessionResources(peerConnection, dataChannel, mediaStream)
          return { _tag: 'Stale' } satisfies VoiceStartOutcome
        }

        const audioTrack = mediaStream.getAudioTracks()[0]

        if (audioTrack === undefined) {
          closeSessionResources(peerConnection, dataChannel, mediaStream)
          return yield* Effect.fail(new Error('No microphone track available'))
        }

        activeSessionRef.current = { peerConnection, dataChannel, mediaStream }
        peerConnection.addTrack(audioTrack, mediaStream)
        peerConnection.addEventListener('track', event => {
          const stream = event.streams[0]

          if (
            activeSessionRef.current?.peerConnection === peerConnection &&
            stream !== undefined &&
            audioRef.current !== null
          ) {
            audioRef.current.srcObject = stream
          }
        })
        peerConnection.addEventListener('connectionstatechange', () => {
          if (
            activeSessionRef.current?.peerConnection === peerConnection &&
            peerConnection.connectionState === 'failed'
          ) {
            closeActiveSession()
            setStatus('error')
            onError('Realtime connection failed')
          }
        })
        dataChannel.addEventListener('open', () => {
          if (activeSessionRef.current?.dataChannel === dataChannel) {
            seedConversation(dataChannel)
          }
        })
        dataChannel.addEventListener('message', message => {
          if (activeSessionRef.current?.dataChannel !== dataChannel) {
            return
          }

          Effect.runFork(
            handleRealtimeMessage(message, dataChannel).pipe(
              Effect.matchEffect({
                onFailure: error =>
                  Effect.sync(() => {
                    if (activeSessionRef.current?.dataChannel !== dataChannel) {
                      return
                    }

                    setStatus('error')
                    onError(unknownToMessage(error))
                }),
                onSuccess: () => Effect.void
              }),
              Effect.provide(FetchHttpClient.layer)
            )
          )
        })

        const offer = yield* tryBrowserPromise(() => peerConnection.createOffer())
        yield* tryBrowserPromise(() => peerConnection.setLocalDescription(offer))

        if (offer.sdp === undefined) {
          return yield* Effect.fail(new Error('WebRTC offer SDP missing'))
        }

        const answerSdp = yield* requestRealtimeAnswerSdp(offer.sdp)

        if (startAttemptIdRef.current !== startAttemptId) {
          closeSessionResources(peerConnection, dataChannel, mediaStream)
          return { _tag: 'Stale' } satisfies VoiceStartOutcome
        }

        const answer: RTCSessionDescriptionInit = { type: 'answer', sdp: answerSdp }
        yield* tryBrowserPromise(() => peerConnection.setRemoteDescription(answer))
        setStatus('live')

        return { _tag: 'Started' } satisfies VoiceStartOutcome
      }).pipe(
        Effect.matchEffect({
          onFailure: error =>
            Effect.sync(() => {
              if (startAttemptIdRef.current !== startAttemptId) {
                closeSessionResources(peerConnection, dataChannel, null)
                return
              }

              if (activeSessionRef.current?.peerConnection === peerConnection) {
                closeActiveSession()
              } else {
                closeSessionResources(peerConnection, dataChannel, null)
              }

              setStatus('error')
              onError(unknownToMessage(error))
            }),
          onSuccess: () => Effect.void
        }),
        Effect.provide(FetchHttpClient.layer)
      )
    )
  }, [
    closeActiveSession,
    handleRealtimeMessage,
    isConnecting,
    isLive,
    onError,
    seedConversation
  ])

  const stopSession = useCallback(() => {
    startAttemptIdRef.current += 1
    closeActiveSession()
    setStatus('idle')
  }, [closeActiveSession])

  const toggleSession = useCallback(() => {
    if (isConnecting || isLive) {
      stopSession()
      return
    }

    startSession()
  }, [isConnecting, isLive, startSession, stopSession])

  useEffect(
    () => () => {
      startAttemptIdRef.current += 1
      closeActiveSession()
    },
    [closeActiveSession]
  )

  return {
    audioRef,
    status,
    userDraft,
    isConnecting,
    isLive,
    startSession,
    stopSession,
    toggleSession
  }
}
