import { Effect } from 'effect'
import { CredentialSlot, resolveCredential } from '../credential.ts'
import { ConnectorError } from '../error.ts'
import type { ConnectorIntegration } from '../integration.ts'

export const telegramConnectorId = 'telegram'

export const telegramBotTokenSlotId = 'telegram.bot_token'

export const telegramApiBaseUrl = 'https://api.telegram.org'

export const TelegramBotTokenSlot = CredentialSlot.make({
  id: telegramBotTokenSlotId,
  kind: 'api_key'
})

export const resolveTelegramBotToken = (integration: ConnectorIntegration) =>
  Effect.gen(function* () {
    const credential = yield* resolveCredential(integration, TelegramBotTokenSlot)

    switch (credential._tag) {
      case 'ApiKeyCredential':
        return credential.key
      case 'BearerTokenCredential':
        return credential.token
      case 'OAuthCredential':
        return credential.accessToken
      case 'UsernamePasswordCredential':
        return yield* Effect.fail(
          new ConnectorError({
            cause: 'credential_invalid',
            message: 'Telegram connector does not accept username/password credentials',
            connectorId: integration.connectorId,
            slotId: TelegramBotTokenSlot.id
          })
        )
    }
  })
