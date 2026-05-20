import { createHash } from 'node:crypto'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpEffect,
  HttpServerRequest,
  HttpServerResponse
} from 'effect/unstable/http'
import { Config, Data, Effect, Layer, Option, Redacted } from 'effect'
import * as Schema from 'effect/Schema'
import { AppLayer } from '@/lib/layers'
import {
  defaultOpenAiRealtimeTranscriptionModel,
  makeOpenAiRealtimeSessionConfig,
  OpenAiRealtimeTranscriptionModelSchema,
  type OpenAiRealtimeTranscriptionModel
} from '@/lib/agents/realtime/openai-realtime'
import { defaultVoiceAgentSystemPrompt } from '@/lib/agents/agent-prompts'
import { nodeVoiceToolModules, resolveAgentToolSet } from '@/lib/agents/tools/registry'
import { makeAppStorageRagToolModule } from '@/lib/agents/tools/storage-tool-handlers'
import { makeAppKnowledgeToolModule } from '@/lib/agents/tools/knowledge-tool-handlers'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import type { ToolDef } from '@yolk-sdk/agent/protocol'

export const dynamic = 'force-dynamic'

class RealtimeCallRouteError extends Data.TaggedError('RealtimeCallRouteError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

class OpenAiRealtimeCallError extends Data.TaggedError('OpenAiRealtimeCallError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const openAiRealtimeCallsUrl = 'https://api.openai.com/v1/realtime/calls'

const realtimeInstructions = defaultVoiceAgentSystemPrompt

const safetyIdentifier = (userId: string) =>
  createHash('sha256').update(`yolk:${userId}`).digest('hex')

const isBlank = (value: string) => value.trim().length === 0

const readTranscriptionModel = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(request.url, 'http://localhost')
  const rawModel = url.searchParams.get('transcriptionModel')

  if (rawModel === null) {
    return defaultOpenAiRealtimeTranscriptionModel
  }

  const decoded = Schema.decodeUnknownOption(OpenAiRealtimeTranscriptionModelSchema)(rawModel)

  if (Option.isSome(decoded)) {
    return decoded.value
  }

  return yield* Effect.fail(
    new RealtimeCallRouteError({
      message: `Unsupported transcription model: ${rawModel}`
    })
  )
})

const makeSessionConfigJson = (input: {
  readonly tools: ReadonlyArray<ToolDef>
  readonly transcriptionModel: OpenAiRealtimeTranscriptionModel
}) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(
    makeOpenAiRealtimeSessionConfig({
      instructions: realtimeInstructions,
      tools: input.tools,
      transcriptionModel: input.transcriptionModel
    })
  ).pipe(
    Effect.mapError(
      error =>
        new OpenAiRealtimeCallError({
          message: 'Could not serialize Realtime session config',
          cause: error
        })
    )
  )

const requestOpenAiRealtimeAnswer = (input: {
  readonly apiKey: Redacted.Redacted<string>
  readonly sdp: string
  readonly tools: ReadonlyArray<ToolDef>
  readonly transcriptionModel: OpenAiRealtimeTranscriptionModel
  readonly userId: string
}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const sessionConfig = yield* makeSessionConfigJson({
      tools: input.tools,
      transcriptionModel: input.transcriptionModel
    })
    const formData = new FormData()
    formData.set('sdp', input.sdp)
    formData.set('session', sessionConfig)

    const request = HttpClientRequest.post(openAiRealtimeCallsUrl).pipe(
      HttpClientRequest.setHeaders({
        accept: 'application/sdp',
        authorization: `Bearer ${Redacted.value(input.apiKey)}`,
        'OpenAI-Safety-Identifier': safetyIdentifier(input.userId)
      }),
      HttpClientRequest.bodyFormData(formData)
    )
    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        error =>
          new OpenAiRealtimeCallError({
            message: `OpenAI Realtime call failed: ${error.message}`,
            cause: error
          })
      )
    )
    const body = yield* response.text.pipe(
      Effect.mapError(
        error =>
          new OpenAiRealtimeCallError({
            message: `Could not read OpenAI Realtime response: ${error.message}`,
            cause: error
          })
      )
    )

    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new OpenAiRealtimeCallError({
          message: `OpenAI Realtime returned ${response.status}: ${body}`
        })
      )
    }

    return body
  })

const readSdp = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const sdp = yield* request.text

  if (isBlank(sdp)) {
    return yield* Effect.fail(
      new RealtimeCallRouteError({
        message: 'SDP body is required'
      })
    )
  }

  return sdp
})

const handler = Effect.gen(function* () {
  const session = yield* getSession()
  const sdp = yield* readSdp
  const transcriptionModel = yield* readTranscriptionModel
  const apiKey = yield* Config.redacted('OPENAI_API_KEY')
  const toolSet = yield* resolveAgentToolSet({
    modules: [...nodeVoiceToolModules, makeAppKnowledgeToolModule(), makeAppStorageRagToolModule()],
    context: {
      surface: 'voice',
      route: '/agent',
      userId: session.user.id
    }
  })
  const answer = yield* requestOpenAiRealtimeAnswer({
    apiKey,
    sdp,
    tools: toolSet.tools,
    transcriptionModel,
    userId: session.user.id
  })

  return HttpServerResponse.text(answer, {
    contentType: 'application/sdp',
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  })
}).pipe(
  Effect.withSpan('AgentRealtimeCall.post'),
  Effect.catchTag('UnauthenticatedError', () =>
    HttpServerResponse.json({ error: 'Unauthorized' }, { status: 401 })
  ),
  Effect.catchTag('HttpServerError', error =>
    reportError(new RealtimeCallRouteError({ message: 'Invalid SDP request', cause: error }), {
      operation: 'agent.realtime.call',
      status: 400
    }).pipe(
      Effect.andThen(HttpServerResponse.json({ error: 'Invalid SDP request' }, { status: 400 }))
    )
  ),
  Effect.catchTag('RealtimeCallRouteError', error =>
    HttpServerResponse.json({ error: error.message }, { status: 400 })
  ),
  Effect.catchTag('OpenAiRealtimeCallError', error =>
    reportError(error, { operation: 'agent.realtime.call', status: 502 }).pipe(
      Effect.andThen(
        HttpServerResponse.json({ error: 'OpenAI Realtime call failed' }, { status: 502 })
      )
    )
  ),
  Effect.catch(error =>
    reportError(new RealtimeCallRouteError({ message: 'Realtime call failed', cause: error }), {
      operation: 'agent.realtime.call',
      status: 500
    }).pipe(Effect.andThen(HttpServerResponse.json({ error: 'Internal error' }, { status: 500 })))
  )
)

const RouteLayer = Layer.mergeAll(AppLayer, FetchHttpClient.layer)
const { handler: effectHandler } = HttpEffect.toWebHandlerLayer(handler, RouteLayer)

export const POST = (request: Request) => effectHandler(request)
