import { Effect, Layer } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { ToolError } from '@yolk-sdk/agent/loop'
import { ToolResult } from '@yolk-sdk/agent/protocol'
import { makeTool, type ToolModule } from '@yolk-sdk/agent/tools'
import {
  ApiKeyCredential,
  ConnectorError,
  ConnectorHttpClient,
  ConnectorHttpResponse,
  CredentialResolver,
  makeCredentialBinding,
  makeIntegration
} from '@yolk-sdk/connectors'
import type { ConnectorHttpRequest } from '@yolk-sdk/connectors'
import {
  TelegramConnector,
  TelegramSendMessageInput,
  telegramBotTokenSlotId,
  telegramConnectorId
} from '@yolk-sdk/connectors/telegram'
import type { AgentToolContext } from './tool-context.ts'

const telegramToolName = 'telegram_send_message'
const telegramCredentialRef = 'app:telegram_bot_token'

export type TelegramToolConfig = {
  readonly botToken: string
  readonly chatId: string
}

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const makeToolError = (message: string, cause: ToolError['cause']) =>
  new ToolError({ tool: telegramToolName, message, cause })

const providerFailureContent = (error: {
  readonly code: string
  readonly message: string
  readonly status?: number
  readonly underlying?: unknown
}) => {
  const status = error.status === undefined ? '' : ` (HTTP ${error.status})`
  const underlying =
    typeof error.underlying === 'string' && error.underlying.length > 0
      ? `: ${error.underlying}`
      : ''

  return `${error.code}${status}: ${error.message}${underlying}`
}

const responseHeaders = (headers: Readonly<Record<string, string | undefined>>) => {
  const result: Record<string, string> = {}

  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result[key] = value
    }
  }

  return result
}

const contentType = (headers: Readonly<Record<string, string>> | undefined) =>
  headers?.['content-type'] ?? headers?.['Content-Type']

export const makeConnectorHttpRequest = (request: ConnectorHttpRequest) =>
  HttpClientRequest.make(request.method)(request.url).pipe(
    HttpClientRequest.setHeaders(request.headers ?? {}),
    HttpClientRequest.bodyText(request.body ?? '', contentType(request.headers))
  )

const makeConnectorHttpClientLayer = Layer.effect(
  ConnectorHttpClient,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    return ConnectorHttpClient.of({
      request: (request: ConnectorHttpRequest) =>
        Effect.gen(function* () {
          const httpRequest = makeConnectorHttpRequest(request)
          const response = yield* http.execute(httpRequest)
          const body = yield* response.text.pipe(
            Effect.mapError(
              error =>
                new ConnectorError({
                  cause: 'validation_failed',
                  message: 'Could not read Telegram response body',
                  connectorId: telegramConnectorId,
                  underlying: error
                })
            )
          )

          return ConnectorHttpResponse.make({
            status: response.status,
            headers: responseHeaders(response.headers),
            body
          })
        }).pipe(
          Effect.mapError(error =>
            error instanceof ConnectorError
              ? error
              : new ConnectorError({
                  cause: 'validation_failed',
                  message: 'Telegram HTTP request failed',
                  connectorId: telegramConnectorId,
                  underlying: error
                })
          )
        )
    })
  })
).pipe(Layer.provide(FetchHttpClient.layer))

const makeCredentialResolverLayer = (config: TelegramToolConfig) =>
  Layer.succeed(
    CredentialResolver,
    CredentialResolver.of({
      resolve: request =>
        request.binding.credentialRef === telegramCredentialRef
          ? Effect.succeed(
              ApiKeyCredential.make({
                _tag: 'ApiKeyCredential',
                key: config.botToken
              })
            )
          : Effect.fail(
              new ConnectorError({
                cause: 'credential_missing',
                message: `Unsupported Telegram credential ref: ${request.binding.credentialRef}`,
                connectorId: request.integration.connectorId,
                slotId: request.slot.id
              })
            )
    })
  )

const makeTelegramIntegration = (config: TelegramToolConfig) =>
  makeIntegration({
    connectorId: telegramConnectorId,
    config: { chatId: config.chatId },
    credentialBindings: [
      makeCredentialBinding({
        slotId: telegramBotTokenSlotId,
        credentialRef: telegramCredentialRef
      })
    ]
  })

const makeTelegramLayer = (config: TelegramToolConfig) =>
  Layer.mergeAll(makeCredentialResolverLayer(config), makeConnectorHttpClientLayer)

export const makeAppTelegramToolModule = (
  config: TelegramToolConfig
): ToolModule<AgentToolContext> => {
  const integration = makeTelegramIntegration(config)
  const layer = makeTelegramLayer(config)

  return {
    id: 'telegram',
    tools: [
      makeTool({
        name: telegramToolName,
        description:
          'Send a Telegram message to the configured chat. Use only when the user asks to send or notify via Telegram.',
        parameters: TelegramSendMessageInput,
        access: 'write',
        isEnabled: context =>
          Effect.succeed(context.surface === 'text' || context.surface === 'voice'),
        invalidParamsMessage: error =>
          `Invalid Telegram message arguments: ${unknownToMessage(error)}`,
        execute: ({ call, params }) =>
          TelegramConnector.invoke({
            integration,
            action: 'telegram.send_message',
            input: params
          }).pipe(
            Effect.provide(layer),
            Effect.map(result => {
              switch (result._tag) {
                case 'Success':
                  return ToolResult.make({
                    toolCallId: call.id,
                    content: 'Sent Telegram message.',
                    structuredContent: result.value
                  })
                case 'Failure':
                  return ToolResult.make({
                    toolCallId: call.id,
                    content: providerFailureContent(result.error),
                    isError: true,
                    structuredContent: result.error
                  })
              }
            }),
            Effect.mapError(error =>
              error instanceof ToolError
                ? error
                : makeToolError(`Telegram send failed: ${unknownToMessage(error)}`, 'execution')
            )
          )
      })
    ]
  }
}
