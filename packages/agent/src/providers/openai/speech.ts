import { Effect, Layer, Redacted } from 'effect'
import * as Schema from 'effect/Schema'
import { HttpBody, HttpClient, HttpClientRequest } from 'effect/unstable/http'
import {
  VoiceSpeechError,
  VoiceSpeechSynthesizer,
  VoiceTranscriber,
  VoiceTranscriptionResult,
  VoiceTranscriptionSegment
} from '@yolk-sdk/agent/voice'

export type OpenAiSpeechConfig = {
  readonly apiKey: Redacted.Redacted<string>
  readonly speechUrl?: string
  readonly transcriptionUrl?: string
  readonly defaultSpeechModel?: string
  readonly defaultTranscriptionModel?: string
  readonly defaultVoice?: string
}

const defaultSpeechUrl = 'https://api.openai.com/v1/audio/speech'
const defaultTranscriptionUrl = 'https://api.openai.com/v1/audio/transcriptions'
const defaultSpeechModel = 'gpt-4o-mini-tts'
const defaultTranscriptionModel = 'gpt-4o-mini-transcribe'
const defaultVoice = 'alloy'

const audioMimeTypes: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm'
}

// OpenAI transcription detects the container format from the uploaded file
// extension, so the multipart filename must match the audio MIME type.
const transcriptionFileExtensions: Readonly<Record<string, string>> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/flac': 'flac',
  'audio/mpga': 'mpga'
}

const transcriptionFilename = (mimeType: string) => {
  const bareMimeType = mimeType.split(';')[0]?.trim().toLowerCase() ?? mimeType
  const extension = transcriptionFileExtensions[bareMimeType] ?? 'mp3'

  return `audio.${extension}`
}

const httpFailure = (message: string) => (error: { readonly message: string }) =>
  new VoiceSpeechError({ code: 'provider_error', message: `${message}: ${error.message}` })

const statusFailure = (operation: string, status: number) =>
  new VoiceSpeechError({
    code: 'provider_error',
    message: `OpenAI ${operation} returned ${status}`
  })

const OpenAiTranscriptionResponse = Schema.Struct({
  text: Schema.String,
  language: Schema.optional(Schema.String),
  duration: Schema.optional(Schema.Number),
  segments: Schema.optional(
    Schema.Array(
      Schema.Struct({
        text: Schema.String,
        start: Schema.optional(Schema.Number),
        end: Schema.optional(Schema.Number)
      })
    )
  )
})

const decodeTranscriptionResponse = Schema.decodeUnknownEffect(OpenAiTranscriptionResponse)

const encodeSpeechBody = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)

/**
 * OpenAI text-to-speech adapter for the provider-neutral
 * `VoiceSpeechSynthesizer` service. Hosts provide the `HttpClient` layer and
 * API key config; no env reads happen in the package.
 */
export const makeOpenAiSpeechSynthesizerLayer = (config: OpenAiSpeechConfig) =>
  Layer.effect(
    VoiceSpeechSynthesizer,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      return VoiceSpeechSynthesizer.of({
        synthesize: request =>
          Effect.gen(function* () {
            const outputFormat = request.outputFormat ?? 'mp3'
            const body = yield* encodeSpeechBody({
              model: request.model ?? config.defaultSpeechModel ?? defaultSpeechModel,
              input: request.text,
              voice: request.voice ?? config.defaultVoice ?? defaultVoice,
              response_format: outputFormat
            }).pipe(
              Effect.mapError(
                () =>
                  new VoiceSpeechError({
                    code: 'invalid_request',
                    message: 'Could not encode speech request'
                  })
              )
            )
            const httpRequest = HttpClientRequest.post(config.speechUrl ?? defaultSpeechUrl).pipe(
              HttpClientRequest.setHeaders({
                authorization: `Bearer ${Redacted.value(config.apiKey)}`,
                'content-type': 'application/json'
              }),
              HttpClientRequest.bodyText(body, 'application/json')
            )
            const response = yield* client
              .execute(httpRequest)
              .pipe(Effect.mapError(httpFailure('OpenAI speech request failed')))

            if (response.status < 200 || response.status >= 300) {
              return yield* Effect.fail(statusFailure('speech', response.status))
            }

            const audio = yield* response.arrayBuffer.pipe(
              Effect.mapError(httpFailure('Could not read OpenAI speech audio'))
            )

            return {
              audio: new Uint8Array(audio),
              mimeType: audioMimeTypes[outputFormat] ?? 'application/octet-stream'
            }
          })
      })
    })
  )

/**
 * OpenAI speech-to-text adapter for the provider-neutral `VoiceTranscriber`
 * service. Uses `verbose_json` so language/duration/segments survive when the
 * model provides them.
 */
export const makeOpenAiTranscriberLayer = (config: OpenAiSpeechConfig) =>
  Layer.effect(
    VoiceTranscriber,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      return VoiceTranscriber.of({
        transcribe: request =>
          Effect.gen(function* () {
            const formData = new FormData()
            formData.set(
              'file',
              new Blob([request.audio.slice().buffer], { type: request.mimeType }),
              transcriptionFilename(request.mimeType)
            )
            formData.set(
              'model',
              request.model ?? config.defaultTranscriptionModel ?? defaultTranscriptionModel
            )
            formData.set('response_format', 'verbose_json')

            if (request.language !== undefined) {
              formData.set('language', request.language)
            }

            if (request.prompt !== undefined) {
              formData.set('prompt', request.prompt)
            }

            const httpRequest = HttpClientRequest.post(
              config.transcriptionUrl ?? defaultTranscriptionUrl
            ).pipe(
              HttpClientRequest.setHeaders({
                authorization: `Bearer ${Redacted.value(config.apiKey)}`
              }),
              HttpClientRequest.setBody(HttpBody.formData(formData))
            )
            const response = yield* client
              .execute(httpRequest)
              .pipe(Effect.mapError(httpFailure('OpenAI transcription request failed')))

            if (response.status < 200 || response.status >= 300) {
              return yield* Effect.fail(statusFailure('transcription', response.status))
            }

            const payload = yield* response.json.pipe(
              Effect.mapError(httpFailure('Could not read OpenAI transcription response'))
            )
            const decoded = yield* decodeTranscriptionResponse(payload).pipe(
              Effect.mapError(
                () =>
                  new VoiceSpeechError({
                    code: 'provider_error',
                    message: 'OpenAI transcription response had an unexpected shape'
                  })
              )
            )

            return VoiceTranscriptionResult.make({
              text: decoded.text,
              language: decoded.language,
              durationSeconds: decoded.duration,
              segments: decoded.segments?.map(segment =>
                VoiceTranscriptionSegment.make({
                  text: segment.text,
                  startSeconds: segment.start,
                  endSeconds: segment.end
                })
              )
            })
          })
      })
    })
  )
