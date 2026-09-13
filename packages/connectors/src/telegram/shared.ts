import { Effect, Match } from 'effect'
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

    return yield* Match.value(credential).pipe(
      Match.tag('ApiKeyCredential', current => Effect.succeed(current.key)),
      Match.tag('BearerTokenCredential', current => Effect.succeed(current.token)),
      Match.tag('OAuthCredential', current => Effect.succeed(current.accessToken)),
      Match.tag('UsernamePasswordCredential', () =>
        Effect.fail(
          new ConnectorError({
            cause: 'credential_invalid',
            message: 'Telegram connector does not accept username/password credentials',
            connectorId: integration.connectorId,
            slotId: TelegramBotTokenSlot.id
          })
        )
      ),
      Match.exhaustive
    )
  })
