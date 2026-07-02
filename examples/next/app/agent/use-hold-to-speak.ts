'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse
} from 'effect/unstable/http'
import { VoiceTranscriptionResult } from '@yolk-sdk/agent/voice'

export type HoldToSpeakStatus = 'idle' | 'recording' | 'transcribing'

type UseHoldToSpeakInput = {
  readonly onTranscript: (text: string) => void
  readonly onError: (message: string) => void
}

const minRecordingMs = 300

class HoldToSpeakError extends Error {}

const toRequestError = (message: string) => (error: HttpClientError.HttpClientError) =>
  new HoldToSpeakError(`${message}: ${error.message}`)

const ensureOkResponse = (response: HttpClientResponse.HttpClientResponse) => {
  if (response.status >= 200 && response.status < 300) {
    return Effect.succeed(response)
  }

  return response.text.pipe(
    Effect.mapError(toRequestError('Could not read response body')),
    Effect.flatMap(body =>
      Effect.fail(
        new HoldToSpeakError(body.length > 0 ? body : `Request failed with ${response.status}`)
      )
    )
  )
}

const decodeTranscription = Schema.decodeUnknownEffect(VoiceTranscriptionResult)

const transcribeAudio = (audio: Uint8Array, mimeType: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.post('/api/agent/voice/transcribe').pipe(
      HttpClientRequest.setHeaders({ accept: 'application/json', 'content-type': mimeType }),
      HttpClientRequest.bodyUint8Array(audio, mimeType)
    )
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(toRequestError('Transcription request failed')))
    const okResponse = yield* ensureOkResponse(response)
    const payload = yield* okResponse.json.pipe(
      Effect.mapError(toRequestError('Could not parse transcription response'))
    )

    return yield* decodeTranscription(payload).pipe(
      Effect.mapError(() => new HoldToSpeakError('Transcription response had an unexpected shape'))
    )
  }).pipe(Effect.provide(FetchHttpClient.layer))

const encodeSpeakBody = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)

const requestSpeech = (text: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const body = yield* encodeSpeakBody({ text }).pipe(
      Effect.mapError(() => new HoldToSpeakError('Could not encode speech request'))
    )
    const request = HttpClientRequest.post('/api/agent/voice/speak').pipe(
      HttpClientRequest.setHeaders({ accept: 'audio/*', 'content-type': 'application/json' }),
      HttpClientRequest.bodyText(body, 'application/json')
    )
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(toRequestError('Speech request failed')))
    const okResponse = yield* ensureOkResponse(response)
    const audio = yield* okResponse.arrayBuffer.pipe(
      Effect.mapError(toRequestError('Could not read speech audio'))
    )
    const contentType = okResponse.headers['content-type'] ?? 'audio/mpeg'

    return { audio, contentType }
  }).pipe(Effect.provide(FetchHttpClient.layer))

const pickRecorderMimeType = () => {
  if (typeof MediaRecorder === 'undefined') {
    return undefined
  }

  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']

  return candidates.find(candidate => MediaRecorder.isTypeSupported(candidate))
}

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

type ActiveRecording = {
  readonly recorder: MediaRecorder
  readonly stream: MediaStream
  readonly startedAtMs: number
  readonly chunks: Array<Blob>
}

type PendingStart = {
  cancelled: boolean
}

/**
 * Hold-to-speak voice input: record while held, transcribe on release through
 * the app STT route, and speak assistant replies through the app TTS route.
 * The transcript is handed to the caller, which submits it through the normal
 * text agent runtime, so hold-to-speak turns get the full toolset and HITL.
 */
export const useHoldToSpeak = ({ onTranscript, onError }: UseHoldToSpeakInput) => {
  const [status, setStatus] = useState<HoldToSpeakStatus>('idle')
  const [isSpeaking, setIsSpeaking] = useState(false)
  const activeRecordingRef = useRef<ActiveRecording | null>(null)
  const pendingStartRef = useRef<PendingStart | null>(null)
  const audioElementRef = useRef<HTMLAudioElement | null>(null)
  const objectUrlRef = useRef<string | null>(null)
  const callbacksRef = useRef({ onTranscript, onError })

  useEffect(() => {
    callbacksRef.current = { onTranscript, onError }
  }, [onTranscript, onError])

  const stopPlayback = useCallback(() => {
    const element = audioElementRef.current

    if (element !== null) {
      element.pause()
      element.src = ''
    }

    if (objectUrlRef.current !== null) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }

    setIsSpeaking(false)
  }, [])

  const releaseRecording = useCallback((recording: ActiveRecording) => {
    for (const track of recording.stream.getTracks()) {
      track.stop()
    }
  }, [])

  const startRecording = useCallback(() => {
    if (
      activeRecordingRef.current !== null ||
      pendingStartRef.current !== null ||
      status === 'transcribing'
    ) {
      return
    }

    const mimeType = pickRecorderMimeType()

    if (
      mimeType === undefined ||
      typeof navigator === 'undefined' ||
      navigator.mediaDevices === undefined
    ) {
      callbacksRef.current.onError('This browser cannot record audio.')
      return
    }

    stopPlayback()

    const pending: PendingStart = { cancelled: false }
    pendingStartRef.current = pending
    setStatus('recording')

    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then(stream => {
        pendingStartRef.current = null

        // Released (or unmounted) while the permission prompt was open:
        // never start a recorder nobody will stop.
        if (pending.cancelled) {
          for (const track of stream.getTracks()) {
            track.stop()
          }

          setStatus('idle')
          return
        }

        const recorder = new MediaRecorder(stream, { mimeType })
        const recording: ActiveRecording = {
          recorder,
          stream,
          startedAtMs: Date.now(),
          chunks: []
        }

        recorder.addEventListener('dataavailable', event => {
          if (event.data.size > 0) {
            recording.chunks.push(event.data)
          }
        })
        activeRecordingRef.current = recording
        recorder.start()
      })
      .catch((error: unknown) => {
        pendingStartRef.current = null
        setStatus('idle')
        callbacksRef.current.onError(`Microphone access failed: ${unknownToMessage(error)}`)
      })
  }, [status, stopPlayback])

  const stopRecording = useCallback(() => {
    const pending = pendingStartRef.current

    if (pending !== null) {
      pending.cancelled = true
      return
    }

    const recording = activeRecordingRef.current

    if (recording === null) {
      return
    }

    activeRecordingRef.current = null
    const heldForMs = Date.now() - recording.startedAtMs

    recording.recorder.addEventListener('stop', () => {
      releaseRecording(recording)

      if (heldForMs < minRecordingMs || recording.chunks.length === 0) {
        setStatus('idle')
        return
      }

      setStatus('transcribing')

      const blob = new Blob(recording.chunks, { type: recording.recorder.mimeType })

      void blob.arrayBuffer().then(buffer => {
        Effect.runFork(
          transcribeAudio(new Uint8Array(buffer), recording.recorder.mimeType).pipe(
            Effect.matchEffect({
              onFailure: error =>
                Effect.sync(() => {
                  setStatus('idle')
                  callbacksRef.current.onError(unknownToMessage(error))
                }),
              onSuccess: result =>
                Effect.sync(() => {
                  setStatus('idle')

                  if (result.text.trim().length > 0) {
                    callbacksRef.current.onTranscript(result.text)
                  }
                })
            })
          )
        )
      })
    })
    recording.recorder.stop()
  }, [releaseRecording])

  const speak = useCallback(
    (text: string) => {
      if (text.trim().length === 0) {
        return
      }

      stopPlayback()
      setIsSpeaking(true)

      Effect.runFork(
        requestSpeech(text).pipe(
          Effect.matchEffect({
            onFailure: error =>
              Effect.sync(() => {
                setIsSpeaking(false)
                callbacksRef.current.onError(unknownToMessage(error))
              }),
            onSuccess: ({ audio, contentType }) =>
              Effect.sync(() => {
                const element = audioElementRef.current

                if (element === null) {
                  setIsSpeaking(false)
                  return
                }

                const url = URL.createObjectURL(new Blob([audio], { type: contentType }))
                objectUrlRef.current = url
                element.src = url
                element.onended = () => stopPlayback()
                element.onerror = () => stopPlayback()
                void element.play().catch((error: unknown) => {
                  stopPlayback()
                  callbacksRef.current.onError(`Audio playback failed: ${unknownToMessage(error)}`)
                })
              })
          })
        )
      )
    },
    [stopPlayback]
  )

  const attachAudioElement = useCallback((element: HTMLAudioElement | null) => {
    audioElementRef.current = element
  }, [])

  useEffect(
    () => () => {
      if (pendingStartRef.current !== null) {
        pendingStartRef.current.cancelled = true
      }

      const recording = activeRecordingRef.current
      activeRecordingRef.current = null

      if (recording !== null) {
        recording.recorder.stop()

        for (const track of recording.stream.getTracks()) {
          track.stop()
        }
      }

      stopPlayback()
    },
    [stopPlayback]
  )

  return {
    status,
    isRecording: status === 'recording',
    isTranscribing: status === 'transcribing',
    isSpeaking,
    startRecording,
    stopRecording,
    speak,
    stopPlayback,
    attachAudioElement
  }
}
