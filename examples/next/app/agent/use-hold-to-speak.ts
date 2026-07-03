'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Effect, Option } from 'effect'
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
  /**
   * Fires when the MediaRecorder actually starts capturing — after the
   * getUserMedia permission/setup delay, not at pointer down. Speech before
   * this moment is lost; hosts use it for a "mic is hot" cue.
   */
  readonly onRecordingStarted?: () => void
}

type SpeechAudio = {
  readonly audio: ArrayBuffer
  readonly contentType: string
}

type SpeechRequestOutcome =
  | {
      readonly _tag: 'Success'
      readonly speech: SpeechAudio
    }
  | {
      readonly _tag: 'Failure'
      readonly error: unknown
    }

type PlaybackCancel = {
  cancel: () => void
}

const minRecordingMs = 300

class HoldToSpeakError extends Error {}

const toRequestError = (message: string) => (error: HttpClientError.HttpClientError) =>
  new HoldToSpeakError(`${message}: ${error.message}`)

const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.String }))
)

// Route error bodies are `{ "error": "..." }`; toast the message, not raw JSON.
const errorBodyMessage = (body: string, status: number) => {
  if (body.length === 0) {
    return `Request failed with ${status}`
  }

  return Option.match(decodeErrorBody(body), {
    onNone: () => body,
    onSome: decoded => decoded.error
  })
}

const ensureOkResponse = (response: HttpClientResponse.HttpClientResponse) => {
  if (response.status >= 200 && response.status < 300) {
    return Effect.succeed(response)
  }

  return response.text.pipe(
    Effect.mapError(toRequestError('Could not read response body')),
    Effect.flatMap(body =>
      Effect.fail(new HoldToSpeakError(errorBodyMessage(body, response.status)))
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

const requestSpeech = (text: string): Effect.Effect<SpeechAudio, HoldToSpeakError> =>
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

const speechRequestSuccess = (speech: SpeechAudio): SpeechRequestOutcome => ({
  _tag: 'Success',
  speech
})

const speechRequestFailure = (error: unknown): SpeechRequestOutcome => ({
  _tag: 'Failure',
  error
})

const requestSpeechOutcome = (text: string): Promise<SpeechRequestOutcome> =>
  Effect.runPromise(requestSpeech(text)).then(speechRequestSuccess, speechRequestFailure)

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
export const useHoldToSpeak = ({
  onTranscript,
  onError,
  onRecordingStarted
}: UseHoldToSpeakInput) => {
  const [status, setStatus] = useState<HoldToSpeakStatus>('idle')
  const [isSpeaking, setIsSpeaking] = useState(false)
  const activeRecordingRef = useRef<ActiveRecording | null>(null)
  const pendingStartRef = useRef<PendingStart | null>(null)
  const audioElementRef = useRef<HTMLAudioElement | null>(null)
  const objectUrlRef = useRef<string | null>(null)
  const speechQueueRef = useRef<Array<string>>([])
  const speechRunIdRef = useRef(0)
  const speechPumpRunIdRef = useRef<number | null>(null)
  const cancelPlaybackRef = useRef<(() => void) | null>(null)
  const callbacksRef = useRef({ onTranscript, onError, onRecordingStarted })

  useEffect(() => {
    callbacksRef.current = { onTranscript, onError, onRecordingStarted }
  }, [onTranscript, onError, onRecordingStarted])

  const revokeObjectUrl = useCallback(() => {
    if (objectUrlRef.current !== null) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
  }, [])

  const stopCurrentAudio = useCallback(() => {
    const cancelPlayback = cancelPlaybackRef.current

    cancelPlaybackRef.current = null
    cancelPlayback?.()

    const element = audioElementRef.current

    if (element !== null) {
      element.pause()
      element.src = ''
      element.onended = null
      element.onerror = null
    }

    revokeObjectUrl()
  }, [revokeObjectUrl])

  const resetSpeech = useCallback(() => {
    speechRunIdRef.current += 1
    speechQueueRef.current = []
    stopCurrentAudio()

    setIsSpeaking(false)
  }, [stopCurrentAudio])

  const playSpeechAudio = useCallback(
    (speech: SpeechAudio, runId: number) =>
      new Promise<void>((resolve, reject) => {
        const element = audioElementRef.current

        if (element === null || speechRunIdRef.current !== runId) {
          resolve()
          return
        }

        stopCurrentAudio()

        const url = URL.createObjectURL(new Blob([speech.audio], { type: speech.contentType }))
        let settled = false
        const playback: PlaybackCancel = { cancel: () => undefined }
        const settle = (error: Error | null) => {
          if (settled) {
            return
          }

          settled = true

          if (cancelPlaybackRef.current === playback.cancel) {
            cancelPlaybackRef.current = null
          }

          element.onended = null
          element.onerror = null

          if (objectUrlRef.current === url) {
            URL.revokeObjectURL(url)
            objectUrlRef.current = null
          }

          if (error === null) {
            resolve()
            return
          }

          reject(error)
        }

        playback.cancel = () => settle(null)
        cancelPlaybackRef.current = playback.cancel
        objectUrlRef.current = url
        element.src = url
        element.onended = () => settle(null)
        element.onerror = () => settle(new HoldToSpeakError('Audio playback failed'))

        void element.play().catch((error: unknown) => {
          settle(new HoldToSpeakError(`Audio playback failed: ${unknownToMessage(error)}`))
        })
      }),
    [stopCurrentAudio]
  )

  const startSpeechPump = useCallback(() => {
    const runId = speechRunIdRef.current

    if (speechPumpRunIdRef.current === runId) {
      return
    }

    speechPumpRunIdRef.current = runId
    setIsSpeaking(true)

    void (async () => {
      let prefetchedSpeech: Promise<SpeechRequestOutcome> | null = null

      try {
        while (speechRunIdRef.current === runId && speechPumpRunIdRef.current === runId) {
          let speechPromise: Promise<SpeechRequestOutcome>

          if (prefetchedSpeech !== null) {
            speechPromise = prefetchedSpeech
            prefetchedSpeech = null
          } else {
            const nextText = speechQueueRef.current.shift()

            if (nextText === undefined) {
              break
            }

            speechPromise = requestSpeechOutcome(nextText)
          }

          const followingText = speechQueueRef.current.shift()

          if (followingText !== undefined) {
            prefetchedSpeech = requestSpeechOutcome(followingText)
          }

          const outcome = await speechPromise

          if (outcome._tag === 'Failure') {
            throw outcome.error
          }

          if (speechRunIdRef.current !== runId || speechPumpRunIdRef.current !== runId) {
            break
          }

          await playSpeechAudio(outcome.speech, runId)
        }
      } catch (error) {
        if (speechRunIdRef.current === runId && speechPumpRunIdRef.current === runId) {
          callbacksRef.current.onError(unknownToMessage(error))
        }
      } finally {
        if (speechPumpRunIdRef.current === runId) {
          speechPumpRunIdRef.current = null
          setIsSpeaking(false)
        }
      }
    })()
  }, [playSpeechAudio])

  const enqueueSpeech = useCallback(
    (chunks: ReadonlyArray<string>) => {
      for (const chunk of chunks) {
        const text = chunk.trim()

        if (text.length > 0) {
          speechQueueRef.current.push(text)
        }
      }

      if (speechQueueRef.current.length > 0) {
        startSpeechPump()
      }
    },
    [startSpeechPump]
  )

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

    resetSpeech()

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
        callbacksRef.current.onRecordingStarted?.()
      })
      .catch((error: unknown) => {
        pendingStartRef.current = null
        setStatus('idle')
        callbacksRef.current.onError(`Microphone access failed: ${unknownToMessage(error)}`)
      })
  }, [resetSpeech, status])

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

      resetSpeech()
    },
    [resetSpeech]
  )

  return {
    status,
    isRecording: status === 'recording',
    isTranscribing: status === 'transcribing',
    isSpeaking,
    startRecording,
    stopRecording,
    enqueueSpeech,
    resetSpeech,
    attachAudioElement
  }
}
