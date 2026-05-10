import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { Data, Effect, Layer } from 'effect'
import { VoiceToolCallRequest, executeVoiceToolCall } from '@yolk/voice-runtime'
import { AppLayer } from '@/lib/layers'
import { toOpenAiRealtimeToolExecutionResponse } from '@/lib/agents/realtime/tool-bridge'
import { CalculatorToolExecutorLayer } from '@/lib/agents/tools/calculator-tool'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'

export const dynamic = 'force-dynamic'

class RealtimeToolRouteError extends Data.TaggedError('RealtimeToolRouteError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const handler = Effect.gen(function* () {
  yield* getSession()
  const input = yield* HttpServerRequest.schemaBodyJson(VoiceToolCallRequest)
  const result = yield* executeVoiceToolCall(input)
  const response = toOpenAiRealtimeToolExecutionResponse(result)

  return yield* HttpServerResponse.json(response, {
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  })
}).pipe(
  Effect.withSpan('AgentRealtimeTool.post'),
  Effect.catchTag('UnauthenticatedError', () =>
    HttpServerResponse.json({ error: 'Unauthorized' }, { status: 401 })
  ),
  Effect.catchTag('HttpServerError', error =>
    reportError(new RealtimeToolRouteError({ message: 'Invalid tool request', cause: error }), {
      operation: 'agent.realtime.tool',
      status: 400
    }).pipe(Effect.andThen(HttpServerResponse.json({ error: 'Invalid tool request' }, { status: 400 })))
  ),
  Effect.catchTag('SchemaError', error =>
    reportError(new RealtimeToolRouteError({ message: 'Invalid tool request', cause: error }), {
      operation: 'agent.realtime.tool',
      status: 400
    }).pipe(Effect.andThen(HttpServerResponse.json({ error: 'Invalid tool request' }, { status: 400 })))
  ),
  Effect.catch(error =>
    reportError(new RealtimeToolRouteError({ message: 'Realtime tool failed', cause: error }), {
      operation: 'agent.realtime.tool',
      status: 500
    }).pipe(Effect.andThen(HttpServerResponse.json({ error: 'Internal error' }, { status: 500 })))
  )
)

const RouteLayer = Layer.mergeAll(AppLayer, CalculatorToolExecutorLayer)
const { handler: effectHandler } = HttpEffect.toWebHandlerLayer(handler, RouteLayer)

export const POST = (request: Request) => effectHandler(request)
