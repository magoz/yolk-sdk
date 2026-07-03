import { Effect, Layer, Redacted } from 'effect'
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import {
  speechResultToAudioPart,
  VoiceSpeechRequest,
  VoiceSpeechSynthesizer,
  VoiceTranscriber
} from '@yolk-sdk/agent/voice'
import {
  makeOpenAiSpeechSynthesizerLayer,
  makeOpenAiTranscriberLayer
} from '../../../src/providers/openai/speech.ts'

type CapturedRequest = {
  readonly request: HttpClientRequest.HttpClientRequest
}

const makeHttpClientLayer = (
  makeResponse: () => Response,
  requests: Array<CapturedRequest>
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(request =>
      Effect.sync(() => {
        requests.push({ request })

        return HttpClientResponse.fromWeb(request, makeResponse())
      })
    )
  )

const config = { apiKey: Redacted.make('test-key') }

describe('makeOpenAiSpeechSynthesizerLayer', () => {
  it.effect('synthesizes audio and maps output format to a MIME type', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const audioBytes = new Uint8Array([1, 2, 3, 4])
      const layer = makeOpenAiSpeechSynthesizerLayer(config).pipe(
        Layer.provide(
          makeHttpClientLayer(
            () => new Response(audioBytes.slice().buffer, { status: 200 }),
            requests
          )
        )
      )
      const result = yield* Effect.gen(function* () {
        const synthesizer = yield* VoiceSpeechSynthesizer

        return yield* synthesizer.synthesize(
          VoiceSpeechRequest.make({ text: 'Hello world', voice: 'marin' })
        )
      }).pipe(Effect.provide(layer))

      expect(result.mimeType).toBe('audio/mpeg')
      expect([...result.audio]).toEqual([1, 2, 3, 4])
      expect(requests[0]?.request.url).toBe('https://api.openai.com/v1/audio/speech')
      expect(requests[0]?.request.headers.authorization).toBe('Bearer test-key')

      const part = speechResultToAudioPart(result, { filename: 'hello.mp3' })

      expect(part._tag).toBe('Audio')
      expect(part.mimeType).toBe('audio/mpeg')
      expect(part.source._tag).toBe('InlineBase64')
    })
  )

  it.effect('sends instructions only when resolved from request or config', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const httpLayer = makeHttpClientLayer(
        () => new Response(new Uint8Array([1]).slice().buffer, { status: 200 }),
        requests
      )
      const bodyJson = (index: number) => {
        const body = requests[index]?.request.body

        return body?._tag === 'Uint8Array' ? new TextDecoder().decode(body.body) : ''
      }

      yield* Effect.gen(function* () {
        const synthesizer = yield* VoiceSpeechSynthesizer

        yield* synthesizer.synthesize(VoiceSpeechRequest.make({ text: 'No steering' }))
      }).pipe(
        Effect.provide(makeOpenAiSpeechSynthesizerLayer(config).pipe(Layer.provide(httpLayer)))
      )

      yield* Effect.gen(function* () {
        const synthesizer = yield* VoiceSpeechSynthesizer

        yield* synthesizer.synthesize(VoiceSpeechRequest.make({ text: 'Config default' }))
        yield* synthesizer.synthesize(
          VoiceSpeechRequest.make({ text: 'Request wins', instructions: 'Whisper softly.' })
        )
      }).pipe(
        Effect.provide(
          makeOpenAiSpeechSynthesizerLayer({
            ...config,
            defaultInstructions: 'Speak calmly.'
          }).pipe(Layer.provide(httpLayer))
        )
      )

      expect(bodyJson(0)).not.toContain('instructions')
      expect(bodyJson(1)).toContain('Speak calmly.')
      expect(bodyJson(2)).toContain('Whisper softly.')
      expect(bodyJson(2)).not.toContain('Speak calmly.')
    })
  )

  it.effect('fails with a safe provider error on non-2xx responses', () =>
    Effect.gen(function* () {
      const layer = makeOpenAiSpeechSynthesizerLayer(config).pipe(
        Layer.provide(makeHttpClientLayer(() => new Response('nope', { status: 429 }), []))
      )
      const error = yield* Effect.gen(function* () {
        const synthesizer = yield* VoiceSpeechSynthesizer

        return yield* synthesizer.synthesize(VoiceSpeechRequest.make({ text: 'Hello' }))
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(error).toMatchObject({ code: 'provider_error' })
      expect(error.message).toContain('429')
      expect(error.message).not.toContain('nope')
    })
  )
})

describe('makeOpenAiTranscriberLayer', () => {
  it.effect('transcribes audio with verbose json metadata', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeOpenAiTranscriberLayer(config).pipe(
        Layer.provide(
          makeHttpClientLayer(
            () =>
              Response.json({
                text: 'Hello there',
                language: 'english',
                duration: 1.5,
                segments: [{ text: 'Hello there', start: 0, end: 1.5 }]
              }),
            requests
          )
        )
      )
      const result = yield* Effect.gen(function* () {
        const transcriber = yield* VoiceTranscriber

        return yield* transcriber.transcribe({
          audio: new Uint8Array([9, 9]),
          mimeType: 'audio/mpeg',
          language: 'en'
        })
      }).pipe(Effect.provide(layer))

      expect(result.text).toBe('Hello there')
      expect(result.language).toBe('english')
      expect(result.durationSeconds).toBe(1.5)
      expect(result.segments?.[0]).toMatchObject({ text: 'Hello there', startSeconds: 0 })
      expect(requests[0]?.request.url).toBe('https://api.openai.com/v1/audio/transcriptions')

      const body = requests[0]?.request.body
      const file = body?._tag === 'FormData' ? body.formData.get('file') : null

      expect(file instanceof File ? file.name : null).toBe('audio.mp3')
      expect(body?._tag === 'FormData' ? body.formData.get('response_format') : null).toBe('json')
    })
  )

  it.effect('requests verbose_json only for whisper models', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeOpenAiTranscriberLayer(config).pipe(
        Layer.provide(
          makeHttpClientLayer(
            () => Response.json({ text: 'ok', language: 'english', duration: 1 }),
            requests
          )
        )
      )

      yield* Effect.gen(function* () {
        const transcriber = yield* VoiceTranscriber

        return yield* transcriber.transcribe({
          audio: new Uint8Array([1]),
          mimeType: 'audio/mpeg',
          model: 'whisper-1'
        })
      }).pipe(Effect.provide(layer))

      const body = requests[0]?.request.body

      expect(body?._tag === 'FormData' ? body.formData.get('response_format') : null).toBe(
        'verbose_json'
      )
    })
  )

  it.effect('names the uploaded file after the audio MIME type for format detection', () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const layer = makeOpenAiTranscriberLayer(config).pipe(
        Layer.provide(makeHttpClientLayer(() => Response.json({ text: 'ok' }), requests))
      )

      yield* Effect.gen(function* () {
        const transcriber = yield* VoiceTranscriber

        return yield* transcriber.transcribe({
          audio: new Uint8Array([1]),
          mimeType: 'audio/webm;codecs=opus'
        })
      }).pipe(Effect.provide(layer))

      const body = requests[0]?.request.body
      const file = body?._tag === 'FormData' ? body.formData.get('file') : null

      expect(file instanceof File ? file.name : null).toBe('audio.webm')
    })
  )

  it.effect('fails with a safe provider error for malformed responses', () =>
    Effect.gen(function* () {
      const layer = makeOpenAiTranscriberLayer(config).pipe(
        Layer.provide(
          makeHttpClientLayer(() => Response.json({ transcriptText: 'wrong shape' }), [])
        )
      )
      const error = yield* Effect.gen(function* () {
        const transcriber = yield* VoiceTranscriber

        return yield* transcriber.transcribe({ audio: new Uint8Array([1]), mimeType: 'audio/wav' })
      }).pipe(Effect.provide(layer), Effect.flip)

      expect(error).toMatchObject({ code: 'provider_error' })
      expect(error.message).toContain('unexpected shape')
    })
  )
})
