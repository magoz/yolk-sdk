'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Option } from 'effect'
import {
  AgentEnd,
  AssistantAgentMessage,
  LLMToolCall,
  LLMTextDelta,
  ToolCall,
  ToolExecutionEnd,
  ToolExecutionStart,
  ToolResult,
  UserMessage,
  type AgentEvent,
  type AgentMessage,
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

const remoteErrorMessage = async (response: Response) => {
  const body = await response.text()
  return body.length > 0 ? body : `Request failed with ${response.status}`
}

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

const assistantEndEvent = (content: string) =>
  AgentEnd.make({
    messages: [AssistantAgentMessage.make({ content, toolCalls: [] })],
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
    async (call: OpenAiRealtimeFunctionCall, dataChannel: RTCDataChannel) => {
      const toolCall = toolCallFromRealtime(call)
      onAgentEvent(LLMToolCall.make({ call: toolCall }))
      onAgentEvent(ToolExecutionStart.make({ call: toolCall }))

      const response = await fetch('/api/agent/realtime/tool', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          callId: call.callId,
          name: call.name,
          arguments: call.argumentsJson
        })
      })

      if (!response.ok) {
        throw new Error(await remoteErrorMessage(response))
      }

      const payload: unknown = await response.json()
      const decoded = decodeOpenAiRealtimeToolExecutionResponse(payload)

      if (Option.isNone(decoded)) {
        throw new Error('Tool response did not include a Realtime event')
      }

      const outputEvent = decoded.value.event

      sendClientEvent(dataChannel, outputEvent)

      onAgentEvent(
        ToolExecutionEnd.make({
          call: toolCall,
          result: ToolResult.make({
            toolCallId: call.callId,
            content: readOpenAiRealtimeToolOutput(outputEvent)
          })
        })
      )
    },
    [onAgentEvent, sendClientEvent]
  )

  const commitAssistantTranscript = useCallback(
    (transcript: string | null) => {
      const content = transcript ?? assistantDraftRef.current

      if (content.trim().length === 0) {
        assistantDraftRef.current = ''
        return
      }

      onAgentEvent(assistantEndEvent(content))
      assistantDraftRef.current = ''
    },
    [onAgentEvent]
  )

  const handleRealtimeMessage = useCallback(
    async (message: MessageEvent, dataChannel: RTCDataChannel) => {
      if (typeof message.data !== 'string') {
        return
      }

      const event = decodeOpenAiRealtimeServerEvent(message.data)

      switch (event._tag) {
        case 'InputAudioTranscriptionDelta':
          setUserDraft(current => `${current}${event.delta}`)
          return
        case 'InputAudioTranscriptionCompleted':
          setUserDraft('')
          onUserMessage(UserMessage.make({ content: event.transcript }))
          return
        case 'OutputAudioTranscriptDelta':
          assistantDraftRef.current = `${assistantDraftRef.current}${event.delta}`
          onAgentEvent(LLMTextDelta.make({ text: event.delta }))
          return
        case 'OutputAudioTranscriptDone':
          commitAssistantTranscript(event.transcript)
          return
        case 'FunctionCalls':
          await Promise.all(event.calls.map(call => executeToolCall(call, dataChannel)))
          sendClientEvent(dataChannel, makeOpenAiRealtimeResponseCreateEvent())
          return
        case 'Error':
          setStatus('error')
          onError(event.message)
          return
        case 'Ignored':
          return
      }
    },
    [commitAssistantTranscript, executeToolCall, onAgentEvent, onError, onUserMessage, sendClientEvent]
  )

  const startSession = useCallback(async () => {
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

    const peerConnection = new RTCPeerConnection()
    const dataChannel = peerConnection.createDataChannel('oai-events')
    let mediaStream: MediaStream | null = null

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true
        }
      })

      if (startAttemptIdRef.current !== startAttemptId) {
        closeSessionResources(peerConnection, dataChannel, mediaStream)
        return
      }

      const audioTrack = mediaStream.getAudioTracks()[0]

      if (audioTrack === undefined) {
        throw new Error('No microphone track available')
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

        void handleRealtimeMessage(message, dataChannel).catch(caught => {
          if (activeSessionRef.current?.dataChannel !== dataChannel) {
            return
          }

          const messageText = caught instanceof Error ? caught.message : String(caught)
          setStatus('error')
          onError(messageText)
        })
      })

      const offer = await peerConnection.createOffer()
      await peerConnection.setLocalDescription(offer)

      if (offer.sdp === undefined) {
        throw new Error('WebRTC offer SDP missing')
      }

      const response = await fetch('/api/agent/realtime/call', {
        method: 'POST',
        headers: {
          'content-type': 'application/sdp'
        },
        body: offer.sdp
      })

      if (!response.ok) {
        throw new Error(await remoteErrorMessage(response))
      }

      const answerSdp = await response.text()

      if (startAttemptIdRef.current !== startAttemptId) {
        closeSessionResources(peerConnection, dataChannel, mediaStream)
        return
      }

      const answer: RTCSessionDescriptionInit = { type: 'answer', sdp: answerSdp }
      await peerConnection.setRemoteDescription(answer)
      setStatus('live')
    } catch (caught) {
      if (startAttemptIdRef.current !== startAttemptId) {
        closeSessionResources(peerConnection, dataChannel, mediaStream)
        return
      }

      if (activeSessionRef.current?.peerConnection === peerConnection) {
        closeActiveSession()
      } else {
        closeSessionResources(peerConnection, dataChannel, mediaStream)
      }

      setStatus('error')
      onError(caught instanceof Error ? caught.message : String(caught))
    }
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

    void startSession()
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
