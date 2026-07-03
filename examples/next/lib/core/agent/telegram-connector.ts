import { Data, Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

export const telegramConnectorProviderId = 'telegram'

export type TelegramConnectorConfig = {
  readonly botToken: string
  readonly chatId: string
}

export type TelegramConnectorStatus =
  | { readonly _tag: 'Connected'; readonly chatId: string }
  | { readonly _tag: 'Disconnected' }

export class TelegramConnectorValidationError extends Data.TaggedError(
  'TelegramConnectorValidationError'
)<{
  readonly message: string
}> {}

const trimmed = (value: string) => value.trim()

const validateTelegramConnectorConfig = (input: TelegramConnectorConfig) =>
  Effect.gen(function* () {
    const botToken = trimmed(input.botToken)
    const chatId = trimmed(input.chatId)

    if (botToken.length === 0) {
      return yield* new TelegramConnectorValidationError({ message: 'Bot token required' })
    }

    if (chatId.length === 0) {
      return yield* new TelegramConnectorValidationError({ message: 'Chat id required' })
    }

    return { botToken, chatId }
  })

const selectTelegramConnector = (userId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [connector] = yield* db
      .select({
        id: schema.agentConnector.id,
        chatId: schema.agentConnector.chatId,
        credentialSecret: schema.agentConnector.credentialSecret
      })
      .from(schema.agentConnector)
      .where(
        and(
          eq(schema.agentConnector.userId, userId),
          eq(schema.agentConnector.connectorId, telegramConnectorProviderId),
          eq(schema.agentConnector.enabled, true)
        )
      )
      .limit(1)

    return connector
  })

export const getTelegramConnectorConfig = (userId: string) =>
  Effect.gen(function* () {
    const connector = yield* selectTelegramConnector(userId)

    if (connector === undefined || connector.credentialSecret.length === 0) {
      return undefined
    }

    return {
      botToken: connector.credentialSecret,
      chatId: connector.chatId
    }
  }).pipe(Effect.withSpan('agent.telegramConnector.getConfig'))

export const getTelegramConnectorStatus = (userId: string) =>
  Effect.gen(function* () {
    const config = yield* getTelegramConnectorConfig(userId)

    return config === undefined
      ? { _tag: 'Disconnected' as const }
      : { _tag: 'Connected' as const, chatId: config.chatId }
  }).pipe(Effect.withSpan('agent.telegramConnector.status'))

export const saveTelegramConnectorConfig = (
  input: TelegramConnectorConfig & { readonly userId: string }
) =>
  Effect.gen(function* () {
    const db = yield* Db
    const config = yield* validateTelegramConnectorConfig(input)
    const existing = yield* selectTelegramConnector(input.userId)

    if (existing === undefined) {
      yield* db.insert(schema.agentConnector).values({
        id: createId(),
        userId: input.userId,
        connectorId: telegramConnectorProviderId,
        chatId: config.chatId,
        credentialSecret: config.botToken
      })
      return
    }

    yield* db
      .update(schema.agentConnector)
      .set({
        chatId: config.chatId,
        credentialSecret: config.botToken,
        enabled: true,
        updatedAt: new Date()
      })
      .where(eq(schema.agentConnector.id, existing.id))
  }).pipe(Effect.withSpan('agent.telegramConnector.save'))

export const deleteTelegramConnectorConfig = (userId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    yield* db
      .delete(schema.agentConnector)
      .where(
        and(
          eq(schema.agentConnector.userId, userId),
          eq(schema.agentConnector.connectorId, telegramConnectorProviderId)
        )
      )
  }).pipe(Effect.withSpan('agent.telegramConnector.delete'))
