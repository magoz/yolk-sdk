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
  AssistantTextPart,
  HostToolCallPart,
  assistantContent,
  contentPreview,
  type AgentMessage,
  AssistantAgentMessage,
  LLMTextDelta,
  ToolCall,
  ToolExecutionCompleted,
  ToolExecutionStarted,
  ToolInputEnd,
  ToolResultMessage,
  ToolResult,
  UserMessage,
  zeroAgentUsage,
  type AgentEvent
} from '@yolk/agent/protocol'
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
import type { OpenAiRealtimeTranscriptionModel } from '@/lib/agents/realtime/openai-realtime'

export type VoiceStatus = 'idle' | 'connecting' | 'live' | 'error'

export type VoiceDebugEvent =
  | {
      readonly _tag: 'TransportReady'
      readonly peerConnectionState: string
      readonly dataChannelState: string
    }
  | { readonly _tag: 'SessionOpened'; readonly seededMessageCount: number }
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
  | {
      readonly _tag: 'ResponseDone'
      readonly responseId: string | null
      readonly status: string | null
    }

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
  readonly transcriptionModel: OpenAiRealtimeTranscriptionModel
  readonly onAgentEvent: (event: AgentEvent) => void
  readonly onUserMessage: (message: UserMessage) => void
  readonly onError: (message: string) => void
  readonly onDebug: (event: VoiceDebugEvent) => void
}

const encodeClientEvent = (event: OpenAiRealtimeClientEvent) => {
  const encoded = JSON.stringify(event)

  if (encoded === undefined) {
    throw new Error('Could not encode Realtime event')
  }

  return encoded
}

const toRealtimeConversationMessage = (
  message: AgentMessage
): OpenAiRealtimeConversationMessageItem | null => {
  switch (message._tag) {
    case 'User':
      return makeOpenAiRealtimeUserMessageItem(contentPreview(message.content))
    case 'Assistant': {
      const text = contentPreview(assistantContent(message))

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

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const tryBrowserPromise = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: error => error })

const toBrowserHttpError = (message: string) => (error: HttpClientError.HttpClientError) =>
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

const realtimeCallUrl = (transcriptionModel: OpenAiRealtimeTranscriptionModel) => {
  const params = new URLSearchParams({ transcriptionModel })

  return `/api/agent/realtime/call?${params.toString()}`
}

const requestRealtimeAnswerSdp = (input: {
  readonly sdp: string
  readonly transcriptionModel: OpenAiRealtimeTranscriptionModel
}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.post(realtimeCallUrl(input.transcriptionModel)).pipe(
      HttpClientRequest.setHeaders({
        accept: 'application/sdp',
        'content-type': 'application/sdp'
      }),
      HttpClientRequest.bodyText(input.sdp, 'application/sdp')
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

const waitForRealtimeReady = (peerConnection: RTCPeerConnection, dataChannel: RTCDataChannel) =>
  new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup()
      reject(new Error('Realtime connection timed out before ready'))
    }, 10_000)
    const cleanup = () => {
      window.clearTimeout(timeout)
      peerConnection.removeEventListener('connectionstatechange', checkReady)
      dataChannel.removeEventListener('open', checkReady)
      dataChannel.removeEventListener('close', checkReady)
      dataChannel.removeEventListener('error', fail)
    }
    const fail = () => {
      cleanup()
      reject(new Error('Realtime connection closed before ready'))
    }
    const checkReady = () => {
      if (
        peerConnection.connectionState === 'failed' ||
        peerConnection.connectionState === 'closed'
      ) {
        fail()
        return
      }

      if (peerConnection.connectionState === 'connected' && dataChannel.readyState === 'open') {
        cleanup()
        resolve()
      }
    }

    peerConnection.addEventListener('connectionstatechange', checkReady)
    dataChannel.addEventListener('open', checkReady)
    dataChannel.addEventListener('close', checkReady)
    dataChannel.addEventListener('error', fail)
    checkReady()
  })

const assistantEndMessages = (content: string, toolMessages: ReadonlyArray<AgentMessage>) => {
  if (content.trim().length === 0) {
    return [...toolMessages]
  }

  return [
    ...toolMessages,
    AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content })] })
  ]
}

const assistantEndEvent = (content: string, toolMessages: ReadonlyArray<AgentMessage>) =>
  AgentEnd.make({
    messages: assistantEndMessages(content, toolMessages),
    turns: 1,
    usage: zeroAgentUsage
  })

export const useRealtimeVoice = ({
  messages,
  transcriptionModel,
  onAgentEvent,
  onUserMessage,
  onError,
  onDebug
}: UseRealtimeVoiceInput) => {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [userDraft, setUserDraft] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const activeSessionRef = useRef<ActiveVoiceSession | null>(null)
  const assistantDraftRef = useRef('')
  const userDraftRef = useRef('')
  const inputTranscriptPendingRef = useRef(false)
  const bufferedAgentEventsRef = useRef<ReadonlyArray<AgentEvent>>([])
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
    userDraftRef.current = ''
    inputTranscriptPendingRef.current = false
    bufferedAgentEventsRef.current = []
    voiceCreatedMessagesRef.current = []
    setUserDraft('')

    if (audioRef.current !== null) {
      audioRef.current.srcObject = null
    }
  }, [])

  const sendClientEvent = useCallback(
    (dataChannel: RTCDataChannel, event: OpenAiRealtimeClientEvent) => {
      if (dataChannel.readyState !== 'open') {
        throw new Error('Realtime data channel is not open')
      }

      dataChannel.send(encodeClientEvent(event))
    },
    []
  )

  const emitAgentEvent = useCallback(
    (event: AgentEvent) => {
      if (!inputTranscriptPendingRef.current) {
        onAgentEvent(event)
        return
      }

      bufferedAgentEventsRef.current = [...bufferedAgentEventsRef.current, event]
    },
    [onAgentEvent]
  )

  const flushBufferedAgentEvents = useCallback(() => {
    const events = bufferedAgentEventsRef.current
    bufferedAgentEventsRef.current = []

    for (const event of events) {
      onAgentEvent(event)
    }
  }, [onAgentEvent])

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
          emitAgentEvent(ToolInputEnd.make({ call: toolCall }))
          emitAgentEvent(ToolExecutionStarted.make({ call: toolCall }))
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
          emitAgentEvent(
            ToolExecutionCompleted.make({
              call: toolCall,
              result
            })
          )
        })

        return ToolResultMessage.make({
          toolCallId: result.toolCallId,
          content: result.content,
          structuredContent: result.structuredContent
        })
      }),
    [emitAgentEvent, sendClientEvent]
  )

  const commitAssistantTranscript = useCallback(
    (transcript: string | null) => {
      const content = transcript ?? assistantDraftRef.current
      const toolMessages = voiceCreatedMessagesRef.current

      if (content.trim().length === 0 && toolMessages.length === 0) {
        assistantDraftRef.current = ''
        return
      }

      emitAgentEvent(assistantEndEvent(content, toolMessages))
      assistantDraftRef.current = ''
      voiceCreatedMessagesRef.current = []
    },
    [emitAgentEvent]
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
            yield* Effect.sync(() => {
              inputTranscriptPendingRef.current = true
              userDraftRef.current = `${userDraftRef.current}${event.delta}`
              setUserDraft(userDraftRef.current)
            })
            return
          case 'InputAudioTranscriptionCompleted':
            yield* Effect.sync(() => {
              inputTranscriptPendingRef.current = false
              userDraftRef.current = ''
              onDebug({
                _tag: 'InputTranscript',
                itemId: event.itemId,
                transcript: event.transcript
              })
              setUserDraft('')
              onUserMessage(UserMessage.make({ content: event.transcript }))
              flushBufferedAgentEvents()
            })
            return
          case 'OutputAudioTranscriptDelta':
            yield* Effect.sync(() => {
              assistantDraftRef.current = `${assistantDraftRef.current}${event.delta}`
              emitAgentEvent(LLMTextDelta.make({ text: event.delta }))
            })
            return
          case 'OutputAudioTranscriptDone':
            yield* Effect.sync(() => {
              onDebug({
                _tag: 'OutputTranscript',
                itemId: event.itemId,
                responseId: event.responseId,
                transcript: event.transcript ?? assistantDraftRef.current
              })
              commitAssistantTranscript(event.transcript)
            })
            return
          case 'SessionConfigured':
            yield* Effect.sync(() => onDebug(event))
            return
          case 'ResponseDone':
            yield* Effect.sync(() => onDebug(event))
            return
          case 'FunctionCalls': {
            const requests = event.calls.map(call => ({
              realtimeCall: call,
              toolCall: toolCallFromRealtime(call)
            }))
            const resultMessages = yield* Effect.forEach(requests, request =>
              executeToolCall(request, dataChannel)
            )

            if (requests.length > 0) {
              yield* Effect.sync(() => {
                voiceCreatedMessagesRef.current = [
                  ...voiceCreatedMessagesRef.current,
                  AssistantAgentMessage.make({
                    parts: [
                      AssistantTextPart.make({ content: '' }),
                      ...requests.map(request => HostToolCallPart.make({ call: request.toolCall }))
                    ]
                  }),
                  ...resultMessages
                ]
              })
            }

            yield* Effect.sync(() =>
              sendClientEvent(dataChannel, makeOpenAiRealtimeResponseCreateEvent())
            )
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
    [
      commitAssistantTranscript,
      emitAgentEvent,
      executeToolCall,
      flushBufferedAgentEvents,
      onDebug,
      onError,
      onUserMessage,
      sendClientEvent
    ]
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
    userDraftRef.current = ''
    inputTranscriptPendingRef.current = false
    bufferedAgentEventsRef.current = []
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
            onDebug({ _tag: 'SessionOpened', seededMessageCount: messages.length })
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

        const answerSdp = yield* requestRealtimeAnswerSdp({ sdp: offer.sdp, transcriptionModel })

        if (startAttemptIdRef.current !== startAttemptId) {
          closeSessionResources(peerConnection, dataChannel, mediaStream)
          return { _tag: 'Stale' } satisfies VoiceStartOutcome
        }

        const answer: RTCSessionDescriptionInit = { type: 'answer', sdp: answerSdp }
        yield* tryBrowserPromise(() => peerConnection.setRemoteDescription(answer))
        yield* tryBrowserPromise(() => waitForRealtimeReady(peerConnection, dataChannel))
        onDebug({
          _tag: 'TransportReady',
          peerConnectionState: peerConnection.connectionState,
          dataChannelState: dataChannel.readyState
        })
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
    messages.length,
    onDebug,
    onError,
    seedConversation,
    transcriptionModel
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
