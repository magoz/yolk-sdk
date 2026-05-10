import { createHash } from 'node:crypto'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpEffect,
  HttpServerRequest,
  HttpServerResponse
} from 'effect/unstable/http'
import { Config, Data, Effect, Layer, Redacted } from 'effect'
import * as Schema from 'effect/Schema'
import { AppLayer } from '@/lib/layers'
import { makeOpenAiRealtimeSessionConfig } from '@/lib/agents/realtime/openai-realtime'
import { resolveAgentTools } from '@/lib/agents/tools/registry'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import type { ToolDef } from '@yolk/protocol'

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

const realtimeInstructions = [
  'You are Yolk voice assistant. Be concise and practical.',
  'Use a short spoken preamble before tool calls, e.g. “Let me calculate that.”',
  'Use the calculate tool for arithmetic. Say the final result clearly.',
  'If a tool fails, explain briefly and keep the conversation moving.'
].join('\n')

const safetyIdentifier = (userId: string) =>
  createHash('sha256').update(`yolk:${userId}`).digest('hex')

const isBlank = (value: string) => value.trim().length === 0

const makeSessionConfigJson = (tools: ReadonlyArray<ToolDef>) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(
    makeOpenAiRealtimeSessionConfig({
      instructions: realtimeInstructions,
      tools
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
  readonly userId: string
}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const sessionConfig = yield* makeSessionConfigJson(input.tools)
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
  const apiKey = yield* Config.redacted('OPENAI_API_KEY')
  const toolSet = yield* resolveAgentTools({
    surface: 'voice',
    route: '/agent',
    userId: session.user.id
  })
  const answer = yield* requestOpenAiRealtimeAnswer({
    apiKey,
    sdp,
    tools: toolSet.tools,
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
    }).pipe(Effect.andThen(HttpServerResponse.json({ error: 'Invalid SDP request' }, { status: 400 })))
  ),
  Effect.catchTag('RealtimeCallRouteError', error =>
    HttpServerResponse.json({ error: error.message }, { status: 400 })
  ),
  Effect.catchTag('OpenAiRealtimeCallError', error =>
    reportError(error, { operation: 'agent.realtime.call', status: 502 }).pipe(
      Effect.andThen(HttpServerResponse.json({ error: 'OpenAI Realtime call failed' }, { status: 502 }))
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
