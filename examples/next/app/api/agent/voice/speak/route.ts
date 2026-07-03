import {
  FetchHttpClient,
  HttpEffect,
  HttpServerRequest,
  HttpServerResponse
} from 'effect/unstable/http'
import { Config, Data, Effect, Layer } from 'effect'
import * as Schema from 'effect/Schema'
import { VoiceSpeechRequest, VoiceSpeechSynthesizer } from '@yolk-sdk/agent/voice'
import { makeOpenAiSpeechSynthesizerLayer } from '@yolk-sdk/agent/providers/openai/speech'
import { AppLayer } from '@/lib/layers'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'

export const dynamic = 'force-dynamic'

const maxSpeechCharacters = 4_000
const defaultTtsVoice = 'marin'
// Applied per synthesis request; keeps prosody consistent across the
// sentence-chunked TTS stream. Steers delivery only, never content.
const defaultTtsInstructions =
  'Speak in a warm, natural, conversational tone, like a helpful assistant talking to a colleague. ' +
  'Medium pace, relaxed delivery. Read technical terms, code identifiers, and URLs plainly without ' +
  'dramatization. No radio-announcer energy.'

class VoiceSpeakRouteError extends Data.TaggedError('VoiceSpeakRouteError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const SpeakRequestBody = Schema.Struct({
  text: Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty())),
  voice: Schema.optional(Schema.String)
})

const handler = Effect.gen(function* () {
  yield* getSession()

  const body = yield* HttpServerRequest.schemaBodyJson(SpeakRequestBody)

  if (body.text.length > maxSpeechCharacters) {
    return yield* Effect.fail(
      new VoiceSpeakRouteError({ message: 'Text is too long for speech synthesis' })
    )
  }

  const apiKey = yield* Config.redacted('OPENAI_API_KEY')
  const synthesizerLayer = makeOpenAiSpeechSynthesizerLayer({
    apiKey,
    defaultVoice: defaultTtsVoice,
    defaultInstructions: defaultTtsInstructions
  }).pipe(Layer.provide(FetchHttpClient.layer))
  const result = yield* Effect.gen(function* () {
    const synthesizer = yield* VoiceSpeechSynthesizer

    return yield* synthesizer.synthesize(
      VoiceSpeechRequest.make({ text: body.text, voice: body.voice })
    )
  }).pipe(Effect.provide(synthesizerLayer))

  return HttpServerResponse.uint8Array(result.audio, {
    contentType: result.mimeType,
    headers: { 'cache-control': 'no-store' }
  })
}).pipe(
  Effect.withSpan('AgentVoiceSpeak.post'),
  Effect.catchTag('UnauthenticatedError', () =>
    HttpServerResponse.json({ error: 'Unauthorized' }, { status: 401 })
  ),
  Effect.catchTag('SchemaError', () =>
    HttpServerResponse.json({ error: 'Invalid speech request' }, { status: 400 })
  ),
  Effect.catchTag('VoiceSpeakRouteError', error =>
    HttpServerResponse.json({ error: error.message }, { status: 400 })
  ),
  Effect.catchTag('VoiceSpeechError', error =>
    error.code === 'rate_limited'
      ? reportError(
          new VoiceSpeakRouteError({ message: 'Speech synthesis failed', cause: error }),
          {
            operation: 'agent.voice.speak',
            status: 429
          }
        ).pipe(
          Effect.andThen(
            HttpServerResponse.json(
              { error: 'OpenAI quota or rate limit exceeded' },
              { status: 429 }
            )
          )
        )
      : reportError(
          new VoiceSpeakRouteError({ message: 'Speech synthesis failed', cause: error }),
          {
            operation: 'agent.voice.speak',
            status: 502
          }
        ).pipe(
          Effect.andThen(
            HttpServerResponse.json({ error: 'Speech synthesis failed' }, { status: 502 })
          )
        )
  ),
  Effect.catch(error =>
    reportError(new VoiceSpeakRouteError({ message: 'Voice speech failed', cause: error }), {
      operation: 'agent.voice.speak',
      status: 500
    }).pipe(Effect.andThen(HttpServerResponse.json({ error: 'Internal error' }, { status: 500 })))
  )
)

const { handler: effectHandler } = HttpEffect.toWebHandlerLayer(handler, AppLayer)

export const POST = (request: Request) => effectHandler(request)
