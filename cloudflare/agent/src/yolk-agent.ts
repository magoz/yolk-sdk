import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
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
import { runRuntime, SessionStore } from '@yolk/agent-runtime'
import {
  AgentError,
  assistantContent,
  contentText,
  UserMessage,
  type AgentEvent as AgentEventType,
  type AgentMessage
} from '@yolk/protocol'
import { cloudflareRuntimeErrorToAgentError } from './cloudflare-error.ts'

type SocketAttachment = {
  readonly sessionId: string
  readonly socketId: string
}

const messagesKey = 'messages'

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

      const makeSessionStoreLayer = (sessionId: string) =>
        Layer.succeed(
          SessionStore,
          SessionStore.of({
            load: () =>
              state.storage.get<ReadonlyArray<AgentMessage>>(messagesKey).pipe(
                Effect.map(messages => ({
                  id: sessionId,
                  messages: messages ?? []
                }))
              ),
            save: snapshot => state.storage.put(messagesKey, snapshot.messages)
          })
        )

      const makeRuntimeLayer = (sessionId: string) =>
        Layer.mergeAll(
          ContextTransformer.identity,
          LoopConfig.defaultLayer,
          makeFauxProviderLayer,
          noToolExecutorLayer,
          makeSessionStoreLayer(sessionId)
        )

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
              _tag: 'Input',
              sessionId: attachment.sessionId,
              input: UserMessage.make({ content: input })
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
