import { readFile } from 'node:fs/promises'
import {
  Clock,
  Config,
  Data,
  Deferred,
  Effect,
  Match,
  Option,
  Predicate,
  Ref,
  Stream
} from 'effect'
import * as Schema from 'effect/Schema'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http'
import * as Socket from 'effect/unstable/socket/Socket'
import { AgentWebSocketServerMessage } from '@yolk-sdk/agent/protocol'

const statePath = '.alchemy/state/YolkAgentWorker/dev_magoz/Api.json'

const timeoutMs = 10_000

class SmokeConfigError extends Data.TaggedError('SmokeConfigError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

class SmokeHttpError extends Data.TaggedError('SmokeHttpError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

class SmokeProtocolError extends Data.TaggedError('SmokeProtocolError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const AlchemyStateSchema = Schema.Struct({
  attr: Schema.Struct({
    url: Schema.String
  })
})

type SmokeEvent = typeof AgentWebSocketServerMessage.Type

const decodeAlchemyState = Schema.decodeUnknownEffect(Schema.fromJsonString(AlchemyStateSchema))

const decodeServerMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AgentWebSocketServerMessage)
)

const readStateFile = Effect.tryPromise({
  try: () => readFile(statePath, 'utf8'),
  catch: error =>
    new SmokeConfigError({
      message: `Could not read ${statePath}`,
      cause: error
    })
})

const readDeployedUrl = Effect.gen(function* () {
  const configuredUrl = yield* Config.option(Config.String('CLOUDFLARE_AGENT_URL'))

  if (Option.isSome(configuredUrl)) {
    return configuredUrl.value
  }

  const raw = yield* readStateFile

  const state = yield* decodeAlchemyState(raw).pipe(
    Effect.mapError(
      error =>
        new SmokeConfigError({
          message: `Missing attr.url in ${statePath}: ${error.message}`,
          cause: error
        })
    )
  )

  return state.attr.url
}).pipe(
  Effect.catchTag('ConfigError', error =>
    Effect.fail(
      new SmokeConfigError({
        message: `Could not read Cloudflare agent URL: ${error.message}`,
        cause: error
      })
    )
  )
)

const websocketUrl = (url: string, sessionId: string): Effect.Effect<string, SmokeConfigError> =>
  Effect.try({
    try: () => {
      const parsed = new URL(url)
      parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
      parsed.pathname = `/connect/${sessionId}`

      return parsed.toString()
    },
    catch: error =>
      new SmokeConfigError({
        message: 'Invalid Cloudflare agent URL',
        cause: error
      })
  })

const decodeSmokeEvent = (data: string) =>
  decodeServerMessage(data).pipe(
    Effect.mapError(
      error =>
        new SmokeProtocolError({
          message: `Could not decode smoke event: ${error.message}`,
          cause: error
        })
    )
  )

const smokeWebSocket = (
  url: string
): Effect.Effect<ReadonlyArray<SmokeEvent>, SmokeConfigError | SmokeProtocolError> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const sessionId = `smoke-${now}`
    const input = `hello ${sessionId}`
    const expectedText = `faux-cloudflare: ${input}`
    const wsUrl = yield* websocketUrl(url, sessionId)

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const socket = yield* Socket.makeWebSocket(wsUrl)

        const write = yield* socket.writer
        const eventsRef = yield* Ref.make<ReadonlyArray<SmokeEvent>>([])
        const collectedTextRef = yield* Ref.make('')
        const done = yield* Deferred.make<ReadonlyArray<SmokeEvent>, SmokeProtocolError>()

        const failDone = (message: string, cause?: unknown) =>
          Deferred.fail(done, new SmokeProtocolError({ message, cause }))

        const handleMessage = (data: string) =>
          Effect.gen(function* () {
            const decoded = yield* decodeSmokeEvent(data)
            const events = yield* Ref.updateAndGet(eventsRef, existing => [...existing, decoded])

            yield* Match.value(decoded).pipe(
              Match.tag('LLMTextDelta', current =>
                Ref.update(collectedTextRef, text => `${text}${current.text}`)
              ),
              Match.tag('AgentError', current =>
                Effect.gen(function* () {
                  yield* failDone(current.message)
                  yield* write.write(new Socket.CloseEvent(1000))
                })
              ),
              Match.tag('AgentEnd', () =>
                Effect.gen(function* () {
                  const collectedText = yield* Ref.get(collectedTextRef)

                  if (collectedText !== expectedText) {
                    yield* failDone(`Unexpected text: ${collectedText}`)
                    yield* write.write(new Socket.CloseEvent(1000))

                    return
                  }

                  yield* Deferred.succeed(done, events)
                  yield* write.write(new Socket.CloseEvent(1000))
                })
              ),
              Match.orElse(() => Effect.void)
            )
          })

        const runSocket = Stream.fromPull(
          Socket.readerString(socket).pipe(Effect.tap(() => Effect.ignore(write.write(input))))
        ).pipe(
          Stream.runForEach(handleMessage),
          Effect.catchTag('SocketError', error =>
            Predicate.isTagged(error.reason, 'SocketCloseError') && error.reason.code === 1000
              ? Effect.void
              : Effect.fail(error)
          ),
          Effect.flatMap(() => Deferred.await(done)),
          Effect.catchTag('SocketError', error =>
            Effect.fail(
              new SmokeProtocolError({
                message: `WebSocket failed before AgentEnd: ${error.message}`,
                cause: error
              })
            )
          )
        )

        return yield* Effect.raceFirst(Deferred.await(done), runSocket).pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () =>
              Effect.gen(function* () {
                const collectedText = yield* Ref.get(collectedTextRef)

                return yield* Effect.fail(
                  new SmokeProtocolError({
                    message: `Timed out waiting for AgentEnd; collected=${collectedText}`
                  })
                )
              })
          })
        )
      })
    ).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal))
  })

const checkHealth = (url: string): Effect.Effect<void, SmokeHttpError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.get(`${url}/health`)

    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        error =>
          new SmokeHttpError({
            message: `Health request failed: ${error.message}`,
            cause: error
          })
      )
    )

    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new SmokeHttpError({ message: `Health failed: ${response.status}` })
      )
    }

    const body = yield* response.text.pipe(
      Effect.mapError(
        error =>
          new SmokeHttpError({
            message: `Could not read health response: ${error.message}`,
            cause: error
          })
      )
    )

    if (body !== 'ok') {
      return yield* Effect.fail(new SmokeHttpError({ message: `Unexpected health body: ${body}` }))
    }
  })

const main = Effect.gen(function* () {
  const url = yield* readDeployedUrl
  yield* checkHealth(url)
  const events = yield* smokeWebSocket(url)

  console.log(`ok ${url}`)
  console.log(`events ${events.map(event => event._tag).join(' ')}`)
}).pipe(Effect.provide(FetchHttpClient.layer))

await Effect.runPromise(main)
