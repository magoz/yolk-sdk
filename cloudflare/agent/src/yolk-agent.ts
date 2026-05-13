import * as Cloudflare from 'alchemy/Cloudflare'
import { Clock, Effect } from 'effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientError
} from 'effect/unstable/http'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import {
  ContextTransformer,
  LLMDone,
  LLMProvider,
  LLMTextDelta,
  LoopConfig
} from '@yolk/agent-loop'
import type { ToolExecutor } from '@yolk/agent-loop'
import {
  latestIncompleteRuntimeRun,
  replayRuntimeSessionEvents,
  runRuntime,
  type RuntimeSessionEventLog
} from '@yolk/agent-runtime'
import {
  AgentError,
  AgentMessage,
  AgentWebSocketClientMessage,
  SessionSnapshot,
  UserInput,
  UserMessage,
  assistantContent,
  contentText,
  type AgentEvent as AgentEventType
} from '@yolk/protocol'
import { formatAvailableSkills, type MergedSkillset } from '@yolk/skillset'
import { makeToolExecutorLayer, type ToolRegistryError } from '@yolk/tool-registry'
import { makeCodexWsProviderLayer } from './codex-ws-provider.ts'
import { agentTextModel } from '../../../lib/agents/text-agent-config.ts'
import { resolveAgentToolSet } from '../../../lib/agents/tools/resolve-toolset.ts'
import { cloudflareRuntimeErrorToAgentError } from './cloudflare-error.ts'
import {
  isCodexTokenFresh,
  makeCodexTokenBrokerRequest
} from './codex-token-broker.ts'
import { generatedSkillsetManifest } from './generated/skillset.ts'
import {
  interruptLatestIncompleteRun,
  loadRuntimeEventLogOrEmpty,
  makeDurableObjectSessionEventStoreLayer,
  runtimeEventsStorageKey,
  type RuntimeEventLogStorage
} from './session-event-storage.ts'
import {
  BootstrapRequest,
  CodexAccessToken,
  type BootstrapRequest as BootstrapRequestType,
  type CodexAccessToken as CodexAccessTokenType
} from './schemas.ts'
import { makeCloudflareTextToolModules } from './tool-modules.ts'

type SocketAttachment = {
  readonly sessionId: string
  readonly socketId: string
}

const bootstrapKey = 'bootstrap'
const codexTokenKey = 'codex-access-token'

const cloudflareSystemPrompt = 'You are a minimal Yolk Cloudflare runtime smoke-test agent.'

const availableSkills = formatAvailableSkills(generatedSkillsetManifest.skills)
const cloudflareSkillset: MergedSkillset = {
  skills: generatedSkillsetManifest.skills,
  commands: generatedSkillsetManifest.commands
}
const runtimeBaseConfig = {
  systemPrompt:
    availableSkills.length === 0
      ? cloudflareSystemPrompt
      : `${cloudflareSystemPrompt}\n\n${availableSkills}`,
  model: agentTextModel
}

const messageText = (message: string | ArrayBuffer) =>
  typeof message === 'string' ? message : new TextDecoder().decode(message)

const decodeClientMessage = (message: string | ArrayBuffer) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(AgentWebSocketClientMessage))(
    messageText(message)
  )

const encodeEvent = (event: AgentEventType) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(event)

const encodeJson = (value: unknown) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(value)

const sendJson = (socket: Cloudflare.DurableWebSocket, value: unknown) =>
  encodeJson(value).pipe(Effect.flatMap(encoded => socket.send(encoded)))

const sendEvent = (socket: Cloudflare.DurableWebSocket, event: AgentEventType) =>
  encodeEvent(event).pipe(Effect.flatMap(encoded => socket.send(encoded)))

const toAgentError = (
  error: Parameters<typeof cloudflareRuntimeErrorToAgentError>[0] | AgentError
) => (Schema.is(AgentError)(error) ? error : cloudflareRuntimeErrorToAgentError(error))

const httpClientMessage = (error: HttpClientError.HttpClientError) => error.message

const tokenBrokerErrorMessage = (status: number, body: string) => {
  const normalized = body.trim()

  if (normalized.length === 0) {
    return `Could not load Codex token: ${status}`
  }

  return `Could not load Codex token: ${status} ${normalized}`
}

const replayHydratedMessages = (log: RuntimeSessionEventLog) =>
  Schema.decodeUnknownEffect(Schema.Array(AgentMessage))(replayRuntimeSessionEvents(log.events))

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

const toolRegistryErrorToAgentError = (error: ToolRegistryError) =>
  AgentError.make({
    code: 'tool_error',
    message: error.message,
    retryable: false
  })

export default class YolkAgent extends Cloudflare.DurableObjectNamespace<YolkAgent>()(
  'YolkAgent',
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState
      const sockets = new Map<string, Cloudflare.DurableWebSocket>()

      const runtimeEventLogStorage: RuntimeEventLogStorage = {
        get: () => state.storage.get<RuntimeSessionEventLog>(runtimeEventsStorageKey),
        put: log => state.storage.put(runtimeEventsStorageKey, log)
      }

      const loadLogOrEmpty = (sessionId: string) =>
        loadRuntimeEventLogOrEmpty(sessionId, runtimeEventLogStorage)

      const loadBootstrap = () =>
        state.storage.get<BootstrapRequestType>(bootstrapKey).pipe(
          Effect.flatMap(bootstrap =>
            bootstrap === undefined
              ? Effect.fail(
                  AgentError.make({
                    code: 'validation_error',
                    message: 'Cloudflare session is not bootstrapped',
                    retryable: false
                  })
                )
              : Effect.succeed(bootstrap)
          )
        )

      const requestCodexToken = (bootstrap: BootstrapRequestType) =>
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient
          const body = yield* encodeJson(makeCodexTokenBrokerRequest(bootstrap.userId))
          const response = yield* client
            .execute(
              HttpClientRequest.post(bootstrap.tokenEndpoint).pipe(
                HttpClientRequest.setHeaders({
                  accept: 'application/json',
                  'content-type': 'application/json',
                  'x-yolk-cloudflare-secret': bootstrap.bridgeSecret
                }),
                HttpClientRequest.bodyText(body, 'application/json')
              )
            )
            .pipe(
              Effect.mapError(error =>
                AgentError.make({
                  code: 'provider_error',
                  message: `Could not request Codex token: ${httpClientMessage(error)}`,
                  retryable: true
                })
              )
            )

          if (response.status < 200 || response.status >= 300) {
            const text = yield* response.text.pipe(
              Effect.mapError(error =>
                AgentError.make({
                  code: 'provider_error',
                  message: `Could not read Codex token error: ${httpClientMessage(error)}`,
                  retryable: false
                })
              )
            )

            return yield* Effect.fail(
              AgentError.make({
                code: 'provider_error',
                message: tokenBrokerErrorMessage(response.status, text),
                retryable: response.status >= 500
              })
            )
          }

          const json = yield* response.json.pipe(
            Effect.mapError(error =>
              AgentError.make({
                code: 'invalid_response',
                message: `Could not parse Codex token response: ${httpClientMessage(error)}`,
                retryable: false
              })
            )
          )

          return yield* Schema.decodeUnknownEffect(CodexAccessToken)(json).pipe(
            Effect.mapError(error =>
              AgentError.make({
                code: 'invalid_response',
                message: error.message,
                retryable: false
              })
            )
          )
        }).pipe(Effect.provide(FetchHttpClient.layer))

      const getCodexToken = () =>
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis
          const cached = yield* state.storage.get<CodexAccessTokenType>(codexTokenKey)

          if (cached !== undefined && isCodexTokenFresh(cached, nowMs)) {
            return cached
          }

          const bootstrap = yield* loadBootstrap()
          const token = yield* requestCodexToken(bootstrap)
          yield* state.storage.put(codexTokenKey, token)

          return token
        })

      const resolveCloudflareToolSet = (sessionId: string) =>
        Effect.gen(function* () {
          const bootstrap = yield* state.storage.get<BootstrapRequestType>(bootstrapKey)

          const modules = yield* makeCloudflareTextToolModules(bootstrap?.mcpServers ?? [])

          return yield* resolveAgentToolSet({
            modules,
            context: {
              surface: 'text',
              route: '/agent/cloudflare',
              userId: bootstrap?.userId ?? sessionId,
              skillset: cloudflareSkillset
            }
          }).pipe(Effect.mapError(toolRegistryErrorToAgentError))
        })

      const makeRuntimeLayer = (
        sessionId: string,
        toolExecutorLayer: Layer.Layer<ToolExecutor, never, never>
      ) =>
        Layer.unwrap(
          state.storage.get<BootstrapRequestType>(bootstrapKey).pipe(
            Effect.flatMap(bootstrap =>
              bootstrap === undefined
                ? Effect.succeed(makeFauxProviderLayer)
                : getCodexToken().pipe(
                    Effect.map(token =>
                      makeCodexWsProviderLayer({
                        token,
                        sessionId,
                        fallback:
                          bootstrap.codexResponsesEndpoint === undefined
                            ? undefined
                            : {
                                endpoint: bootstrap.codexResponsesEndpoint,
                                bridgeSecret: bootstrap.bridgeSecret
                              }
                      }).pipe(Layer.provide(FetchHttpClient.layer))
                    )
                  )
            ),
            Effect.map(providerLayer =>
              Layer.mergeAll(
                ContextTransformer.identity,
                LoopConfig.defaultLayer,
                providerLayer,
                toolExecutorLayer,
                makeDurableObjectSessionEventStoreLayer(sessionId, runtimeEventLogStorage)
              )
            )
          )
        )

      const handleUserInput = Effect.fnUntraced(function* (
        socket: Cloudflare.DurableWebSocket,
        sessionId: string,
        input: UserInput
      ) {
        const log = yield* loadLogOrEmpty(sessionId)
        const activeRun = latestIncompleteRuntimeRun(log.events)

        if (Option.isSome(activeRun)) {
          yield* sendEvent(
            socket,
            AgentError.make({
              code: 'conflict',
              message: 'Run already active',
              retryable: false
            })
          )
          return
        }

        const resolvedToolSet = yield* resolveCloudflareToolSet(sessionId).pipe(Effect.result)

        if (resolvedToolSet._tag === 'Failure') {
          yield* sendEvent(socket, resolvedToolSet.failure)
          return
        }

        const toolSet = resolvedToolSet.success

        yield* runRuntime(
          {
            _tag: 'AppendInput',
            sessionId,
            input: input.message,
            runId: crypto.randomUUID(),
            expectedRevision: input.expectedRevision
          },
          { ...runtimeBaseConfig, tools: toolSet.tools, reasoningEffort: input.reasoningEffort }
        ).pipe(
          Stream.runForEach(event => sendEvent(socket, event)),
          Effect.provide(makeRuntimeLayer(sessionId, makeToolExecutorLayer(toolSet))),
          Effect.catch(error => sendEvent(socket, toAgentError(error)))
        )
      })

      for (const socket of yield* state.getWebSockets()) {
        const attachment = socket.deserializeAttachment<SocketAttachment>()

        if (attachment !== null) {
          sockets.set(attachment.socketId, socket)
        }
      }

      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest

          if (request.method === 'POST') {
            const bootstrap = yield* HttpServerRequest.schemaBodyJson(BootstrapRequest)
            yield* state.storage.put(bootstrapKey, bootstrap)
            yield* state.storage.delete(codexTokenKey)

            return yield* HttpServerResponse.json({ ok: true })
          }

          const [response, socket] = yield* Cloudflare.upgrade()
          const socketId = crypto.randomUUID()
          const sessionId = state.id.toString()
          yield* interruptLatestIncompleteRun(sessionId, runtimeEventLogStorage)
          const log = yield* loadLogOrEmpty(sessionId)
          const messages = yield* replayHydratedMessages(log)

          socket.serializeAttachment({ sessionId, socketId })
          sockets.set(socketId, socket)
          yield* sendJson(
            socket,
            SessionSnapshot.make({
              revision: log.revision,
              messages
            })
          )

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

          const decodedInput = yield* decodeClientMessage(message).pipe(Effect.result)

          if (decodedInput._tag === 'Failure') {
            return yield* handleUserInput(
              socket,
              attachment.sessionId,
              UserInput.make({ message: UserMessage.make({ content: messageText(message) }) })
            )
          }

          const input = decodedInput.success
          yield* handleUserInput(socket, attachment.sessionId, input)
        }),
        webSocketClose: Effect.fnUntraced(function* (socket: Cloudflare.DurableWebSocket) {
          const attachment = socket.deserializeAttachment<SocketAttachment>()

          if (attachment !== null) {
            sockets.delete(attachment.socketId)
          }
        })
      }
    })
  })
) {}
