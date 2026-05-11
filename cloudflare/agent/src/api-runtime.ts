import * as Effect from 'effect/Effect'
import { HttpServerRequest } from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import { Api } from './api.ts'
import YolkAgent from './yolk-agent.ts'

const connectPath = '/connect/'

export default Api.make(
  Effect.gen(function* () {
    const agents = yield* YolkAgent

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest

        if (request.url === '/health') {
          return HttpServerResponse.text('ok')
        }

        if (request.url.startsWith(connectPath)) {
          const sessionId = request.url.slice(connectPath.length)

          if (sessionId.length === 0) {
            return HttpServerResponse.text('Missing session id', { status: 400 })
          }

          return yield* agents.getByName(sessionId).fetch(request)
        }

        return HttpServerResponse.text('Not found', { status: 404 })
      })
    }
  })
)
