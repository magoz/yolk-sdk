import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { Data, Effect } from 'effect'
import * as Schema from 'effect/Schema'
import {
  handleVoiceToolCall,
  VoiceSessionToolCallRequest,
  VoiceToolCall,
  VoiceToolCallOutcome
} from '@yolk-sdk/agent/voice'
import { makeToolExecutorLayer } from '@yolk-sdk/agent/tools'
import { AppLayer } from '@/lib/layers'
import { nodeVoiceToolModules, resolveAgentToolSet } from '@/lib/agents/tools/registry'
import { makeAppStorageKnowledgeSearchToolModule } from '@/lib/agents/tools/storage-tool-handlers'
import { makeAppKnowledgeToolModule } from '@/lib/agents/tools/knowledge-tool-handlers'
import { makeAppTelegramToolModule } from '@/lib/agents/tools/telegram-tool'
import { getTelegramConnectorConfig } from '@/lib/core/agent/telegram-connector'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'

export const dynamic = 'force-dynamic'

class RealtimeToolRouteError extends Data.TaggedError('RealtimeToolRouteError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const encodeOutcome = Schema.encodeEffect(VoiceToolCallOutcome)

const handler = Effect.gen(function* () {
  const session = yield* getSession()
  const input = yield* HttpServerRequest.schemaBodyJson(VoiceSessionToolCallRequest)
  const telegramConnectorConfig = yield* getTelegramConnectorConfig(session.user.id)
  const telegramToolModules = telegramConnectorConfig === undefined
    ? []
    : [makeAppTelegramToolModule(telegramConnectorConfig)]
  const toolSet = yield* resolveAgentToolSet({
    modules: [
      ...nodeVoiceToolModules,
      makeAppKnowledgeToolModule(),
      makeAppStorageKnowledgeSearchToolModule(),
      ...telegramToolModules
    ],
    context: {
      surface: 'voice',
      route: '/agent',
      userId: session.user.id,
      sessionId: input.sessionId
    }
  })
  const outcome = yield* handleVoiceToolCall({
    call: VoiceToolCall.make({
      callId: input.callId,
      name: input.name,
      argumentsJson: input.argumentsJson
    }),
    tools: toolSet.tools,
    approval: input.approval
  }).pipe(Effect.provide(makeToolExecutorLayer(toolSet)))
  const encoded = yield* encodeOutcome(outcome)

  return yield* HttpServerResponse.json(encoded, {
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
    }).pipe(
      Effect.andThen(HttpServerResponse.json({ error: 'Invalid tool request' }, { status: 400 }))
    )
  ),
  Effect.catchTag('SchemaError', error =>
    reportError(new RealtimeToolRouteError({ message: 'Invalid tool request', cause: error }), {
      operation: 'agent.realtime.tool',
      status: 400
    }).pipe(
      Effect.andThen(HttpServerResponse.json({ error: 'Invalid tool request' }, { status: 400 }))
    )
  ),
  Effect.catch(error =>
    reportError(new RealtimeToolRouteError({ message: 'Realtime tool failed', cause: error }), {
      operation: 'agent.realtime.tool',
      status: 500
    }).pipe(Effect.andThen(HttpServerResponse.json({ error: 'Internal error' }, { status: 500 })))
  )
)

const { handler: effectHandler } = HttpEffect.toWebHandlerLayer(handler, AppLayer)

export const POST = (request: Request) => effectHandler(request)
