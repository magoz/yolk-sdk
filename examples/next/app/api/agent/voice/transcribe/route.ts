import {
  FetchHttpClient,
  HttpEffect,
  HttpServerRequest,
  HttpServerResponse
} from 'effect/unstable/http'
import { Config, Data, Effect, Layer } from 'effect'
import * as Schema from 'effect/Schema'
import { VoiceTranscriber, VoiceTranscriptionResult } from '@yolk-sdk/agent/voice'
import { makeOpenAiTranscriberLayer } from '@yolk-sdk/agent/providers/openai/speech'
import { AppLayer } from '@/lib/layers'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'

export const dynamic = 'force-dynamic'

const maxAudioBytes = 15 * 1024 * 1024

class VoiceTranscribeRouteError extends Data.TaggedError('VoiceTranscribeRouteError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const encodeResult = Schema.encodeEffect(VoiceTranscriptionResult)

const readAudioBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const mimeType = request.headers['content-type'] ?? ''

  if (!mimeType.startsWith('audio/')) {
    return yield* Effect.fail(
      new VoiceTranscribeRouteError({ message: 'Content-Type must be an audio MIME type' })
    )
  }

  const body = yield* request.arrayBuffer
  const audio = new Uint8Array(body)

  if (audio.byteLength === 0) {
    return yield* Effect.fail(new VoiceTranscribeRouteError({ message: 'Audio body is empty' }))
  }

  if (audio.byteLength > maxAudioBytes) {
    return yield* Effect.fail(new VoiceTranscribeRouteError({ message: 'Audio body is too large' }))
  }

  return { audio, mimeType }
})

const handler = Effect.gen(function* () {
  yield* getSession()

  const { audio, mimeType } = yield* readAudioBody
  const apiKey = yield* Config.redacted('OPENAI_API_KEY')
  const transcriberLayer = makeOpenAiTranscriberLayer({ apiKey }).pipe(
    Layer.provide(FetchHttpClient.layer)
  )
  const result = yield* Effect.gen(function* () {
    const transcriber = yield* VoiceTranscriber

    return yield* transcriber.transcribe({ audio, mimeType, language: 'en' })
  }).pipe(Effect.provide(transcriberLayer))
  const encoded = yield* encodeResult(result)

  return yield* HttpServerResponse.json(encoded, {
    headers: { 'cache-control': 'no-store' }
  })
}).pipe(
  Effect.withSpan('AgentVoiceTranscribe.post'),
  Effect.catchTag('UnauthenticatedError', () =>
    HttpServerResponse.json({ error: 'Unauthorized' }, { status: 401 })
  ),
  Effect.catchTag('VoiceTranscribeRouteError', error =>
    HttpServerResponse.json({ error: error.message }, { status: 400 })
  ),
  Effect.catchTag('VoiceSpeechError', error =>
    error.code === 'rate_limited'
      ? reportError(
          new VoiceTranscribeRouteError({ message: 'Transcription failed', cause: error }),
          { operation: 'agent.voice.transcribe', status: 429 }
        ).pipe(
          Effect.andThen(
            HttpServerResponse.json(
              { error: 'OpenAI quota or rate limit exceeded' },
              { status: 429 }
            )
          )
        )
      : reportError(
          new VoiceTranscribeRouteError({ message: 'Transcription failed', cause: error }),
          { operation: 'agent.voice.transcribe', status: 502 }
        ).pipe(
          Effect.andThen(
            HttpServerResponse.json({ error: 'Transcription failed' }, { status: 502 })
          )
        )
  ),
  Effect.catch(error =>
    reportError(
      new VoiceTranscribeRouteError({ message: 'Voice transcription failed', cause: error }),
      { operation: 'agent.voice.transcribe', status: 500 }
    ).pipe(Effect.andThen(HttpServerResponse.json({ error: 'Internal error' }, { status: 500 })))
  )
)

const { handler: effectHandler } = HttpEffect.toWebHandlerLayer(handler, AppLayer)

export const POST = (request: Request) => effectHandler(request)
