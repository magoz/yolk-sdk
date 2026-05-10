'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AgentEnd,
  AssistantAgentMessage,
  LLMTextDelta,
  UserMessage,
  type AgentEvent,
  type AgentMessage,
  type Content
} from '@yolk/protocol'

export type VoiceStatus = 'idle' | 'connecting' | 'live' | 'error'

type ActiveVoiceSession = {
  readonly peerConnection: RTCPeerConnection
  readonly dataChannel: RTCDataChannel
  readonly mediaStream: MediaStream
}

type RealtimeFunctionCall = {
  readonly callId: string
  readonly name: string
  readonly argumentsJson: string
}

type UseRealtimeVoiceInput = {
  readonly messages: ReadonlyArray<AgentMessage>
  readonly onAgentEvent: (event: AgentEvent) => void
  readonly onUserMessage: (message: UserMessage) => void
  readonly onError: (message: string) => void
}

type RealtimeTextContent =
  | { readonly type: 'input_text'; readonly text: string }
  | { readonly type: 'output_text'; readonly text: string }

type RealtimeConversationMessage = {
  readonly type: 'message'
  readonly role: 'user' | 'assistant'
  readonly content: ReadonlyArray<RealtimeTextContent>
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null

const readProperty = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined

const readStringProperty = (value: unknown, key: string): string | null => {
  const property = readProperty(value, key)
  return typeof property === 'string' ? property : null
}

const parseJson = (raw: string): unknown => JSON.parse(raw)

const encodeClientEvent = (event: unknown) => {
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
): RealtimeConversationMessage | null => {
  switch (message._tag) {
    case 'User':
      return {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: contentToText(message.content) }]
      }
    case 'Assistant': {
      const text = contentToText(message.content)

      if (text.length === 0) {
        return null
      }

      return {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }]
      }
    }
    case 'ToolResult':
      return null
  }
}

const readFunctionCalls = (event: unknown): ReadonlyArray<RealtimeFunctionCall> => {
  if (readStringProperty(event, 'type') !== 'response.done') {
    return []
  }

  const response = readProperty(event, 'response')
  const output = readProperty(response, 'output')
  const outputItems: ReadonlyArray<unknown> = Array.isArray(output) ? output : []
  const calls: Array<RealtimeFunctionCall> = []

  for (const item of outputItems) {
    if (readStringProperty(item, 'type') !== 'function_call') {
      continue
    }

    const callId = readStringProperty(item, 'call_id')
    const name = readStringProperty(item, 'name')
    const argumentsJson = readStringProperty(item, 'arguments')

    if (callId !== null && name !== null && argumentsJson !== null) {
      calls.push({ callId, name, argumentsJson })
    }
  }

  return calls
}

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

  const sendClientEvent = useCallback((dataChannel: RTCDataChannel, event: unknown) => {
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
          sendClientEvent(dataChannel, { type: 'conversation.item.create', item })
        }
      }
    },
    [messages, sendClientEvent]
  )

  const executeToolCall = useCallback(
    async (call: RealtimeFunctionCall, dataChannel: RTCDataChannel) => {
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
      const outputEvent = readProperty(payload, 'event')

      if (!isRecord(outputEvent)) {
        throw new Error('Tool response did not include a Realtime event')
      }

      sendClientEvent(dataChannel, outputEvent)
    },
    [sendClientEvent]
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

      const event = parseJson(message.data)
      const eventType = readStringProperty(event, 'type') ?? 'unknown'
      const delta = readStringProperty(event, 'delta')
      const transcript = readStringProperty(event, 'transcript')
      const calls = readFunctionCalls(event)

      if (eventType === 'conversation.item.input_audio_transcription.delta' && delta !== null) {
        setUserDraft(current => `${current}${delta}`)
        return
      }

      if (
        eventType === 'conversation.item.input_audio_transcription.completed' &&
        transcript !== null
      ) {
        setUserDraft('')
        onUserMessage(UserMessage.make({ content: transcript }))
        return
      }

      if (eventType === 'response.output_audio_transcript.delta' && delta !== null) {
        assistantDraftRef.current = `${assistantDraftRef.current}${delta}`
        onAgentEvent(LLMTextDelta.make({ text: delta }))
        return
      }

      if (eventType === 'response.output_audio_transcript.done') {
        commitAssistantTranscript(transcript)
        return
      }

      if (calls.length > 0) {
        await Promise.all(calls.map(call => executeToolCall(call, dataChannel)))
        sendClientEvent(dataChannel, { type: 'response.create' })
        return
      }

      if (eventType === 'error') {
        const messageText = readStringProperty(readProperty(event, 'error'), 'message') ?? 'Realtime error'
        setStatus('error')
        onError(messageText)
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
