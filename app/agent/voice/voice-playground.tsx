'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { LoaderCircleIcon, MicIcon, PhoneOffIcon, WrenchIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

type VoicePlaygroundProps = {
  readonly sessionId: string
}

type VoiceStatus = 'idle' | 'connecting' | 'live' | 'error'
type LogTone = 'neutral' | 'success' | 'error' | 'tool'

type VoiceLogEntry = {
  readonly id: number
  readonly label: string
  readonly detail: string
  readonly tone: LogTone
}

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

const statusVariant = (status: VoiceStatus) => {
  switch (status) {
    case 'live':
      return 'secondary'
    case 'error':
      return 'destructive'
    case 'idle':
    case 'connecting':
      return 'outline'
  }
}

const logToneClassName = (tone: LogTone) => {
  switch (tone) {
    case 'success':
      return 'border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300'
    case 'error':
      return 'border-destructive/20 bg-destructive/5 text-destructive'
    case 'tool':
      return 'border-primary/20 bg-primary/5 text-primary'
    case 'neutral':
      return 'border-foreground/10 bg-muted/40 text-muted-foreground'
  }
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

export function VoicePlayground({ sessionId }: VoicePlaygroundProps) {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<ReadonlyArray<VoiceLogEntry>>([])
  const [transcript, setTranscript] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const activeSessionRef = useRef<ActiveVoiceSession | null>(null)
  const nextLogIdRef = useRef(0)
  const isConnecting = status === 'connecting'
  const isLive = status === 'live'

  const appendLog = useCallback((entry: Omit<VoiceLogEntry, 'id'>) => {
    const id = nextLogIdRef.current
    nextLogIdRef.current += 1
    setLogs(current => [...current.slice(-39), { id, ...entry }])
  }, [])

  const closeActiveSession = useCallback(() => {
    const activeSession = activeSessionRef.current

    if (activeSession === null) {
      return
    }

    activeSession.dataChannel.close()
    activeSession.peerConnection.close()
    activeSession.mediaStream.getTracks().forEach(track => track.stop())
    activeSessionRef.current = null

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

  const executeToolCall = useCallback(
    async (call: RealtimeFunctionCall, dataChannel: RTCDataChannel) => {
      appendLog({ label: call.name, detail: 'tool call started', tone: 'tool' })

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
      appendLog({ label: call.name, detail: 'tool result sent', tone: 'success' })
    },
    [appendLog, sendClientEvent]
  )

  const handleRealtimeMessage = useCallback(
    async (message: MessageEvent, dataChannel: RTCDataChannel) => {
      if (typeof message.data !== 'string') {
        appendLog({ label: 'event', detail: 'ignored non-text event', tone: 'neutral' })
        return
      }

      const event = parseJson(message.data)
      const eventType = readStringProperty(event, 'type') ?? 'unknown'
      const transcriptDelta =
        readStringProperty(event, 'delta') ?? readStringProperty(event, 'transcript')
      const calls = readFunctionCalls(event)

      if (eventType === 'response.output_audio_transcript.delta' && transcriptDelta !== null) {
        setTranscript(current => `${current}${transcriptDelta}`)
      }

      if (calls.length > 0) {
        await Promise.all(calls.map(call => executeToolCall(call, dataChannel)))
        sendClientEvent(dataChannel, { type: 'response.create' })
        appendLog({ label: 'response', detail: 'continued after tool result', tone: 'success' })
        return
      }

      if (eventType === 'error') {
        const messageText = readStringProperty(readProperty(event, 'error'), 'message') ?? 'Realtime error'
        setError(messageText)
        appendLog({ label: eventType, detail: messageText, tone: 'error' })
        return
      }

      if (
        eventType === 'session.created' ||
        eventType === 'input_audio_buffer.speech_started' ||
        eventType === 'input_audio_buffer.speech_stopped' ||
        eventType === 'response.done'
      ) {
        appendLog({ label: eventType, detail: 'received', tone: 'neutral' })
      }
    },
    [appendLog, executeToolCall, sendClientEvent]
  )

  const startSession = useCallback(async () => {
    if (isConnecting || isLive) {
      return
    }

    if (!canUseVoice()) {
      setStatus('error')
      setError('This browser cannot run WebRTC voice sessions.')
      return
    }

    closeActiveSession()
    setStatus('connecting')
    setError(null)
    setTranscript('')
    setLogs([])
    appendLog({ label: 'session', detail: 'connecting', tone: 'neutral' })

    const peerConnection = new RTCPeerConnection()
    const dataChannel = peerConnection.createDataChannel('oai-events')

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true
        }
      })
      const audioTrack = mediaStream.getAudioTracks()[0]

      if (audioTrack === undefined) {
        throw new Error('No microphone track available')
      }

      activeSessionRef.current = { peerConnection, dataChannel, mediaStream }
      peerConnection.addTrack(audioTrack, mediaStream)
      peerConnection.addEventListener('track', event => {
        const stream = event.streams[0]

        if (stream !== undefined && audioRef.current !== null) {
          audioRef.current.srcObject = stream
        }
      })
      peerConnection.addEventListener('connectionstatechange', () => {
        if (peerConnection.connectionState === 'failed') {
          setStatus('error')
          setError('Realtime connection failed')
          appendLog({ label: 'connection', detail: 'failed', tone: 'error' })
        }
      })
      dataChannel.addEventListener('open', () => {
        appendLog({ label: 'data channel', detail: 'open', tone: 'success' })
      })
      dataChannel.addEventListener('close', () => {
        appendLog({ label: 'data channel', detail: 'closed', tone: 'neutral' })
      })
      dataChannel.addEventListener('message', message => {
        void handleRealtimeMessage(message, dataChannel).catch(caught => {
          const messageText = caught instanceof Error ? caught.message : String(caught)
          setStatus('error')
          setError(messageText)
          appendLog({ label: 'event', detail: messageText, tone: 'error' })
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
      const answer: RTCSessionDescriptionInit = { type: 'answer', sdp: answerSdp }
      await peerConnection.setRemoteDescription(answer)
      setStatus('live')
      appendLog({ label: 'session', detail: 'live', tone: 'success' })
    } catch (caught) {
      closeActiveSession()
      setStatus('error')
      const messageText = caught instanceof Error ? caught.message : String(caught)
      setError(messageText)
      appendLog({ label: 'session', detail: messageText, tone: 'error' })
    }
  }, [appendLog, closeActiveSession, handleRealtimeMessage, isConnecting, isLive])

  const stopSession = useCallback(() => {
    closeActiveSession()
    setStatus('idle')
    appendLog({ label: 'session', detail: 'stopped', tone: 'neutral' })
  }, [appendLog, closeActiveSession])

  useEffect(() => () => closeActiveSession(), [closeActiveSession])

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--color-muted),transparent_34rem)] p-4 md:p-8">
      <audio ref={audioRef} autoPlay className="sr-only" />
      <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl gap-6 lg:grid-cols-[0.82fr_1.18fr]">
        <section className="flex flex-col justify-between rounded-3xl border border-foreground/10 bg-background/80 p-6 shadow-sm backdrop-blur md:p-8">
          <div className="space-y-5">
            <Badge variant="outline" className="uppercase tracking-[0.18em]">
              Realtime voice
            </Badge>
            <div className="space-y-3">
              <h1 className="text-4xl font-semibold tracking-tight md:text-6xl">Yolk voice</h1>
              <p className="max-w-md text-sm leading-6 text-muted-foreground md:text-base">
                WebRTC voice-to-action with GPT-Realtime-2. Tools stay server-side; browser only
                handles mic, audio, and event relay.
              </p>
            </div>
          </div>

          <div className="mt-10 space-y-4">
            <div className="flex gap-2">
              {isLive || isConnecting ? (
                <Button type="button" variant="destructive" onClick={stopSession}>
                  <PhoneOffIcon />
                  Stop
                </Button>
              ) : (
                <Button type="button" onClick={() => void startSession()}>
                  {isConnecting ? <LoaderCircleIcon className="animate-spin" /> : <MicIcon />}
                  Start voice
                </Button>
              )}
            </div>
            <div className="grid gap-3 text-xs text-muted-foreground">
              <div className="flex items-center justify-between border-t border-foreground/10 pt-3">
                <span>Session</span>
                <code className="rounded bg-muted px-2 py-1 text-foreground">{sessionId}</code>
              </div>
              <div className="flex items-center justify-between border-t border-foreground/10 pt-3">
                <span>Status</span>
                <Badge variant={statusVariant(status)}>{status}</Badge>
              </div>
              <div className="flex items-center justify-between border-t border-foreground/10 pt-3">
                <span>Model</span>
                <code className="rounded bg-muted px-2 py-1 text-foreground">gpt-realtime-2</code>
              </div>
            </div>
          </div>
        </section>

        <section className="flex min-h-[34rem] flex-col rounded-3xl border border-foreground/10 bg-card shadow-sm">
          <div className="flex items-center justify-between border-b border-foreground/10 px-5 py-4">
            <div>
              <p className="text-sm font-medium">Live session</p>
              <p className="text-xs text-muted-foreground">Speak naturally. Try “what is 19 times 23?”</p>
            </div>
            {isConnecting ? (
              <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />
            ) : isLive ? (
              <MicIcon className="size-4 text-primary" />
            ) : null}
          </div>

          <div className="grid flex-1 gap-4 overflow-y-auto p-5 lg:grid-rows-[auto_1fr]">
            <Card size="sm" className="border-dashed bg-transparent shadow-none">
              <CardHeader>
                <CardTitle>Transcript</CardTitle>
                <CardDescription>Model audio transcript deltas.</CardDescription>
              </CardHeader>
              <CardContent className="min-h-16 whitespace-pre-wrap leading-6 text-muted-foreground">
                {transcript.length > 0 ? transcript : 'No transcript yet.'}
              </CardContent>
            </Card>

            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <WrenchIcon className="size-3" />
                Events
              </div>
              {logs.length > 0 ? (
                <div className="space-y-2">
                  {logs.map(log => (
                    <div
                      key={log.id}
                      className={`rounded-xl border px-3 py-2 text-xs ${logToneClassName(log.tone)}`}
                    >
                      <div className="font-medium text-foreground">{log.label}</div>
                      <div>{log.detail}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <Card size="sm" className="border-dashed bg-transparent shadow-none">
                  <CardContent className="text-muted-foreground">
                    Start a session to see Realtime events and tool calls.
                  </CardContent>
                </Card>
              )}
            </div>

            {error !== null ? (
              <Card size="sm" className="border-destructive/20 bg-destructive/5 text-destructive">
                <CardContent>{error}</CardContent>
              </Card>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  )
}
