import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import {
  ContextTransformer,
  LLMDone,
  LLMProvider,
  LLMTextDelta,
  LoopConfig,
  ToolExecutor
} from '@yolk/agent-loop'
import {
  appendRuntimeSessionEventsToLog,
  latestIncompleteRuntimeRun,
  type RuntimeSessionEventLog,
  runRuntime,
  RunInterrupted,
  SessionConflictError,
  SessionEventStore,
  SessionNotFoundError
} from '@yolk/agent-runtime'
import {
  AgentError,
  assistantContent,
  contentText,
  UserMessage,
  type AgentEvent as AgentEventType
} from '@yolk/protocol'
import { cloudflareRuntimeErrorToAgentError } from './cloudflare-error.ts'

type SocketAttachment = {
  readonly sessionId: string
  readonly socketId: string
}

const eventsKey = 'runtime-events'

const runtimeConfig = {
  systemPrompt: 'You are a minimal Yolk Cloudflare runtime smoke-test agent.',
  tools: [],
  model: 'faux-cloudflare'
}

const messageText = (message: string | ArrayBuffer) =>
  typeof message === 'string' ? message : new TextDecoder().decode(message)

const encodeEvent = (event: AgentEventType) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(event)

const sendEvent = (socket: Cloudflare.DurableWebSocket, event: AgentEventType) =>
  encodeEvent(event).pipe(Effect.flatMap(encoded => socket.send(encoded)))

const emptyLog = (sessionId: string): RuntimeSessionEventLog => ({
  sessionId,
  revision: 0,
  events: []
})

const makeFauxProviderLayer = Layer.succeed(
  LLMProvider,
  LLMProvider.of({
    stream: request => {
      const last = request.messages.at(-1)
      const text =
        last === undefined
          ? ''
          : last._tag === 'Assistant'
            ? contentText(assistantContent(last))
            : contentText(last.content)
      const reply = `faux-cloudflare: ${text}`

      return Stream.fromIterable([
        ...reply.split('').map(character => LLMTextDelta.make({ text: character })),
        LLMDone.make({ stopReason: 'stop' })
      ])
    }
  })
)

const noToolExecutorLayer = Layer.succeed(
  ToolExecutor,
  ToolExecutor.of({
    execute: () => Effect.die('No tools configured for cloudflare agent smoke test')
  })
)

export default class YolkAgent extends Cloudflare.DurableObjectNamespace<YolkAgent>()(
  'YolkAgent',
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState
      const sockets = new Map<string, Cloudflare.DurableWebSocket>()

      const makeSessionEventStoreLayer = (sessionId: string) =>
        Layer.succeed(
          SessionEventStore,
          SessionEventStore.of({
            load: () =>
              state.storage.get<RuntimeSessionEventLog>(eventsKey).pipe(
                Effect.flatMap(log =>
                  log === undefined
                    ? Effect.fail(new SessionNotFoundError({ sessionId }))
                    : Effect.succeed(log)
                )
              ),
            append: input =>
              Effect.gen(function* () {
                const current =
                  (yield* state.storage.get<RuntimeSessionEventLog>(eventsKey)) ?? emptyLog(sessionId)

                if (
                  input.expectedRevision !== undefined &&
                  input.expectedRevision !== current.revision
                ) {
                  return yield* Effect.fail(
                    new SessionConflictError({
                      sessionId,
                      message: `Session revision conflict: expected ${input.expectedRevision}, got ${current.revision}`
                    })
                  )
                }

                const next = appendRuntimeSessionEventsToLog(current, input)
                yield* state.storage.put(eventsKey, next)

                return next
              })
          })
        )

      const makeRuntimeLayer = (sessionId: string) =>
        Layer.mergeAll(
          ContextTransformer.identity,
          LoopConfig.defaultLayer,
          makeFauxProviderLayer,
          noToolExecutorLayer,
          makeSessionEventStoreLayer(sessionId)
        )

      const interruptLatestIncompleteRun = (sessionId: string) =>
        Effect.gen(function* () {
          const log = yield* state.storage.get<RuntimeSessionEventLog>(eventsKey)

          if (log === undefined) {
            return
          }

          const activeRun = latestIncompleteRuntimeRun(log.events)

          if (Option.isNone(activeRun)) {
            return
          }

          const next = appendRuntimeSessionEventsToLog(log, {
            sessionId,
            expectedRevision: log.revision,
            events: [RunInterrupted.make({ runId: activeRun.value.runId })]
          })

          yield* state.storage.put(eventsKey, next)
        })

      for (const socket of yield* state.getWebSockets()) {
        const attachment = socket.deserializeAttachment<SocketAttachment>()

        if (attachment !== null) {
          sockets.set(attachment.socketId, socket)
        }
      }

      return {
        fetch: Effect.gen(function* () {
          const [response, socket] = yield* Cloudflare.upgrade()
          const socketId = crypto.randomUUID()
          const sessionId = state.id.toString()

          yield* interruptLatestIncompleteRun(sessionId)
          socket.serializeAttachment({ sessionId, socketId })
          sockets.set(socketId, socket)

          return response
        }),
        webSocketMessage: Effect.fnUntraced(function* (
          socket: Cloudflare.DurableWebSocket,
          message: string | ArrayBuffer
        ) {
          const attachment = socket.deserializeAttachment<SocketAttachment>()

          if (attachment === null) {
            yield* sendEvent(
              socket,
              AgentError.make({
                code: 'unknown',
                message: 'Missing socket attachment',
                retryable: false
              })
            )
            return
          }

          const input = messageText(message)

          yield* runRuntime(
            {
              _tag: 'AppendInput',
              sessionId: attachment.sessionId,
              input: UserMessage.make({ content: input }),
              runId: crypto.randomUUID()
            },
            runtimeConfig
          ).pipe(
            Stream.runForEach(event => sendEvent(socket, event)),
            Effect.provide(makeRuntimeLayer(attachment.sessionId)),
            Effect.catch(error => sendEvent(socket, cloudflareRuntimeErrorToAgentError(error)))
          )
        }),
        webSocketClose: Effect.fnUntraced(function* (
          socket: Cloudflare.DurableWebSocket,
          code: number,
          reason: string
        ) {
          const attachment = socket.deserializeAttachment<SocketAttachment>()

          if (attachment !== null) {
            sockets.delete(attachment.socketId)
          }

          yield* socket.close(code, reason)
        })
      }
    })
  })
) {}
