import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { Array as Arr, Data, Effect, Option, Schema } from 'effect'
import { AppLayer } from '@/lib/layers'
import { loadRuntimeSkillset } from '@/lib/agents/skillset/project-source'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { commandSummary, renderCommandResponse } from './route-model'

export const dynamic = 'force-dynamic'

class AgentCommandRouteError extends Data.TaggedError('AgentCommandRouteError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

class AgentCommandNotFoundError extends Data.TaggedError('AgentCommandNotFoundError')<{
  readonly command: string
}> {}

class AgentCommandRenderRequest extends Schema.Class<AgentCommandRenderRequest>(
  'AgentCommandRenderRequest'
)({
  command: Schema.String,
  arguments: Schema.String
}) {}

const listHandler = Effect.gen(function* () {
  const session = yield* getSession()
  const skillset = yield* loadRuntimeSkillset({ userId: session.user.id })

  return yield* HttpServerResponse.json(
    { commands: Arr.map(skillset.commands, commandSummary) },
    {
      headers: {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      }
    }
  )
}).pipe(
  Effect.withSpan('AgentCommandsRoute.get'),
  Effect.catchTag('UnauthenticatedError', () =>
    HttpServerResponse.json({ error: 'Unauthorized' }, { status: 401 })
  ),
  Effect.catch(error =>
    reportError(new AgentCommandRouteError({ message: 'Command list failed', cause: error }), {
      operation: 'agent.commands.list',
      status: 500
    }).pipe(Effect.andThen(HttpServerResponse.json({ error: 'Internal error' }, { status: 500 })))
  )
)

const renderHandler = Effect.gen(function* () {
  const session = yield* getSession()
  const input = yield* HttpServerRequest.schemaBodyJson(AgentCommandRenderRequest)
  const skillset = yield* loadRuntimeSkillset({ userId: session.user.id })
  const command = yield* Option.match(
    Arr.findFirst(skillset.commands, item => item.name === input.command),
    {
      onNone: () => Effect.fail(new AgentCommandNotFoundError({ command: input.command })),
      onSome: command => Effect.succeed(command)
    }
  )

  return yield* HttpServerResponse.json(renderCommandResponse(command, input.arguments), {
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  })
}).pipe(
  Effect.withSpan('AgentCommandsRoute.post'),
  Effect.catchTag('UnauthenticatedError', () =>
    HttpServerResponse.json({ error: 'Unauthorized' }, { status: 401 })
  ),
  Effect.catchTag('AgentCommandNotFoundError', () =>
    HttpServerResponse.json({ error: 'Command not found' }, { status: 404 })
  ),
  Effect.catchTag('HttpServerError', error =>
    reportError(new AgentCommandRouteError({ message: 'Invalid command request', cause: error }), {
      operation: 'agent.commands.render',
      status: 400
    }).pipe(
      Effect.andThen(HttpServerResponse.json({ error: 'Invalid command request' }, { status: 400 }))
    )
  ),
  Effect.catchTag('SchemaError', error =>
    reportError(new AgentCommandRouteError({ message: 'Invalid command request', cause: error }), {
      operation: 'agent.commands.render',
      status: 400
    }).pipe(
      Effect.andThen(HttpServerResponse.json({ error: 'Invalid command request' }, { status: 400 }))
    )
  ),
  Effect.catch(error =>
    reportError(new AgentCommandRouteError({ message: 'Command render failed', cause: error }), {
      operation: 'agent.commands.render',
      status: 500
    }).pipe(Effect.andThen(HttpServerResponse.json({ error: 'Internal error' }, { status: 500 })))
  )
)

const { handler: listEffectHandler } = HttpEffect.toWebHandlerLayer(listHandler, AppLayer)
const { handler: renderEffectHandler } = HttpEffect.toWebHandlerLayer(renderHandler, AppLayer)

export const GET = (request: Request) => listEffectHandler(request)
export const POST = (request: Request) => renderEffectHandler(request)
