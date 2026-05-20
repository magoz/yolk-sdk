import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineAction } from '../action.ts'
import { requiredStringConfig } from '../config.ts'
import { defineConnector } from '../connector.ts'
import { CredentialSlot, resolveCredential } from '../credential.ts'
import { ConnectorHttpClient, ConnectorHttpRequest } from '../http.ts'
import { ActionResult, ProviderFailure } from '../result.ts'
import type { ConnectorIntegration } from '../integration.ts'

export const telegramConnectorId = 'telegram'
export const telegramBotTokenSlotId = 'telegram.bot_token'
export const telegramApiBaseUrl = 'https://api.telegram.org'

export const TelegramBotTokenSlot = CredentialSlot.make({
  id: telegramBotTokenSlotId,
  kind: 'api_key'
})

const resolveTelegramBotToken = (integration: ConnectorIntegration) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(integration, TelegramBotTokenSlot)

    switch (credential._tag) {
      case 'ApiKeyCredential':
        return credential.key
      case 'BearerTokenCredential':
        return credential.token
      case 'OAuthCredential':
        return credential.accessToken
    }
  })

const isSuccessStatus = (status: number) => status >= 200 && status < 300

const telegramProviderFailure = (input: {
  readonly code: string
  readonly message: string
  readonly status: number
  readonly body: string
}) =>
  ActionResult.failure(
    new ProviderFailure({
      code: input.code,
      message: input.message,
      status: input.status,
      underlying: input.body
    })
  )

export class TelegramSendMessageInput extends Schema.Class<TelegramSendMessageInput>(
  'TelegramSendMessageInput'
)({
  message: Schema.String,
  disableWebPagePreview: Schema.optional(Schema.Boolean)
}) {}

export class TelegramSendMessageOutput extends Schema.Class<TelegramSendMessageOutput>(
  'TelegramSendMessageOutput'
)({
  sent: Schema.Boolean,
  chatId: Schema.String
}) {}

export class TelegramValidateOutput extends Schema.Class<TelegramValidateOutput>('TelegramValidateOutput')({
  ok: Schema.Boolean,
  chatId: Schema.String
}) {}

export const telegramSendMessageAction = defineAction({
  id: 'telegram.send_message',
  description: 'Send a Telegram message to the configured chat.',
  inputSchema: TelegramSendMessageInput,
  outputSchema: TelegramSendMessageOutput,
  execute: ({ integration, input }) =>
    Effect.gen(function* () {
      const botToken = yield* resolveTelegramBotToken(integration)
      const chatId = yield* requiredStringConfig(integration, 'chatId')
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'POST',
          url: `${telegramApiBaseUrl}/bot${botToken}/sendMessage`,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: input.message,
            disable_web_page_preview: input.disableWebPagePreview ?? true
          })
        })
      )

      if (!isSuccessStatus(response.status)) {
        return telegramProviderFailure({
          code: response.status === 429 ? 'telegram_rate_limited' : 'telegram_send_failed',
          message: 'Telegram send message failed',
          status: response.status,
          body: response.body
        })
      }

      return ActionResult.success(TelegramSendMessageOutput.make({ sent: true, chatId }))
    })
})

export const telegramValidateAction = defineAction({
  id: 'telegram.validate',
  description: 'Validate the Telegram bot token and configured chat.',
  inputSchema: Schema.Struct({}),
  outputSchema: TelegramValidateOutput,
  execute: ({ integration }) =>
    Effect.gen(function* () {
      const botToken = yield* resolveTelegramBotToken(integration)
      const chatId = yield* requiredStringConfig(integration, 'chatId')
      const http = yield* ConnectorHttpClient
      const response = yield* http.request(
        ConnectorHttpRequest.make({
          method: 'POST',
          url: `${telegramApiBaseUrl}/bot${botToken}/getChat`,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId })
        })
      )

      if (!isSuccessStatus(response.status)) {
        return telegramProviderFailure({
          code: 'telegram_validate_failed',
          message: 'Telegram validation failed',
          status: response.status,
          body: response.body
        })
      }

      return ActionResult.success(TelegramValidateOutput.make({ ok: true, chatId }))
    })
})

export const telegramActions = [telegramSendMessageAction, telegramValidateAction]

export const TelegramConnector = defineConnector({
  id: telegramConnectorId,
  description: 'Telegram bot connector actions.',
  actions: telegramActions
})
